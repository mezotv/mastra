import { describe, expect, it, vi } from 'vitest';

import type { FactoryStorageContext } from '../../domain';
import { WORK_ITEMS_DDL, WorkItemsStoragePG } from './pg';

interface RecordedQuery {
  text: string;
  values?: unknown[];
}

type Responder = (text: string, values?: unknown[]) => { rows: any[] } | undefined;

function fakePool(respond: Responder = () => undefined) {
  const queries: RecordedQuery[] = [];
  const run = async (text: string, values?: unknown[]) => {
    queries.push({ text, values });
    return respond(text, values) ?? { rows: [] };
  };
  const pool = {
    query: run,
    connect: async () => ({ query: run, release: () => {} }),
  };
  return { pool, queries, ctx: { pool } as unknown as FactoryStorageContext };
}

const sqlOf = (query: RecordedQuery) => query.text.replace(/\s+/g, ' ').trim();

describe('WorkItemsStoragePG', () => {
  const dbRow = {
    id: 'wi-1',
    org_id: 'org1',
    created_by: 'u1',
    github_project_id: 'p1',
    source: 'github-issue',
    source_key: 'github-issue:42',
    title: 'Fix login',
    url: null,
    stages: ['intake'],
    stage_history: [{ stage: 'intake', enteredAt: '2026-07-01T10:00:00.000Z', by: 'u1' }],
    sessions: {},
    metadata: {},
    revision: 1,
    created_at: new Date('2026-07-01T10:00:00Z'),
    updated_at: new Date('2026-07-01T10:00:00Z'),
  };

  const createInput = {
    source: 'github-issue' as const,
    sourceKey: 'github-issue:42',
    title: 'Fix login',
    url: null,
    stages: ['intake'],
    sessions: {},
    metadata: {},
  };

  it('runs its DDL on init and inserts fresh items with server-stamped history', async () => {
    const { queries, ctx } = fakePool(text => {
      if (text.includes('FOR UPDATE')) return { rows: [] };
      if (text.includes('INSERT INTO work_items')) return { rows: [dbRow] };
      return undefined;
    });
    const domain = new WorkItemsStoragePG();
    await domain.init(ctx);
    expect(queries[0]!.text).toBe(WORK_ITEMS_DDL);
    expect(WORK_ITEMS_DDL).toContain('ON work_items (org_id, github_project_id, source_key)');
    expect(WORK_ITEMS_DDL).toContain('DROP INDEX IF EXISTS work_items_project_source_key_unique');

    const result = await domain.upsert({ orgId: 'org1', userId: 'u1', githubProjectId: 'p1', input: createInput });
    expect(result.created).toBe(true);
    expect(result.item.sourceKey).toBe('github-issue:42');

    const insert = queries.find(q => q.text.includes('INSERT INTO work_items'))!;
    const history = JSON.parse(insert.values![9] as string);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ stage: 'intake', by: 'u1' });
  });

  it('updates inside a transaction with the row locked FOR UPDATE', async () => {
    const updatedRow = { ...dbRow, stages: ['execute'], updated_at: new Date('2026-07-02T10:00:00Z') };
    const { queries, ctx } = fakePool(text => {
      if (text.includes('FOR UPDATE')) return { rows: [dbRow] };
      if (text.startsWith('UPDATE work_items')) return { rows: [updatedRow] };
      return undefined;
    });
    const domain = new WorkItemsStoragePG();
    await domain.init(ctx);

    const result = await domain.update('org1', 'wi-1', 'u2', { stages: ['execute'] });
    expect(result).not.toBeNull();
    expect(result!.item.stages).toEqual(['execute']);
    expect(result!.previous).toEqual({ stages: ['intake'], sessionRoles: [] });

    const texts = queries.slice(1).map(sqlOf);
    expect(texts[0]).toBe('BEGIN');
    expect(texts[1]).toContain('FOR UPDATE');
    expect(texts[2]).toMatch(/^UPDATE work_items SET/);
    expect(texts[3]).toBe('COMMIT');

    // The stage move was diffed into history by the acting user.
    const update = queries.find(q => q.text.startsWith('UPDATE work_items'))!;
    const historyParam = update.values!.find(
      v => typeof v === 'string' && (v as string).includes('"stage":"execute"'),
    ) as string;
    const history = JSON.parse(historyParam);
    expect(history).toEqual([
      expect.objectContaining({ stage: 'intake', exitedAt: expect.any(String) }),
      expect.objectContaining({ stage: 'execute', by: 'u2' }),
    ]);
  });

  it('rolls back and rethrows when the locked update fails', async () => {
    const { queries, ctx } = fakePool(text => {
      if (text.includes('FOR UPDATE')) throw new Error('boom');
      return undefined;
    });
    const domain = new WorkItemsStoragePG();
    await domain.init(ctx);
    await expect(domain.update('org1', 'wi-1', 'u1', { title: 'x' })).rejects.toThrow('boom');
    expect(queries.map(sqlOf)).toContain('ROLLBACK');
  });

  it('falls back to the existing row when a concurrent insert wins the unique-index race', async () => {
    let selects = 0;
    const { queries, ctx } = fakePool(text => {
      if (text.includes('FOR UPDATE')) {
        // First reuse probe misses; the post-conflict probe finds the winner.
        selects += 1;
        return { rows: selects === 1 ? [] : [dbRow] };
      }
      if (text.includes('INSERT INTO work_items')) throw new Error('duplicate key value violates unique constraint');
      if (text.startsWith('UPDATE work_items')) return { rows: [dbRow] };
      return undefined;
    });
    const domain = new WorkItemsStoragePG();
    await domain.init(ctx);

    const result = await domain.upsert({ orgId: 'org1', userId: 'u1', githubProjectId: 'p1', input: createInput });
    expect(result.created).toBe(false);
    const lockQueries = queries.filter(query => query.text.includes('FOR UPDATE'));
    expect(lockQueries).toHaveLength(2);
    expect(lockQueries[0]!.values).toEqual(['org1', 'p1', 'github-issue:42']);
  });

  it('deletes transactionally after taking the project relation lock', async () => {
    const { queries, ctx } = fakePool(text => {
      if (text === 'SELECT * FROM work_items WHERE id = $1 AND org_id = $2') return { rows: [dbRow] };
      if (text.endsWith('FOR UPDATE')) return { rows: [dbRow] };
      if (text.startsWith('DELETE')) return { rows: [] };
      return undefined;
    });
    const domain = new WorkItemsStoragePG();
    await domain.init(ctx);

    expect(await domain.delete('org1', 'wi-9')).toBeNull();
    const texts = queries.slice(1).map(sqlOf);
    expect(texts[0]).toBe('BEGIN');
    expect(texts[1]).toBe('SELECT * FROM work_items WHERE id = $1 AND org_id = $2');
    expect(texts[2]).toContain('pg_advisory_xact_lock');
    expect(texts[3]).toContain('FOR UPDATE');
    expect(texts[4]).toContain('DELETE FROM work_items');
    expect(texts[5]).toBe('COMMIT');
    expect(queries.find(query => query.text.startsWith('DELETE'))!.values).toEqual(['wi-9', 'org1']);
  });

  it('declares tenant-scoped ingress, deferred decisions, bindings, and pending starts', () => {
    expect(WORK_ITEMS_DDL).toContain('UNIQUE (org_id, github_project_id, identity)');
    expect(WORK_ITEMS_DDL).toContain('factory_deferred_decisions_tenant_key_unique');
    expect(WORK_ITEMS_DDL).toContain('factory_deferred_decisions_effect_unique');
    expect(WORK_ITEMS_DDL).toContain('effect_ordinal integer NOT NULL');
    expect(WORK_ITEMS_DDL).toContain('effect_hash text NOT NULL');
    expect(WORK_ITEMS_DDL).toContain('lease_expires_at timestamptz');
    expect(WORK_ITEMS_DDL).toContain('factory_run_bindings_active_role_unique');
    expect(WORK_ITEMS_DDL).toContain('factory_run_bindings_active_thread_unique');
    expect(WORK_ITEMS_DDL).toContain('factory_pending_starts_tenant_kickoff_unique');
  });

  it('claims available and expired deferred decisions with a fenced SKIP LOCKED lease', async () => {
    const now = new Date('2026-07-02T00:00:00Z');
    const leaseExpiresAt = new Date(now.getTime() + 30_000);
    const decisionRow = {
      id: 'decision-1',
      org_id: 'org1',
      github_project_id: 'p1',
      evaluation_id: 'evaluation-1',
      work_item_id: 'wi-1',
      idempotency_key: 'notify-1',
      effect_ordinal: 0,
      effect_hash: 'hash-1',
      causal_chain: [],
      decision: { type: 'notify', idempotencyKey: 'notify-1', title: 'Moved' },
      status: 'leased',
      attempts: 1,
      available_at: now,
      lease_owner: 'worker-1',
      lease_expires_at: leaseExpiresAt,
      last_error: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
    };
    const { queries, ctx } = fakePool(text => {
      if (text.includes('WITH candidates AS') && text.includes('factory_deferred_decisions')) {
        return { rows: [decisionRow] };
      }
      return undefined;
    });
    const domain = new WorkItemsStoragePG();
    await domain.init(ctx);

    const claimed = await domain.claimDeferredDecisions({ ownerId: 'worker-1', now, leaseExpiresAt, limit: 10 });

    expect(claimed[0]).toMatchObject({
      id: 'decision-1',
      effectOrdinal: 0,
      effectHash: 'hash-1',
      leaseOwner: 'worker-1',
    });
    const claim = queries.find(query => query.text.includes('WITH candidates AS'))!;
    expect(sqlOf(claim)).toContain('FOR UPDATE SKIP LOCKED');
    expect(sqlOf(claim)).toContain("status IN ('pending', 'retry')");
    expect(sqlOf(claim)).toContain("status = 'leased' AND lease_expires_at <= $1");
    expect(claim.values).toEqual([now, 10, 'worker-1', leaseExpiresAt]);
  });

  it('commits CAS movement, ingress, evaluation, and deferred decisions in one transaction', async () => {
    const movedRow = {
      ...dbRow,
      stages: ['execute'],
      revision: 2,
      stage_history: [
        { ...dbRow.stage_history[0], exitedAt: '2026-07-02T00:00:00.000Z' },
        { stage: 'execute', enteredAt: '2026-07-02T00:00:00.000Z', by: 'u1' },
      ],
    };
    const { queries, ctx } = fakePool(text => {
      if (text.includes('FROM factory_rule_ingress')) return { rows: [] };
      if (text.includes('FROM work_items') && text.includes('FOR UPDATE')) return { rows: [dbRow] };
      if (text.includes('UPDATE work_items') && text.includes('revision = revision + 1')) return { rows: [movedRow] };
      if (text.includes('INSERT INTO factory_rule_ingress')) return { rows: [{ id: 'ingress-1' }] };
      if (text.includes('INSERT INTO factory_rule_evaluations')) return { rows: [{ id: 'evaluation-1' }] };
      return undefined;
    });
    const domain = new WorkItemsStoragePG();
    await domain.init(ctx);

    const result = await domain.commitTransition({
      orgId: 'org1',
      githubProjectId: 'p1',
      workItemId: 'wi-1',
      expectedRevision: 1,
      destinationStage: 'execute',
      actorId: 'u1',
      ingress: { identity: 'request-1', triggerType: 'human', transitionId: '00000000-0000-4000-8000-000000000099' },
      ruleSetVersion: 'rules-v1',
      causalChain: [],
      evaluation: {
        outcome: 'accepted',
        decisions: [{ type: 'notify', idempotencyKey: 'notify-1', title: 'Moved' }],
      },
    });

    expect(result.status).toBe('committed');
    if (result.status !== 'committed') throw new Error('transition did not commit');
    expect(result.result).toMatchObject({ status: 'accepted', revision: 2, stage: 'execute' });
    const sql = queries.map(sqlOf);
    expect(sql).toContain('BEGIN');
    expect(sql).toContain('COMMIT');
    expect(sql.some(text => text.includes('INSERT INTO factory_rule_ingress'))).toBe(true);
    expect(sql.some(text => text.includes('INSERT INTO factory_rule_evaluations'))).toBe(true);
    const deferred = queries.find(query => query.text.includes('INSERT INTO factory_deferred_decisions'));
    expect(deferred?.values?.slice(0, 2)).toEqual(['org1', 'p1']);
    expect(deferred?.values?.[5]).toBe(0);
    expect(deferred?.values?.[6]).toMatch(/^[a-f0-9]{64}$/);
    expect(deferred?.values?.[7]).toBe('[]');
  });

  it('rolls back the authoritative transition when deferred decision persistence fails', async () => {
    const movedRow = { ...dbRow, stages: ['execute'], revision: 2 };
    const { queries, ctx } = fakePool(text => {
      if (text.includes('FROM factory_rule_ingress')) return { rows: [] };
      if (text.includes('FROM work_items') && text.includes('FOR UPDATE')) return { rows: [dbRow] };
      if (text.includes('UPDATE work_items') && text.includes('revision = revision + 1')) return { rows: [movedRow] };
      if (text.includes('INSERT INTO factory_rule_ingress')) return { rows: [{ id: 'ingress-1' }] };
      if (text.includes('INSERT INTO factory_rule_evaluations')) return { rows: [{ id: 'evaluation-1' }] };
      if (text.includes('INSERT INTO factory_deferred_decisions')) throw new Error('outbox unavailable');
      return undefined;
    });
    const domain = new WorkItemsStoragePG();
    await domain.init(ctx);

    await expect(
      domain.commitTransition({
        orgId: 'org1',
        githubProjectId: 'p1',
        workItemId: 'wi-1',
        expectedRevision: 1,
        destinationStage: 'execute',
        actorId: 'u1',
        ingress: { identity: 'request-rollback', triggerType: 'human', transitionId: 'transition-rollback' },
        ruleSetVersion: 'rules-v1',
        causalChain: [],
        evaluation: {
          outcome: 'accepted',
          decisions: [{ type: 'notify', idempotencyKey: 'notify-rollback', title: 'Moved' }],
        },
      }),
    ).rejects.toThrow('outbox unavailable');
    expect(queries.map(sqlOf)).toContain('ROLLBACK');
    expect(queries.map(sqlOf)).not.toContain('COMMIT');
  });

  it('looks up and revokes bindings through the complete tenant-scoped authority tuple', async () => {
    const now = new Date('2026-07-18T10:00:00Z');
    const bindingRow = {
      id: 'binding-1',
      org_id: 'org1',
      github_project_id: 'p1',
      work_item_id: 'wi-1',
      role: 'work',
      thread_id: 'thread-1',
      resource_id: 'resource-1',
      project_path: '/worktree',
      branch: 'feature',
      status: 'active',
      created_at: now,
      revoked_at: null,
    };
    const { queries, ctx } = fakePool(text => {
      if (text.includes('WITH matches AS') && text.includes('COUNT(DISTINCT org_id)')) {
        return { rows: [{ ...bindingRow, org_count: '1' }] };
      }
      if (text.includes('SELECT * FROM factory_run_bindings') && text.includes('resource_id')) {
        return { rows: [bindingRow] };
      }
      if (text.includes('UPDATE factory_run_bindings') && text.includes("status = 'revoked'")) {
        return { rows: [{ ...bindingRow, status: 'revoked', revoked_at: now }] };
      }
      return undefined;
    });
    const domain = new WorkItemsStoragePG();
    await domain.init(ctx);

    await expect(
      domain.findActiveRunBinding({
        orgId: 'org1',
        githubProjectId: 'p1',
        threadId: 'thread-1',
        resourceId: 'resource-1',
        projectPath: '/worktree',
      }),
    ).resolves.toMatchObject({ id: 'binding-1', status: 'active' });
    await expect(
      domain.findRunBindingBySession({
        githubProjectId: 'p1',
        threadId: 'thread-1',
        resourceId: 'resource-1',
        projectPath: '/worktree',
      }),
    ).resolves.toMatchObject({ id: 'binding-1', status: 'active' });
    await expect(
      domain.revokeRunBinding({ orgId: 'org1', githubProjectId: 'p1', bindingId: 'binding-1', revokedAt: now }),
    ).resolves.toMatchObject({ id: 'binding-1', status: 'revoked', revokedAt: now });

    const lookups = queries.filter(query => query.text.includes('SELECT * FROM factory_run_bindings'));
    expect(lookups[0]?.values).toEqual(['org1', 'p1', 'thread-1', 'resource-1', '/worktree']);
    expect(lookups[1]?.values).toEqual(['p1', 'thread-1', 'resource-1', '/worktree']);
    expect(lookups[1]?.text).toContain('created_at DESC');
    expect(lookups[1]?.text).not.toContain('updated_at');
    const revoke = queries.find(query => query.text.includes('UPDATE factory_run_bindings'))!;
    expect(revoke.values).toEqual(['binding-1', 'org1', 'p1', now]);
  });

  it('rejects exact-session lookup when any matching binding belongs to another organization', async () => {
    const now = new Date('2026-07-18T10:00:00Z');
    const { queries, ctx } = fakePool(text => {
      if (!text.includes('WITH matches AS')) return undefined;
      return {
        rows: [
          {
            id: 'binding-newest',
            org_id: 'org-a',
            github_project_id: 'p1',
            work_item_id: 'wi-1',
            role: 'work',
            thread_id: 'thread-1',
            resource_id: 'resource-1',
            project_path: '/worktree',
            branch: 'feature',
            status: 'active',
            created_at: now,
            revoked_at: null,
            org_count: '2',
          },
        ],
      };
    });
    const domain = new WorkItemsStoragePG();
    await domain.init(ctx);

    await expect(
      domain.findRunBindingBySession({
        githubProjectId: 'p1',
        threadId: 'thread-1',
        resourceId: 'resource-1',
        projectPath: '/worktree',
      }),
    ).resolves.toBeNull();

    const lookup = queries.find(query => query.text.includes('WITH matches AS'))!;
    expect(lookup.text).toContain('COUNT(DISTINCT org_id)');
    expect(lookup.text).toContain('LIMIT 1');
  });

  it('prepares session, exact binding, and pending kickoff atomically before returning', async () => {
    const sessionRow = {
      ...dbRow,
      revision: 2,
      sessions: {
        work: { projectPath: '/worktree', branch: 'feature', threadId: 'thread-1', startedBy: 'u1' },
      },
    };
    const bindingRow = {
      id: 'binding-1',
      org_id: 'org1',
      github_project_id: 'p1',
      work_item_id: 'wi-1',
      role: 'work',
      thread_id: 'thread-1',
      resource_id: 'resource-1',
      project_path: '/worktree',
      branch: 'feature',
      status: 'active',
      created_at: new Date(),
      revoked_at: null,
    };
    const pendingRow = {
      id: 'pending-1',
      org_id: 'org1',
      github_project_id: 'p1',
      binding_id: 'binding-1',
      kickoff_key: 'kickoff-1',
      message: 'Start',
      status: 'pending',
      last_error: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const { queries, ctx } = fakePool(text => {
      if (text.includes('FROM factory_pending_starts')) return { rows: [] };
      if (text.includes('FROM work_items') && text.includes('FOR UPDATE')) return { rows: [dbRow] };
      if (text.includes('UPDATE work_items SET sessions')) return { rows: [sessionRow] };
      if (text.includes('INSERT INTO factory_run_bindings')) return { rows: [bindingRow] };
      if (text.includes('INSERT INTO factory_pending_starts')) return { rows: [pendingRow] };
      return undefined;
    });
    const domain = new WorkItemsStoragePG();
    await domain.init(ctx);

    const result = await domain.prepareRunStart({
      orgId: 'org1',
      userId: 'u1',
      githubProjectId: 'p1',
      workItem: { id: 'wi-1', input: createInput },
      role: 'work',
      session: { projectPath: '/worktree', branch: 'feature', threadId: 'thread-1' },
      resourceId: 'resource-1',
      kickoffKey: 'kickoff-1',
      kickoffMessage: 'Start',
    });

    expect(result).toMatchObject({
      replayed: false,
      item: { revision: 2 },
      binding: { id: 'binding-1', status: 'active' },
      pendingStart: { id: 'pending-1', status: 'pending' },
    });
    const sql = queries.map(sqlOf);
    expect(sql.at(-1)).toBe('COMMIT');
    expect(sql.findIndex(text => text.includes('UPDATE work_items SET sessions'))).toBeLessThan(
      sql.findIndex(text => text.includes('INSERT INTO factory_run_bindings')),
    );
    expect(sql.findIndex(text => text.includes('INSERT INTO factory_run_bindings'))).toBeLessThan(
      sql.findIndex(text => text.includes('INSERT INTO factory_pending_starts')),
    );
  });
});

