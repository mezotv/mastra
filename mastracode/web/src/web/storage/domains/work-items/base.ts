/**
 * Factory work items domain — the unified record behind the Factory kanban
 * board.
 *
 * One `work_items` row represents a unit of work (a GitHub issue/PR, a Linear
 * issue, or a manually filed card) as it moves across board stages. Stages are
 * plain strings inside jsonb (`intake` → `execute` → `review` → `done` today),
 * so evolving the board's columns never needs a schema change. The authoritative
 * Factory transition path keeps one exclusive current stage per item.
 *
 * Tenancy is **org-first**, like `github_projects`: the board is shared by the
 * whole org, scoped to one project. `created_by` and the per-entry `by` /
 * `startedBy` fields record who did what, but never scope reads.
 *
 * Stage history is appended exclusively here (server-side) on every stage
 * transition so it can never drift from `stages`.
 */

import { createHash } from 'node:crypto';

import type { FactoryStorageContext, FactoryStorageDomain } from '../../domain';

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function factoryDecisionHash(decision: Record<string, unknown>): string {
  return createHash('sha256').update(stableJson(decision)).digest('hex');
}

/** Where a work item was materialized from. */
export type WorkItemSource = 'github-issue' | 'github-pr' | 'linear-issue' | 'manual';

/** A session/thread attached to a work item, keyed by role (`work`, `review`, ...). */
export interface WorkItemSessionRef {
  /** Worktree path the scoped agent-controller session is keyed by. */
  projectPath: string;
  /** Feature branch the worktree checks out. */
  branch: string;
  /** Agent-controller thread id for the role's conversation. */
  threadId: string;
  /** WorkOS user id whose sandbox/worktree the session runs in. */
  startedBy: string;
}

/** One stage-transition record, appended server-side (never client-supplied). */
export interface WorkItemStageEntry {
  stage: string;
  /** ISO timestamp the item entered the stage. */
  enteredAt: string;
  /** ISO timestamp the item left the stage; absent while still in it. */
  exitedAt?: string;
  /** WorkOS user id who performed the transition. */
  by: string;
}

