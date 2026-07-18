/**
 * Postgres work item storage, bound to the shared pool from the
 * `PostgresStore` injected into `MastraFactory`. `init()` owns the idempotent
 * DDL (formerly `FACTORY_MIGRATION_SQL` + `ensureFactoryDbReady()`).
 *
 * Updates run inside a transaction with the row read `FOR UPDATE` so
 * concurrent read-modify-writes of `stageHistory`/`sessions`/`metadata`
 * serialize instead of silently dropping each other's merges.
 */

import type pg from 'pg';

import type { FactoryStorageContext } from '../../domain';
import {
  WorkItemsStorage,
  applyStageTransition,
  computeWorkItemPatch,
  stampSessions,
  validateParentRelation,
} from './base';
import type {
  CommitFactoryTransitionInput,
  CommitFactoryTransitionResult,
  CreateWorkItemInput,
  FactoryDeferredDecisionRecord,
  FactoryPendingStartRecord,
  FactoryRunBindingRecord,
  PrepareFactoryRunStartInput,
  PrepareFactoryRunStartResult,
  UpdateWorkItemInput,
  UpsertWorkItemResult,
  WorkItemPriorState,
  WorkItemRow,
} from './base';

export const WORK_ITEMS_DDL = `
CREATE TABLE IF NOT EXISTS work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  created_by text NOT NULL,
  github_project_id uuid NOT NULL,
  source text NOT NULL,
  source_key text,
  parent_work_item_id uuid,
  title text NOT NULL,
  url text,
  stages jsonb NOT NULL,
  stage_history jsonb NOT NULL,
  sessions jsonb NOT NULL,
  metadata jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE work_items
  ADD COLUMN IF NOT EXISTS parent_work_item_id uuid,
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS factory_rule_ingress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  github_project_id uuid NOT NULL,
  identity text NOT NULL,
  trigger_type text NOT NULL,
  transition_id uuid NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, github_project_id, identity)
);

CREATE TABLE IF NOT EXISTS factory_rule_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingress_id uuid NOT NULL REFERENCES factory_rule_ingress(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  rule_set_version text NOT NULL,
  expected_revision integer NOT NULL,
  outcome text NOT NULL,
  code text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS factory_deferred_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  github_project_id uuid NOT NULL,
  evaluation_id uuid NOT NULL REFERENCES factory_rule_evaluations(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  decision jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE factory_deferred_decisions
  ADD COLUMN IF NOT EXISTS org_id text,
  ADD COLUMN IF NOT EXISTS github_project_id uuid;
UPDATE factory_deferred_decisions AS decision
SET org_id = ingress.org_id,
    github_project_id = ingress.github_project_id
FROM factory_rule_evaluations AS evaluation
JOIN factory_rule_ingress AS ingress ON ingress.id = evaluation.ingress_id
WHERE decision.evaluation_id = evaluation.id
  AND (decision.org_id IS NULL OR decision.github_project_id IS NULL);
ALTER TABLE factory_deferred_decisions
  ALTER COLUMN org_id SET NOT NULL,
  ALTER COLUMN github_project_id SET NOT NULL;
ALTER TABLE factory_deferred_decisions
  DROP CONSTRAINT IF EXISTS factory_deferred_decisions_idempotency_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS factory_deferred_decisions_tenant_key_unique
  ON factory_deferred_decisions (org_id, github_project_id, idempotency_key);

CREATE TABLE IF NOT EXISTS factory_run_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  github_project_id uuid NOT NULL,
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  role text NOT NULL,
  thread_id text NOT NULL,
  resource_id text NOT NULL,
  project_path text NOT NULL,
  branch text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS factory_run_bindings_active_role_unique
  ON factory_run_bindings (org_id, github_project_id, work_item_id, role)
  WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS factory_run_bindings_active_thread_unique
  ON factory_run_bindings (org_id, thread_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS factory_pending_starts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  github_project_id uuid NOT NULL,
  binding_id uuid NOT NULL REFERENCES factory_run_bindings(id) ON DELETE CASCADE,
  kickoff_key text NOT NULL,
  message text,
  status text NOT NULL DEFAULT 'pending',
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE factory_pending_starts
  ADD COLUMN IF NOT EXISTS org_id text,
  ADD COLUMN IF NOT EXISTS github_project_id uuid;
UPDATE factory_pending_starts AS pending
SET org_id = binding.org_id,
    github_project_id = binding.github_project_id
FROM factory_run_bindings AS binding
WHERE pending.binding_id = binding.id
  AND (pending.org_id IS NULL OR pending.github_project_id IS NULL);
ALTER TABLE factory_pending_starts
  ALTER COLUMN org_id SET NOT NULL,
  ALTER COLUMN github_project_id SET NOT NULL;
ALTER TABLE factory_pending_starts
  DROP CONSTRAINT IF EXISTS factory_pending_starts_kickoff_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS factory_pending_starts_tenant_kickoff_unique
  ON factory_pending_starts (org_id, github_project_id, kickoff_key);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'work_items_parent_work_item_id_fkey'
      AND conrelid = 'work_items'::regclass
  ) THEN
    BEGIN
      ALTER TABLE work_items
        ADD CONSTRAINT work_items_parent_work_item_id_fkey
        FOREIGN KEY (parent_work_item_id) REFERENCES work_items(id) ON DELETE SET NULL;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS work_items_org_project_source_key_unique
  ON work_items (org_id, github_project_id, source_key)
  WHERE source_key IS NOT NULL;
DROP INDEX IF EXISTS work_items_project_source_key_unique;

CREATE INDEX IF NOT EXISTS work_items_project_parent_idx
  ON work_items (org_id, github_project_id, parent_work_item_id);
`;