const ITEM_ID = '00000000-0000-4000-8000-000000000001';
const PARENT_ID = '00000000-0000-4000-8000-000000000002';

function dbRow(id: string, parentWorkItemId: string | null = null) {
  return {
    id,
    org_id: 'org-1',
    created_by: 'user-1',
    github_project_id: '00000000-0000-4000-8000-000000000010',
    source: 'github-issue',
    source_key: `github-issue:${id}`,
    parent_work_item_id: parentWorkItemId,
    title: `Item ${id}`,
    url: null,
    stages: ['intake'],
    stage_history: [],
    sessions: {},
    metadata: {},
    revision: 1,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('WorkItemsStoragePG relations', () => {
  it('ships additive relation DDL with scoped ownership lookup and non-cascading deletion', () => {
    expect(WORK_ITEMS_DDL).toContain('ADD COLUMN IF NOT EXISTS parent_work_item_id uuid');
    expect(WORK_ITEMS_DDL).toContain('ON DELETE SET NULL');
    expect(WORK_ITEMS_DDL).toContain('ON work_items (org_id, github_project_id, parent_work_item_id)');
    expect(WORK_ITEMS_DDL).toContain("conrelid = 'work_items'::regclass");
    expect(WORK_ITEMS_DDL).toContain('WHEN duplicate_object THEN NULL');
  });

  it('takes the project advisory lock before locking and validating a relation update', async () => {
    const queries: string[] = [];
    const item = dbRow(ITEM_ID);
    const parent = dbRow(PARENT_ID);
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith('SELECT * FROM work_items WHERE id = $1 AND org_id = $2')) return { rows: [item] };
        if (sql === 'SELECT * FROM work_items WHERE id = $1 FOR UPDATE') return { rows: [item] };
        if (sql.startsWith('SELECT * FROM work_items WHERE org_id = $1')) return { rows: [item, parent] };
        if (sql.startsWith('UPDATE work_items SET')) return { rows: [{ ...item, parent_work_item_id: PARENT_ID }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => client),
    };
    const storage = new WorkItemsStoragePG();
    await storage.init({ pool } as never);

    const result = await storage.update('org-1', ITEM_ID, 'user-1', { parentWorkItemId: PARENT_ID });

    expect(result?.item.parentWorkItemId).toBe(PARENT_ID);
    const advisoryIndex = queries.findIndex(sql => sql.startsWith('SELECT pg_advisory_xact_lock'));
    const rowLockIndex = queries.findIndex(sql => sql === 'SELECT * FROM work_items WHERE id = $1 FOR UPDATE');
    expect(advisoryIndex).toBeGreaterThan(-1);
    expect(rowLockIndex).toBeGreaterThan(advisoryIndex);
  });

  it('commits generic rule ingress, evaluation, and deferred decisions atomically', async () => {
    const { queries, ctx } = fakePool(text => {
      if (text.includes('FROM factory_rule_ingress')) return { rows: [] };
      if (text.includes('FROM work_items') && text.includes('FOR UPDATE')) return { rows: [dbRow('wi-1')] };
      if (text.includes('INSERT INTO factory_rule_ingress')) return { rows: [{ id: 'ingress-1' }] };
      if (text.includes('INSERT INTO factory_rule_evaluations')) return { rows: [{ id: 'evaluation-1' }] };
      return undefined;
    });
    const storage = new WorkItemsStoragePG();
    await storage.init(ctx);

    await expect(
      storage.commitRuleEvaluation({
        orgId: 'org1',
        githubProjectId: 'p1',
        workItemId: 'wi-1',
        ingress: { identity: 'binding:thread:message:call', triggerType: 'tool.result' },
        ruleSetVersion: 'rules-v1',
        expectedRevision: 1,
        outcome: { status: 'accepted' },
        decisions: [{ type: 'notify', idempotencyKey: 'notify-1', title: 'Plan approved' }],
        causalChain: [],
        now: new Date('2026-07-18T10:00:00Z'),
      }),
    ).resolves.toMatchObject({ status: 'committed', result: { status: 'accepted', revision: 1 } });

    const sql = queries.map(sqlOf);
    expect(sql).toContain('BEGIN');
    expect(sql.some(text => text.includes('SELECT pg_advisory_xact_lock'))).toBe(true);
    expect(sql.some(text => text.includes('INSERT INTO factory_rule_ingress'))).toBe(true);
    expect(sql.some(text => text.includes('INSERT INTO factory_rule_evaluations'))).toBe(true);
    expect(sql.some(text => text.includes('INSERT INTO factory_deferred_decisions'))).toBe(true);
    expect(sql.at(-1)).toBe('COMMIT');
  });

  it('stores and restores the durable tool-result cursor', async () => {
    const cursorRow = {
      binding_id: 'binding-1',
      org_id: 'org1',
      github_project_id: 'p1',
      last_message_id: 'message-1',
      last_message_created_at: new Date('2026-07-18T10:00:00Z'),
      updated_at: new Date('2026-07-18T10:00:01Z'),
    };
    const { queries, ctx } = fakePool(text =>
      text.includes('SELECT * FROM factory_tool_result_cursors') ? { rows: [cursorRow] } : undefined,
    );
    const storage = new WorkItemsStoragePG();
    await storage.init(ctx);

    await expect(storage.getToolResultCursor('org1', 'p1', 'binding-1')).resolves.toMatchObject({
      lastMessageId: 'message-1',
    });
    await storage.advanceToolResultCursor({
      bindingId: 'binding-1',
      orgId: 'org1',
      githubProjectId: 'p1',
      lastMessageId: 'message-2',
      lastMessageCreatedAt: new Date('2026-07-18T10:01:00Z'),
      updatedAt: new Date('2026-07-18T10:01:01Z'),
    });
    expect(queries.some(query => query.text.includes('INSERT INTO factory_tool_result_cursors'))).toBe(true);
    expect(WORK_ITEMS_DDL).toContain('CREATE TABLE IF NOT EXISTS factory_tool_result_cursors');
  });

  it('serializes a parent update racing with deletion on the shared project lock', async () => {
    const item = dbRow(ITEM_ID);
    const parent = dbRow(PARENT_ID);
    let deleted = false;
    let connectionCount = 0;
    let lockOwner: number | undefined;
    const lockWaiters: Array<() => void> = [];
    let releaseDeleteRowLock!: () => void;
    const deleteRowLock = new Promise<void>(resolve => {
      releaseDeleteRowLock = resolve;
    });
    let deleteHasProjectLock!: () => void;
    const deleteProjectLock = new Promise<void>(resolve => {
      deleteHasProjectLock = resolve;
    });
    let updateWaitsForProjectLock!: () => void;
    const updateWaiting = new Promise<void>(resolve => {
      updateWaitsForProjectLock = resolve;
    });

    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => {
        const connectionId = ++connectionCount;
        return {
          query: vi.fn(async (sql: string) => {
            if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
              if (lockOwner === undefined) {
                lockOwner = connectionId;
                if (connectionId === 1) deleteHasProjectLock();
              } else {
                updateWaitsForProjectLock();
                await new Promise<void>(resolve => lockWaiters.push(resolve));
                lockOwner = connectionId;
              }
              return { rows: [] };
            }
            if (connectionId === 1 && sql.endsWith('FOR UPDATE')) {
              await deleteRowLock;
              return { rows: [item] };
            }
            if (sql.startsWith('SELECT * FROM work_items WHERE id = $1 AND org_id = $2')) {
              return { rows: [item] };
            }
            if (sql === 'SELECT * FROM work_items WHERE id = $1 FOR UPDATE') {
              return { rows: deleted ? [] : [item] };
            }
            if (sql.startsWith('SELECT * FROM work_items WHERE org_id = $1')) return { rows: [item, parent] };
            if (sql.startsWith('DELETE FROM work_items')) {
              deleted = true;
              return { rows: [item] };
            }
            if (sql.startsWith('UPDATE work_items SET')) {
              return { rows: [{ ...item, parent_work_item_id: PARENT_ID }] };
            }
            if (sql === 'COMMIT' && lockOwner === connectionId) {
              lockOwner = undefined;
              lockWaiters.shift()?.();
            }
            return { rows: [] };
          }),
          release: vi.fn(),
        };
      }),
    };
    const storage = new WorkItemsStoragePG();
    await storage.init({ pool } as never);

    const deleting = storage.delete('org-1', ITEM_ID);
    await deleteProjectLock;
    let updateSettled = false;
    const updating = storage.update('org-1', ITEM_ID, 'user-1', { parentWorkItemId: PARENT_ID }).finally(() => {
      updateSettled = true;
    });
    await updateWaiting;
    expect(updateSettled).toBe(false);

    releaseDeleteRowLock();
    await expect(deleting).resolves.toMatchObject({ id: ITEM_ID });
    await expect(updating).resolves.toBeNull();
  });
});