/** One persisted work item. */
export interface WorkItemRow {
  id: string;
  /** Owning WorkOS organization id — the board is org-wide. */
  orgId: string;
  /** WorkOS user id of whoever materialized the record (audit only). */
  createdBy: string;
  /** Project (org-owned) the board belongs to. */
  githubProjectId: string;
  source: WorkItemSource;
  /** Dedupe key (e.g. 'github-issue:123', 'linear:ENG-42'); null for manual cards. */
  sourceKey: string | null;
  /** Optional originating issue item for a separate PR review item. */
  parentWorkItemId: string | null;
  title: string;
  /** External link (issue/PR); null for manual cards. */
  url: string | null;
  /** Current stages, e.g. ['execute','review']. */
  stages: string[];
  /** Server-appended stage transition log. */
  stageHistory: WorkItemStageEntry[];
  /** Sessions keyed by role ('work' | 'review' | ...). */
  sessions: Record<string, WorkItemSessionRef>;
  /** Flexible source payload (issue number, labels, headBranch, ...). */
  metadata: Record<string, unknown>;
  /** Monotonic version used by authoritative compare-and-set transitions. */
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FactoryRuleIngressRecord {
  id: string;
  orgId: string;
  githubProjectId: string;
  identity: string;
  triggerType: string;
  transitionId: string;
  result: Record<string, unknown>;
  createdAt: Date;
}

export interface CommitFactoryRuleEvaluationInput {
  orgId: string;
  githubProjectId: string;
  workItemId: string | null;
  ingress: { identity: string; triggerType: string };
  ruleSetVersion: string;
  expectedRevision: number | null;
  actor: Record<string, unknown> | null;
  outcome: { status: 'accepted' | 'rejected'; code?: string; reason?: string };
  decisions: Record<string, unknown>[];
  causalChain: Array<{ ingressId: string; decisionType: string }>;
  now: Date;
}

export type CommitFactoryRuleEvaluationResult =
  | { status: 'committed'; result: Record<string, unknown> }
  | { status: 'replayed'; result: Record<string, unknown> }
  | { status: 'missing' };

export interface FactoryToolResultCursorRecord {
  bindingId: string;
  orgId: string;
  githubProjectId: string;
  lastMessageId: string;
  lastMessageCreatedAt: Date;
  updatedAt: Date;
}

export interface FactoryRuleEvaluationRecord {
  id: string;
  ingressId: string;
  workItemId: string | null;
  ruleSetVersion: string;
  expectedRevision: number | null;
  outcome: 'accepted' | 'rejected';
  code: string | null;
  reason: string | null;
  causalChain: Array<{ ingressId: string; decisionType: string }>;
  createdAt: Date;
}

export type FactoryDispatchStatus = 'pending' | 'leased' | 'retry' | 'succeeded' | 'failed';

export interface FactoryDeferredDecisionRecord {
  id: string;
  orgId: string;
  githubProjectId: string;
  evaluationId: string;
  workItemId: string | null;
  idempotencyKey: string;
  effectOrdinal: number;
  effectHash: string;
  causalChain: Array<{ ingressId: string; decisionType: string }>;
  actor: Record<string, unknown> | null;
  decision: Record<string, unknown>;
  status: FactoryDispatchStatus;
  attempts: number;
  availableAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FactoryRunBindingSessionAddress {
  githubProjectId: string;
  threadId: string;
  resourceId: string;
  projectPath: string;
}

export interface FactoryRunBindingAddress extends FactoryRunBindingSessionAddress {
  orgId: string;
}

export interface RevokeFactoryRunBindingInput {
  orgId: string;
  githubProjectId: string;
  bindingId: string;
  revokedAt: Date;
}

export interface FactoryRunBindingRecord {
  id: string;
  orgId: string;
  githubProjectId: string;
  workItemId: string;
  role: string;
  threadId: string;
  resourceId: string;
  projectPath: string;
  branch: string;
  status: 'active' | 'revoked';
  createdAt: Date;
  revokedAt: Date | null;
}

export interface FactoryPendingStartRecord {
  id: string;
  orgId: string;
  githubProjectId: string;
  bindingId: string;
  kickoffKey: string;
  message: string | null;
  status: 'pending' | 'leased' | 'retry' | 'sent' | 'failed';
  attempts: number;
  availableAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FactoryLeaseClaimInput {
  ownerId: string;
  now: Date;
  leaseExpiresAt: Date;
  limit: number;
}

export interface FactoryLeaseIdentity {
  id: string;
  orgId: string;
  githubProjectId: string;
  ownerId: string;
}

export interface FactoryDispatchFailureInput extends FactoryLeaseIdentity {
  now: Date;
  availableAt: Date;
  lastError: string;
  terminal: boolean;
}

export interface CommitFactoryTransitionInput {
  orgId: string;
  githubProjectId: string;
  workItemId: string;
  expectedRevision: number;
  destinationStage: string;
  actorId: string;
  ingress: { identity: string; triggerType: string; transitionId: string };
  ruleSetVersion: string;
  causalChain: Array<{ ingressId: string; decisionType: string }>;
  evaluation:
    | { outcome: 'accepted'; decisions: Record<string, unknown>[] }
    | { outcome: 'rejected'; code: string; reason: string };
}

export type CommitFactoryTransitionResult =
  | { status: 'committed'; item: WorkItemRow | null; result: Record<string, unknown> }
  | { status: 'replayed'; item: WorkItemRow | null; result: Record<string, unknown> }
  | { status: 'missing' };

export interface PrepareFactoryRunStartInput {
  orgId: string;
  userId: string;
  githubProjectId: string;
  workItem: { id?: string; input: CreateWorkItemInput };
  role: string;
  session: WorkItemSessionInput;
  resourceId: string;
  kickoffKey: string;
  kickoffMessage: string | null;
}

export interface PrepareFactoryRunStartResult {
  item: WorkItemRow;
  binding: FactoryRunBindingRecord;
  pendingStart: FactoryPendingStartRecord;
  replayed: boolean;
}

/** Session ref as accepted from clients — `startedBy` is stamped server-side. */
export interface WorkItemSessionInput {
  projectPath: string;
  branch: string;
  threadId: string;
}

export interface CreateWorkItemInput {
  source: WorkItemSource;
  sourceKey: string | null;
  parentWorkItemId?: string | null;
  title: string;
  url: string | null;
  stages: string[];
  sessions: Record<string, WorkItemSessionInput>;
  metadata: Record<string, unknown>;
}

export interface UpdateWorkItemInput {
  parentWorkItemId?: string | null;
  title?: string;
  url?: string | null;
  stages?: string[];
  sessions?: Record<string, WorkItemSessionInput>;
  metadata?: Record<string, unknown>;
}

/** Pre-patch state returned alongside an update so callers can diff for auditing. */
export interface WorkItemPriorState {
  stages: string[];
  sessionRoles: string[];
}

/** Discriminated result of `upsert`: fresh insert vs source-key reuse. */
export type UpsertWorkItemResult =
  | { created: true; item: WorkItemRow }
  | { created: false; item: WorkItemRow; previous: WorkItemPriorState };

export class WorkItemRelationError extends Error {
  readonly code = 'invalid_work_item_relation';
}

export function validateParentRelation(
  projectItems: WorkItemRow[],
  itemId: string | undefined,
  parentWorkItemId: string | null,
): void {
  if (parentWorkItemId === null) return;
  const byId = new Map(projectItems.map(item => [item.id, item]));
  const parent = byId.get(parentWorkItemId);
  if (!parent) throw new WorkItemRelationError('Related work item not found in this project.');
  if (itemId === parentWorkItemId) throw new WorkItemRelationError('A work item cannot relate to itself.');

  const visited = new Set<string>();
  let cursor: WorkItemRow | undefined = parent;
  while (cursor?.parentWorkItemId) {
    if (cursor.parentWorkItemId === itemId) {
      throw new WorkItemRelationError('This relationship would create a cycle.');
    }
    if (visited.has(cursor.id)) throw new WorkItemRelationError('The related work item chain contains a cycle.');
    visited.add(cursor.id);
    cursor = byId.get(cursor.parentWorkItemId);
  }
}

/**
 * Diff `oldStages` → `newStages` and return the updated history: exited stages
 * get `exitedAt` stamped on their open entry, entered stages get a new entry.
 */
export function applyStageTransition(
  history: WorkItemStageEntry[],
  oldStages: string[],
  newStages: string[],
  by: string,
  now: Date,
): WorkItemStageEntry[] {
  const timestamp = now.toISOString();
  const next = history.map(entry => ({ ...entry }));
  for (const stage of oldStages) {
    if (newStages.includes(stage)) continue;
    // Close the most recent open entry for the exited stage.
    for (let i = next.length - 1; i >= 0; i--) {
      const entry = next[i]!;
      if (entry.stage === stage && entry.exitedAt === undefined) {
        entry.exitedAt = timestamp;
        break;
      }
    }
  }
  for (const stage of newStages) {
    if (oldStages.includes(stage)) continue;
    next.push({ stage, enteredAt: timestamp, by });
  }
  return next;
}

/** Stamp `startedBy` onto client-supplied session refs. */
export function stampSessions(
  sessions: Record<string, WorkItemSessionInput>,
  by: string,
): Record<string, WorkItemSessionRef> {
  const stamped: Record<string, WorkItemSessionRef> = {};
  for (const [role, ref] of Object.entries(sessions)) {
    stamped[role] = { ...ref, startedBy: by };
  }
  return stamped;
}

/**
 * Compute the fields an update patch changes on `existing`: stage changes are
 * diffed into history, sessions and metadata are merged, `updatedAt` is always
 * stamped. Shared by backends so patch semantics can never diverge; each
 * backend is responsible for serializing concurrent read-modify-writes (e.g.
 * `FOR UPDATE` in Postgres).
 */
export function computeWorkItemPatch(
  existing: WorkItemRow,
  patch: UpdateWorkItemInput,
  userId: string,
  now: Date,
): { changes: Partial<WorkItemRow>; previous: WorkItemPriorState } {
  const previous: WorkItemPriorState = {
    stages: [...existing.stages],
    sessionRoles: Object.keys(existing.sessions),
  };
  const changes: Partial<WorkItemRow> = { revision: existing.revision + 1, updatedAt: now };
  if (patch.parentWorkItemId !== undefined) changes.parentWorkItemId = patch.parentWorkItemId;
  if (patch.title !== undefined) changes.title = patch.title;
  if (patch.url !== undefined) changes.url = patch.url;
  if (patch.stages !== undefined) {
    changes.stages = patch.stages;
    changes.stageHistory = applyStageTransition(existing.stageHistory, existing.stages, patch.stages, userId, now);
  }
  if (patch.sessions !== undefined && Object.keys(patch.sessions).length > 0) {
    changes.sessions = { ...existing.sessions, ...stampSessions(patch.sessions, userId) };
  }
  if (patch.metadata !== undefined && Object.keys(patch.metadata).length > 0) {
    changes.metadata = { ...existing.metadata, ...patch.metadata };
  }
  return { changes, previous };
}

/**
 * Abstract work item storage. Backends own their DDL in `init()`; query
 * methods are the typed surface the factory routes consume.
 */
export abstract class WorkItemsStorage implements FactoryStorageDomain {
  readonly name = 'work-items';