interface RuleIngressDbRow {
  id: string;
  result: Record<string, unknown>;
}

interface RunBindingDbRow {
  id: string;
  org_id: string;
  github_project_id: string;
  work_item_id: string;
  role: string;
  thread_id: string;
  resource_id: string;
  project_path: string;
  branch: string;
  status: 'active' | 'revoked';
  created_at: Date;
  revoked_at: Date | null;
}

interface DeferredDecisionDbRow {
  id: string;
  org_id: string;
  github_project_id: string;
  evaluation_id: string;
  work_item_id: string;
  idempotency_key: string;
  decision: Record<string, unknown>;
  status: 'pending';
  created_at: Date;
}

interface PendingStartDbRow {
  id: string;
  org_id: string;
  github_project_id: string;
  binding_id: string;
  kickoff_key: string;
  message: string | null;
  status: 'pending' | 'sent' | 'failed';
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

function toBinding(row: RunBindingDbRow): FactoryRunBindingRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    githubProjectId: row.github_project_id,
    workItemId: row.work_item_id,
    role: row.role,
    threadId: row.thread_id,
    resourceId: row.resource_id,
    projectPath: row.project_path,
    branch: row.branch,
    status: row.status,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

function toDeferredDecision(row: DeferredDecisionDbRow): FactoryDeferredDecisionRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    githubProjectId: row.github_project_id,
    evaluationId: row.evaluation_id,
    workItemId: row.work_item_id,
    idempotencyKey: row.idempotency_key,
    decision: row.decision,
    status: row.status,
    createdAt: row.created_at,
  };
}

function toPendingStart(row: PendingStartDbRow): FactoryPendingStartRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    githubProjectId: row.github_project_id,
    bindingId: row.binding_id,
    kickoffKey: row.kickoff_key,
    message: row.message,
    status: row.status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface WorkItemDbRow {
  id: string;
  org_id: string;
  created_by: string;
  github_project_id: string;
  source: WorkItemRow['source'];
  source_key: string | null;
  parent_work_item_id: string | null;
  title: string;
  url: string | null;
  stages: WorkItemRow['stages'];
  stage_history: WorkItemRow['stageHistory'];
  sessions: WorkItemRow['sessions'];
  metadata: WorkItemRow['metadata'];
  revision: number;
  created_at: Date;
  updated_at: Date;
}

function toRow(db: WorkItemDbRow): WorkItemRow {
  return {
    id: db.id,
    orgId: db.org_id,
    createdBy: db.created_by,
    githubProjectId: db.github_project_id,
    source: db.source,
    sourceKey: db.source_key,
    parentWorkItemId: db.parent_work_item_id,
    title: db.title,
    url: db.url,
    stages: db.stages,
    stageHistory: db.stage_history,
    sessions: db.sessions,
    metadata: db.metadata,
    revision: db.revision,
    createdAt: db.created_at,
    updatedAt: db.updated_at,
  };
}