  abstract init(ctx: FactoryStorageContext): Promise<void>;

  /** List the org's work items for a project, newest first. */
  abstract list(orgId: string, githubProjectId: string): Promise<WorkItemRow[]>;

  /** Read one canonical item in the caller's tenant. */
  abstract get(orgId: string, githubProjectId: string, id: string): Promise<WorkItemRow | null>;

  /** Read a previously committed immutable ingress result without re-evaluating rules. */
  abstract getTransitionResultByIngress(
    orgId: string,
    githubProjectId: string,
    identity: string,
  ): Promise<Record<string, unknown> | null>;

  /** Atomically dedupe ingress, compare-and-set the item, and persist evaluation/outbox state. */
  abstract commitTransition(input: CommitFactoryTransitionInput): Promise<CommitFactoryTransitionResult>;

  /** Atomically dedupe a non-transition rule ingress and persist evaluation/outbox state. */
  abstract commitRuleEvaluation(input: CommitFactoryRuleEvaluationInput): Promise<CommitFactoryRuleEvaluationResult>;

  /** Read and advance the bounded transcript reconciliation cursor for one binding. */
  abstract getToolResultCursor(
    orgId: string,
    githubProjectId: string,
    bindingId: string,
  ): Promise<FactoryToolResultCursorRecord | null>;
  abstract advanceToolResultCursor(cursor: FactoryToolResultCursorRecord): Promise<void>;

  /** List durable deferred decisions for audit and recovery. */
  abstract listDeferredDecisions(orgId: string, githubProjectId: string): Promise<FactoryDeferredDecisionRecord[]>;

  /** Atomically claim currently available decisions. Expired leases are eligible for recovery. */
  abstract claimDeferredDecisions(input: FactoryLeaseClaimInput): Promise<FactoryDeferredDecisionRecord[]>;

  abstract renewDeferredDecisionLease(
    identity: FactoryLeaseIdentity,
    leaseExpiresAt: Date,
  ): Promise<FactoryDeferredDecisionRecord | null>;

  abstract completeDeferredDecision(
    identity: FactoryLeaseIdentity,
    completedAt: Date,
  ): Promise<FactoryDeferredDecisionRecord | null>;

  abstract failDeferredDecision(input: FactoryDispatchFailureInput): Promise<FactoryDeferredDecisionRecord | null>;

  /** Resolve exact active agent authority; partial session matches never authorize. */
  abstract findActiveRunBinding(address: FactoryRunBindingAddress): Promise<FactoryRunBindingRecord | null>;

  /** Resolve exact bound-session state for processor awareness; ambiguous cross-tenant matches return null. */
  abstract findRunBindingBySession(address: FactoryRunBindingSessionAddress): Promise<FactoryRunBindingRecord | null>;