/** Serializer per patchable column: jsonb columns are stringified + cast. */
const PATCH_COLUMNS: Record<string, { column: string; jsonb?: boolean }> = {
  updatedAt: { column: 'updated_at' },
  parentWorkItemId: { column: 'parent_work_item_id' },
  title: { column: 'title' },
  url: { column: 'url' },
  stages: { column: 'stages', jsonb: true },
  stageHistory: { column: 'stage_history', jsonb: true },
  sessions: { column: 'sessions', jsonb: true },
  metadata: { column: 'metadata', jsonb: true },
  revision: { column: 'revision' },
};

export class WorkItemsStoragePG extends WorkItemsStorage {
  #pool?: pg.Pool;

  async init(ctx: FactoryStorageContext): Promise<void> {
    await ctx.pool.query(WORK_ITEMS_DDL);
    this.#pool = ctx.pool;
  }

  get #db(): pg.Pool {
    if (!this.#pool) throw new Error('[WorkItemsStoragePG] Not initialized — init() has not succeeded.');
    return this.#pool;
  }

  async #withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async #lockProjectRelations(client: pg.PoolClient, orgId: string, githubProjectId: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${orgId}:${githubProjectId}`]);
  }

  async #projectItems(client: pg.PoolClient, orgId: string, githubProjectId: string): Promise<WorkItemRow[]> {
    const { rows } = await client.query<WorkItemDbRow>(
      'SELECT * FROM work_items WHERE org_id = $1 AND github_project_id = $2',
      [orgId, githubProjectId],
    );
    return rows.map(toRow);
  }

  async list(orgId: string, githubProjectId: string): Promise<WorkItemRow[]> {
    const { rows } = await this.#db.query<WorkItemDbRow>(
      'SELECT * FROM work_items WHERE org_id = $1 AND github_project_id = $2',
      [orgId, githubProjectId],
    );
    return rows.map(toRow).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async get(orgId: string, githubProjectId: string, id: string): Promise<WorkItemRow | null> {
    const { rows } = await this.#db.query<WorkItemDbRow>(
      'SELECT * FROM work_items WHERE id = $1 AND org_id = $2 AND github_project_id = $3',
      [id, orgId, githubProjectId],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  async getTransitionResultByIngress(
    orgId: string,
    githubProjectId: string,
    identity: string,
  ): Promise<Record<string, unknown> | null> {
    const { rows } = await this.#db.query<RuleIngressDbRow>(
      'SELECT id, result FROM factory_rule_ingress WHERE org_id = $1 AND github_project_id = $2 AND identity = $3',
      [orgId, githubProjectId, identity],
    );
    return rows[0]?.result ?? null;
  }

  async commitTransition(input: CommitFactoryTransitionInput): Promise<CommitFactoryTransitionResult> {
    return this.#withTx(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${input.orgId}:${input.githubProjectId}:${input.ingress.identity}`,
      ]);
      const prior = await client.query<RuleIngressDbRow>(
        'SELECT id, result FROM factory_rule_ingress WHERE org_id = $1 AND github_project_id = $2 AND identity = $3',
        [input.orgId, input.githubProjectId, input.ingress.identity],
      );
      if (prior.rows[0]) {
        const item = await client.query<WorkItemDbRow>(
          'SELECT * FROM work_items WHERE id = $1 AND org_id = $2 AND github_project_id = $3',
          [input.workItemId, input.orgId, input.githubProjectId],
        );
        return { status: 'replayed', item: item.rows[0] ? toRow(item.rows[0]) : null, result: prior.rows[0].result };
      }

      const locked = await client.query<WorkItemDbRow>(
        'SELECT * FROM work_items WHERE id = $1 AND org_id = $2 AND github_project_id = $3 FOR UPDATE',
        [input.workItemId, input.orgId, input.githubProjectId],
      );
      if (!locked.rows[0]) {
        const now = new Date();
        const code = input.evaluation.outcome === 'rejected' ? input.evaluation.code : 'invalid_transition';
        const reason = input.evaluation.outcome === 'rejected' ? input.evaluation.reason : 'Work item not found.';
        const result = {
          status: 'rejected',
          transitionId: input.ingress.transitionId,
          itemId: input.workItemId,
          code,
          reason,
        };
        await client.query(
          `INSERT INTO factory_rule_ingress
             (org_id, github_project_id, identity, trigger_type, transition_id, result, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [
            input.orgId,
            input.githubProjectId,
            input.ingress.identity,
            input.ingress.triggerType,
            input.ingress.transitionId,
            JSON.stringify(result),
            now,
          ],
        );
        return { status: 'committed', item: null, result };
      }
      const existing = toRow(locked.rows[0]);
      const now = new Date();
      let item = existing;
      let outcome: 'accepted' | 'rejected';
      let code: string | null = null;
      let reason: string | null = null;
      let result: Record<string, unknown>;

      if (existing.revision !== input.expectedRevision) {
        outcome = 'rejected';
        code = 'stale';
        reason = 'The work item changed before this transition committed.';
        result = { status: 'rejected', transitionId: input.ingress.transitionId, itemId: existing.id, code, reason };
      } else if (input.evaluation.outcome === 'rejected') {
        outcome = 'rejected';
        code = input.evaluation.code;
        reason = input.evaluation.reason;
        result = { status: 'rejected', transitionId: input.ingress.transitionId, itemId: existing.id, code, reason };
      } else {
        outcome = 'accepted';
        if (existing.stages.length === 1 && existing.stages[0] === input.destinationStage) {
          result = {
            status: 'accepted',
            transitionId: input.ingress.transitionId,
            itemId: existing.id,
            revision: existing.revision,
            stage: input.destinationStage,
            decisions: input.evaluation.decisions,
          };
        } else {
          const stages = [input.destinationStage];
          const history = applyStageTransition(existing.stageHistory, existing.stages, stages, input.actorId, now);
          const updated = await client.query<WorkItemDbRow>(
            `UPDATE work_items
             SET stages = $1::jsonb, stage_history = $2::jsonb, revision = revision + 1, updated_at = $3
             WHERE id = $4 AND revision = $5
             RETURNING *`,
            [JSON.stringify(stages), JSON.stringify(history), now, existing.id, input.expectedRevision],
          );
          if (!updated.rows[0]) {
            outcome = 'rejected';
            code = 'stale';
            reason = 'The work item changed before this transition committed.';
            result = {
              status: 'rejected',
              transitionId: input.ingress.transitionId,
              itemId: existing.id,
              code,
              reason,
            };
          } else {
            item = toRow(updated.rows[0]);
            result = {
              status: 'accepted',
              transitionId: input.ingress.transitionId,
              itemId: item.id,
              revision: item.revision,
              stage: input.destinationStage,
              decisions: input.evaluation.decisions,
            };
          }
        }
      }

      const ingress = await client.query<{ id: string }>(
        `INSERT INTO factory_rule_ingress
           (org_id, github_project_id, identity, trigger_type, transition_id, result, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING id`,
        [
          input.orgId,
          input.githubProjectId,
          input.ingress.identity,
          input.ingress.triggerType,
          input.ingress.transitionId,
          JSON.stringify(result),
          now,
        ],
      );
      const evaluation = await client.query<{ id: string }>(
        `INSERT INTO factory_rule_evaluations
           (ingress_id, work_item_id, rule_set_version, expected_revision, outcome, code, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [ingress.rows[0]!.id, existing.id, input.ruleSetVersion, input.expectedRevision, outcome, code, reason, now],
      );
      if (outcome === 'accepted' && input.evaluation.outcome === 'accepted') {
        for (const decision of input.evaluation.decisions) {
          await client.query(
            `INSERT INTO factory_deferred_decisions
               (org_id, github_project_id, evaluation_id, work_item_id, idempotency_key, decision, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending', $7)`,
            [
              input.orgId,
              input.githubProjectId,
              evaluation.rows[0]!.id,
              existing.id,
              String(decision.idempotencyKey),
              JSON.stringify(decision),
              now,
            ],
          );
        }
      }
      return { status: 'committed', item, result };
    });
  }

  async listDeferredDecisions(orgId: string, githubProjectId: string): Promise<FactoryDeferredDecisionRecord[]> {
    const { rows } = await this.#db.query<DeferredDecisionDbRow>(
      `SELECT * FROM factory_deferred_decisions
       WHERE org_id = $1 AND github_project_id = $2
       ORDER BY created_at ASC`,
      [orgId, githubProjectId],
    );
    return rows.map(toDeferredDecision);
  }

  async listRunBindings(
    orgId: string,
    githubProjectId: string,
    workItemId?: string,
  ): Promise<FactoryRunBindingRecord[]> {
    const params = workItemId === undefined ? [orgId, githubProjectId] : [orgId, githubProjectId, workItemId];
    const workItemClause = workItemId === undefined ? '' : ' AND work_item_id = $3';
    const { rows } = await this.#db.query<RunBindingDbRow>(
      `SELECT * FROM factory_run_bindings
       WHERE org_id = $1 AND github_project_id = $2${workItemClause}
       ORDER BY created_at ASC`,
      params,
    );
    return rows.map(toBinding);
  }

  async listPendingStarts(orgId: string, githubProjectId: string): Promise<FactoryPendingStartRecord[]> {
    const { rows } = await this.#db.query<PendingStartDbRow>(
      `SELECT * FROM factory_pending_starts
       WHERE org_id = $1 AND github_project_id = $2
       ORDER BY created_at ASC`,
      [orgId, githubProjectId],
    );
    return rows.map(toPendingStart);
  }

  async prepareRunStart(input: PrepareFactoryRunStartInput): Promise<PrepareFactoryRunStartResult> {
    return this.#withTx(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${input.orgId}:${input.githubProjectId}:start:${input.kickoffKey}`,
      ]);
      const prior = await client.query<PendingStartDbRow>(
        'SELECT * FROM factory_pending_starts WHERE org_id = $1 AND github_project_id = $2 AND kickoff_key = $3',
        [input.orgId, input.githubProjectId, input.kickoffKey],
      );
      if (prior.rows[0]) {
        const bindingRows = await client.query<RunBindingDbRow>(
          'SELECT * FROM factory_run_bindings WHERE id = $1 AND org_id = $2 AND github_project_id = $3',
          [prior.rows[0].binding_id, input.orgId, input.githubProjectId],
        );
        const itemRows = await client.query<WorkItemDbRow>(
          'SELECT * FROM work_items WHERE id = $1 AND org_id = $2 AND github_project_id = $3',
          [bindingRows.rows[0]!.work_item_id, input.orgId, input.githubProjectId],
        );
        return {
          item: toRow(itemRows.rows[0]!),
          binding: toBinding(bindingRows.rows[0]!),
          pendingStart: toPendingStart(prior.rows[0]),
          replayed: true,
        };
      }

      const now = new Date();
      const create = input.workItem.input;
      let existingRows;
      if (input.workItem.id) {
        existingRows = await client.query<WorkItemDbRow>(
          'SELECT * FROM work_items WHERE id = $1 AND org_id = $2 AND github_project_id = $3 FOR UPDATE',
          [input.workItem.id, input.orgId, input.githubProjectId],
        );
      } else if (create.sourceKey) {
        existingRows = await client.query<WorkItemDbRow>(
          'SELECT * FROM work_items WHERE org_id = $1 AND github_project_id = $2 AND source_key = $3 FOR UPDATE',
          [input.orgId, input.githubProjectId, create.sourceKey],
        );
      }

      let item: WorkItemRow;
      if (existingRows?.rows[0]) {
        const existing = toRow(existingRows.rows[0]);
        const { changes } = computeWorkItemPatch(
          existing,
          { sessions: { [input.role]: input.session } },
          input.userId,
          now,
        );
        const updated = await client.query<WorkItemDbRow>(
          `UPDATE work_items SET sessions = $1::jsonb, revision = $2, updated_at = $3 WHERE id = $4 RETURNING *`,
          [JSON.stringify(changes.sessions), changes.revision, changes.updatedAt, existing.id],
        );
        item = toRow(updated.rows[0]!);
      } else {
        if (create.parentWorkItemId) {
          await this.#lockProjectRelations(client, input.orgId, input.githubProjectId);
          validateParentRelation(
            await this.#projectItems(client, input.orgId, input.githubProjectId),
            undefined,
            create.parentWorkItemId,
          );
        }
        const inserted = await client.query<WorkItemDbRow>(
          `INSERT INTO work_items
             (org_id, created_by, github_project_id, source, source_key, parent_work_item_id, title, url,
              stages, stage_history, sessions, metadata, revision, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, 1, $13, $14)
           RETURNING *`,
          [
            input.orgId,
            input.userId,
            input.githubProjectId,
            create.source,
            create.sourceKey,
            create.parentWorkItemId ?? null,
            create.title,
            create.url,
            JSON.stringify(create.stages),
            JSON.stringify(applyStageTransition([], [], create.stages, input.userId, now)),
            JSON.stringify(stampSessions({ [input.role]: input.session }, input.userId)),
            JSON.stringify(create.metadata),
            now,
            now,
          ],
        );
        item = toRow(inserted.rows[0]!);
      }

      await client.query(
        `UPDATE factory_run_bindings
         SET status = 'revoked', revoked_at = $1
         WHERE org_id = $2 AND github_project_id = $3 AND work_item_id = $4 AND role = $5 AND status = 'active'`,
        [now, input.orgId, input.githubProjectId, item.id, input.role],
      );
      const bindingRows = await client.query<RunBindingDbRow>(
        `INSERT INTO factory_run_bindings
           (org_id, github_project_id, work_item_id, role, thread_id, resource_id, project_path, branch, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)
         RETURNING *`,
        [
          input.orgId,
          input.githubProjectId,
          item.id,
          input.role,
          input.session.threadId,
          input.resourceId,
          input.session.projectPath,
          input.session.branch,
          now,
        ],
      );
      const pendingRows = await client.query<PendingStartDbRow>(
        `INSERT INTO factory_pending_starts
           (org_id, github_project_id, binding_id, kickoff_key, message, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
         RETURNING *`,
        [input.orgId, input.githubProjectId, bindingRows.rows[0]!.id, input.kickoffKey, input.kickoffMessage, now, now],
      );
      return {
        item,
        binding: toBinding(bindingRows.rows[0]!),
        pendingStart: toPendingStart(pendingRows.rows[0]!),
        replayed: false,
      };
    });
  }

  async markPendingStart(
    bindingId: string,
    status: 'sent' | 'failed',
    lastError?: string,
  ): Promise<FactoryPendingStartRecord | null> {
    const { rows } = await this.#db.query<PendingStartDbRow>(
      `UPDATE factory_pending_starts
       SET status = $1, last_error = $2, updated_at = now()
       WHERE binding_id = $3
       RETURNING *`,
      [status, lastError ?? null, bindingId],
    );
    return rows[0] ? toPendingStart(rows[0]) : null;
  }

  async upsert(params: {
    orgId: string;
    userId: string;
    githubProjectId: string;
    input: CreateWorkItemInput;
    reuseMode?: 'update' | 'preserve' | 'non-stage';
  }): Promise<UpsertWorkItemResult> {
    const { orgId, userId, githubProjectId, input, reuseMode = 'update' } = params;
    const now = new Date();

    const reuseExisting = async (): Promise<UpsertWorkItemResult | null> => {
      if (input.sourceKey === null) return null;
      if (reuseMode === 'preserve') {
        const { rows } = await this.#db.query<WorkItemDbRow>(
          'SELECT * FROM work_items WHERE org_id = $1 AND github_project_id = $2 AND source_key = $3',
          [orgId, githubProjectId, input.sourceKey],
        );
        if (!rows[0]) return null;
        const item = toRow(rows[0]);
        return {
          created: false,
          item,
          previous: { stages: [...item.stages], sessionRoles: Object.keys(item.sessions) },
        };
      }
      const patch: UpdateWorkItemInput =
        reuseMode === 'non-stage'
          ? {
              title: input.title,
              url: input.url,
              parentWorkItemId: input.parentWorkItemId ?? undefined,
              metadata: input.metadata,
            }
          : input.parentWorkItemId === null
            ? { ...input, parentWorkItemId: undefined }
            : input;
      const updated = await this.#withTx(client =>
        this.#applyUpdateLocked(
          client,
          'org_id = $1 AND github_project_id = $2 AND source_key = $3',
          [orgId, githubProjectId, input.sourceKey],
          patch,
          userId,
          now,
        ),
      );
      return updated ? { created: false, item: updated.item, previous: updated.previous } : null;
    };

    const reused = await reuseExisting();
    if (reused) return reused;

    const insert = async (db: pg.Pool | pg.PoolClient): Promise<UpsertWorkItemResult> => {
      const { rows } = await db.query<WorkItemDbRow>(
        `INSERT INTO work_items
           (org_id, created_by, github_project_id, source, source_key, parent_work_item_id, title, url,
            stages, stage_history, sessions, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14)
         RETURNING *`,
        [
          orgId,
          userId,
          githubProjectId,
          input.source,
          input.sourceKey,
          input.parentWorkItemId ?? null,
          input.title,
          input.url,
          JSON.stringify(input.stages),
          JSON.stringify(applyStageTransition([], [], input.stages, userId, now)),
          JSON.stringify(stampSessions(input.sessions, userId)),
          JSON.stringify(input.metadata),
          now,
          now,
        ],
      );
      return { created: true, item: toRow(rows[0]!) };
    };

    try {
      if (input.parentWorkItemId == null) return await insert(this.#db);
      return await this.#withTx(async client => {
        await this.#lockProjectRelations(client, orgId, githubProjectId);
        validateParentRelation(
          await this.#projectItems(client, orgId, githubProjectId),
          undefined,
          input.parentWorkItemId!,
        );
        return insert(client);
      });
    } catch (err) {
      // Concurrent create for the same sourceKey: the partial unique index won
      // the race — fall back to updating the row it protected.
      const fallback = await reuseExisting();
      if (fallback) return fallback;
      throw err;
    }
  }

  /**
   * Shared update path for upsert-reuse and PATCH. Must run inside a
   * transaction — the row is read with `FOR UPDATE`. Returns `null` when no
   * row matches `whereSql`.
   */
  async #applyUpdateLocked(
    client: pg.PoolClient,
    whereSql: string,
    whereParams: unknown[],
    patch: UpdateWorkItemInput,
    userId: string,
    now: Date,
  ): Promise<{ item: WorkItemRow; previous: WorkItemPriorState } | null> {
    let dbRow: WorkItemDbRow | undefined;
    if (patch.parentWorkItemId === undefined) {
      const { rows } = await client.query<WorkItemDbRow>(
        `SELECT * FROM work_items WHERE ${whereSql} FOR UPDATE`,
        whereParams,
      );
      dbRow = rows[0];
    } else {
      const candidate = await client.query<WorkItemDbRow>(`SELECT * FROM work_items WHERE ${whereSql}`, whereParams);
      if (!candidate.rows[0]) return null;
      await this.#lockProjectRelations(client, candidate.rows[0].org_id, candidate.rows[0].github_project_id);
      const locked = await client.query<WorkItemDbRow>('SELECT * FROM work_items WHERE id = $1 FOR UPDATE', [
        candidate.rows[0].id,
      ]);
      dbRow = locked.rows[0];
    }
    if (!dbRow) return null;
    const existing = toRow(dbRow);
    if (patch.parentWorkItemId !== undefined) {
      validateParentRelation(
        await this.#projectItems(client, existing.orgId, existing.githubProjectId),
        existing.id,
        patch.parentWorkItemId,
      );
    }
    const { changes, previous } = computeWorkItemPatch(existing, patch, userId, now);

    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [field, value] of Object.entries(changes)) {
      const spec = PATCH_COLUMNS[field]!;
      params.push(spec.jsonb ? JSON.stringify(value) : value);
      sets.push(`${spec.column} = $${params.length}${spec.jsonb ? '::jsonb' : ''}`);
    }
    params.push(existing.id);
    const { rows: updatedRows } = await client.query<WorkItemDbRow>(
      `UPDATE work_items SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    return { item: updatedRows[0] ? toRow(updatedRows[0]) : { ...existing, ...changes }, previous };
  }

  async update(
    orgId: string,
    id: string,
    userId: string,
    patch: UpdateWorkItemInput,
  ): Promise<{ item: WorkItemRow; previous: WorkItemPriorState } | null> {
    return this.#withTx(client =>
      this.#applyUpdateLocked(client, 'id = $1 AND org_id = $2', [id, orgId], patch, userId, new Date()),
    );
  }

  async delete(orgId: string, id: string): Promise<WorkItemRow | null> {
    return this.#withTx(async client => {
      const candidate = await client.query<WorkItemDbRow>('SELECT * FROM work_items WHERE id = $1 AND org_id = $2', [
        id,
        orgId,
      ]);
      if (!candidate.rows[0]) return null;

      await this.#lockProjectRelations(client, candidate.rows[0].org_id, candidate.rows[0].github_project_id);
      const locked = await client.query<WorkItemDbRow>(
        'SELECT * FROM work_items WHERE id = $1 AND org_id = $2 FOR UPDATE',
        [id, orgId],
      );
      if (!locked.rows[0]) return null;

      const { rows } = await client.query<WorkItemDbRow>(
        'DELETE FROM work_items WHERE id = $1 AND org_id = $2 RETURNING *',
        [id, orgId],
      );
      return rows[0] ? toRow(rows[0]) : null;
    });
  }
}