  /** Revoke one exact tenant-scoped binding. */
  abstract revokeRunBinding(input: RevokeFactoryRunBindingInput): Promise<FactoryRunBindingRecord | null>;

  /** Enumerate active bindings for the server-owned restart reconciler. */
  abstract listActiveRunBindings(): Promise<FactoryRunBindingRecord[]>;

  /** List binding history, optionally narrowed to one work item. */
  abstract listRunBindings(
    orgId: string,
    githubProjectId: string,
    workItemId?: string,
  ): Promise<FactoryRunBindingRecord[]>;

  /** List recoverable kickoff records for this tenant and project. */
  abstract listPendingStarts(orgId: string, githubProjectId: string): Promise<FactoryPendingStartRecord[]>;

  /** Atomically claim currently available kickoff records. Expired leases are eligible for recovery. */
  abstract claimPendingStarts(input: FactoryLeaseClaimInput): Promise<FactoryPendingStartRecord[]>;

  abstract renewPendingStartLease(
    identity: FactoryLeaseIdentity,
    leaseExpiresAt: Date,
  ): Promise<FactoryPendingStartRecord | null>;

  abstract completePendingStart(
    identity: FactoryLeaseIdentity,
    completedAt: Date,
  ): Promise<FactoryPendingStartRecord | null>;

  abstract failPendingStart(input: FactoryDispatchFailureInput): Promise<FactoryPendingStartRecord | null>;

  /** Atomically attach a session, activate its exact binding, and create recoverable kickoff state. */
  abstract prepareRunStart(input: PrepareFactoryRunStartInput): Promise<PrepareFactoryRunStartResult>;

  /** Mark a prepared kickoff after post-commit delivery succeeds or fails. */
  abstract markPendingStart(
    bindingId: string,
    status: 'sent' | 'failed',
    lastError?: string,
  ): Promise<FactoryPendingStartRecord | null>;

  /**
   * Create a work item, reusing the existing record when `sourceKey` already
   * has one for the project (acting twice on the same issue must not duplicate
   * the card). On reuse the provided stages replace the current ones (with the
   * transition recorded in history) and sessions/metadata are merged in. The
   * result discriminates insert from reuse so callers can audit the actual
   * outcome.
   */
  abstract upsert(params: {
    orgId: string;
    userId: string;
    githubProjectId: string;
    input: CreateWorkItemInput;
    reuseMode?: 'update' | 'preserve' | 'non-stage';
  }): Promise<UpsertWorkItemResult>;

  /**
   * Patch an org's work item: stage changes are diffed into history, sessions
   * and metadata are merged. Returns the updated row plus the pre-patch stages
   * and session roles (for audit diffing), or `null` when the item doesn't
   * exist in the caller's org.
   */
  abstract update(
    orgId: string,
    id: string,
    userId: string,
    patch: UpdateWorkItemInput,
  ): Promise<{ item: WorkItemRow; previous: WorkItemPriorState } | null>;

  /** Delete an org's work item. Returns the row actually deleted, or `null` when it doesn't exist in the org. */
  abstract delete(orgId: string, id: string): Promise<WorkItemRow | null>;
}
