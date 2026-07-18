/**
 * In-memory work item storage for unit tests. Patch semantics come from the
 * shared `computeWorkItemPatch` in `./base`, so behavior matches the Postgres
 * implementation; single-process access stands in for `FOR UPDATE`.
 */

import { randomUUID } from 'node:crypto';

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
  FactoryRuleEvaluationRecord,
  FactoryRuleIngressRecord,
  FactoryRunBindingRecord,
  PrepareFactoryRunStartInput,
  PrepareFactoryRunStartResult,
  UpdateWorkItemInput,
  UpsertWorkItemResult,
  WorkItemPriorState,
  WorkItemRow,
} from './base';

export class WorkItemsStorageInMemory extends WorkItemsStorage {
  #items = new Map<string, WorkItemRow>();
  #ingress = new Map<string, FactoryRuleIngressRecord>();
  #evaluations = new Map<string, FactoryRuleEvaluationRecord>();
  #decisions = new Map<string, FactoryDeferredDecisionRecord>();
  #bindings = new Map<string, FactoryRunBindingRecord>();
  #pendingStarts = new Map<string, FactoryPendingStartRecord>();

  async init(): Promise<void> {
    // Nothing to set up.
  }

  #clone(row: WorkItemRow): WorkItemRow {
    return structuredClone(row);
  }

  #projectItems(orgId: string, githubProjectId: string): WorkItemRow[] {
    return [...this.#items.values()].filter(item => item.orgId === orgId && item.githubProjectId === githubProjectId);
  }

  async list(orgId: string, githubProjectId: string): Promise<WorkItemRow[]> {
    return [...this.#items.values()]
      .filter(item => item.orgId === orgId && item.githubProjectId === githubProjectId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map(item => this.#clone(item));
  }

  async get(orgId: string, githubProjectId: string, id: string): Promise<WorkItemRow | null> {
    const item = this.#items.get(id);
    return item?.orgId === orgId && item.githubProjectId === githubProjectId ? this.#clone(item) : null;
  }

  async getTransitionResultByIngress(
    orgId: string,
    githubProjectId: string,
    identity: string,
  ): Promise<Record<string, unknown> | null> {
    const ingress = this.#ingress.get(`${orgId}:${githubProjectId}:${identity}`);
    return ingress ? structuredClone(ingress.result) : null;
  }

  async commitTransition(input: CommitFactoryTransitionInput): Promise<CommitFactoryTransitionResult> {
    const ingressKey = `${input.orgId}:${input.githubProjectId}:${input.ingress.identity}`;
    const priorIngress = this.#ingress.get(ingressKey);
    if (priorIngress) {
      return {
        status: 'replayed',
        item: await this.get(input.orgId, input.githubProjectId, input.workItemId),
        result: structuredClone(priorIngress.result),
      };
    }

    const item = this.#items.get(input.workItemId);
    if (!item || item.orgId !== input.orgId || item.githubProjectId !== input.githubProjectId) {
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
      this.#ingress.set(ingressKey, {
        id: randomUUID(),
        orgId: input.orgId,
        githubProjectId: input.githubProjectId,
        identity: input.ingress.identity,
        triggerType: input.ingress.triggerType,
        transitionId: input.ingress.transitionId,
        result: structuredClone(result),
        createdAt: now,
      });
      return { status: 'committed', item: null, result };
    }

    const now = new Date();
    const ingressId = randomUUID();
    const evaluationId = randomUUID();
    let result: Record<string, unknown>;
    let updated = item;
    let outcome: 'accepted' | 'rejected';
    let code: string | null = null;
    let reason: string | null = null;

    if (item.revision !== input.expectedRevision) {
      outcome = 'rejected';
      code = 'stale';
      reason = 'The work item changed before this transition committed.';
      result = {
        status: 'rejected',
        transitionId: input.ingress.transitionId,
        itemId: item.id,
        code,
        reason,
      };
    } else if (input.evaluation.outcome === 'rejected') {
      outcome = 'rejected';
      code = input.evaluation.code;
      reason = input.evaluation.reason;
      result = {
        status: 'rejected',
        transitionId: input.ingress.transitionId,
        itemId: item.id,
        code,
        reason,
      };
    } else {
      outcome = 'accepted';
      if (item.stages.length !== 1 || item.stages[0] !== input.destinationStage) {
        updated = {
          ...item,
          stages: [input.destinationStage],
          stageHistory: applyStageTransition(
            item.stageHistory,
            item.stages,
            [input.destinationStage],
            input.actorId,
            now,
          ),
          revision: item.revision + 1,
          updatedAt: now,
        };
        this.#items.set(item.id, structuredClone(updated));
      }
      result = {
        status: 'accepted',
        transitionId: input.ingress.transitionId,
        itemId: item.id,
        revision: updated.revision,
        stage: input.destinationStage,
        decisions: structuredClone(input.evaluation.decisions),
      };
      for (const decision of input.evaluation.decisions) {
        const idempotencyKey = String(decision.idempotencyKey);
        this.#decisions.set(`${input.orgId}:${input.githubProjectId}:${idempotencyKey}`, {
          id: randomUUID(),
          orgId: input.orgId,
          githubProjectId: input.githubProjectId,
          evaluationId,
          workItemId: item.id,
          idempotencyKey,
          decision: structuredClone(decision),
          status: 'pending',
          createdAt: now,
        });
      }
    }

    const ingress: FactoryRuleIngressRecord = {
      id: ingressId,
      orgId: input.orgId,
      githubProjectId: input.githubProjectId,
      identity: input.ingress.identity,
      triggerType: input.ingress.triggerType,
      transitionId: input.ingress.transitionId,
      result: structuredClone(result),
      createdAt: now,
    };
    this.#ingress.set(ingressKey, ingress);
    this.#evaluations.set(evaluationId, {
      id: evaluationId,
      ingressId,
      workItemId: item.id,
      ruleSetVersion: input.ruleSetVersion,
      expectedRevision: input.expectedRevision,
      outcome,
      code,
      reason,
      createdAt: now,
    });
    return { status: 'committed', item: this.#clone(updated), result };
  }

  async listDeferredDecisions(orgId: string, githubProjectId: string): Promise<FactoryDeferredDecisionRecord[]> {
    return [...this.#decisions.values()]
      .filter(decision => decision.orgId === orgId && decision.githubProjectId === githubProjectId)
      .map(decision => structuredClone(decision));
  }

  async listRunBindings(
    orgId: string,
    githubProjectId: string,
    workItemId?: string,
  ): Promise<FactoryRunBindingRecord[]> {
    return [...this.#bindings.values()]
      .filter(
        binding =>
          binding.orgId === orgId &&
          binding.githubProjectId === githubProjectId &&
          (workItemId === undefined || binding.workItemId === workItemId),
      )
      .map(binding => structuredClone(binding));
  }

  async listPendingStarts(orgId: string, githubProjectId: string): Promise<FactoryPendingStartRecord[]> {
    return [...this.#pendingStarts.values()]
      .filter(pending => pending.orgId === orgId && pending.githubProjectId === githubProjectId)
      .map(pending => structuredClone(pending));
  }

  async prepareRunStart(input: PrepareFactoryRunStartInput): Promise<PrepareFactoryRunStartResult> {
    const prior = [...this.#pendingStarts.values()].find(
      entry =>
        entry.orgId === input.orgId &&
        entry.githubProjectId === input.githubProjectId &&
        entry.kickoffKey === input.kickoffKey,
    );
    if (prior) {
      const binding = this.#bindings.get(prior.bindingId)!;
      const item = this.#items.get(binding.workItemId)!;
      return {
        item: this.#clone(item),
        binding: structuredClone(binding),
        pendingStart: structuredClone(prior),
        replayed: true,
      };
    }

    let item: WorkItemRow;
    if (input.workItem.id) {
      const existing = this.#items.get(input.workItem.id);
      if (!existing || existing.orgId !== input.orgId || existing.githubProjectId !== input.githubProjectId) {
        throw new Error('Factory work item not found.');
      }
      item = this.#applyPatch(existing, { sessions: { [input.role]: input.session } }, input.userId, new Date()).item;
    } else {
      const resolved = await this.upsert({
        orgId: input.orgId,
        userId: input.userId,
        githubProjectId: input.githubProjectId,
        input: { ...input.workItem.input, sessions: { [input.role]: input.session } },
        reuseMode: 'preserve',
      });
      item = resolved.created
        ? resolved.item
        : this.#applyPatch(
            resolved.item,
            { sessions: { [input.role]: input.session } },
            input.userId,
            new Date(),
          ).item;
    }

    const conflictingThread = [...this.#bindings.values()].find(
      binding =>
        binding.orgId === input.orgId &&
        binding.threadId === input.session.threadId &&
        binding.status === 'active' &&
        (binding.workItemId !== item.id || binding.role !== input.role),
    );
    if (conflictingThread) throw new Error('Factory thread already has an active binding.');

    const now = new Date();
    for (const binding of this.#bindings.values()) {
      if (binding.workItemId === item.id && binding.role === input.role && binding.status === 'active') {
        binding.status = 'revoked';
        binding.revokedAt = now;
      }
    }
    const binding: FactoryRunBindingRecord = {
      id: randomUUID(),
      orgId: input.orgId,
      githubProjectId: input.githubProjectId,
      workItemId: item.id,
      role: input.role,
      threadId: input.session.threadId,
      resourceId: input.resourceId,
      projectPath: input.session.projectPath,
      branch: input.session.branch,
      status: 'active',
      createdAt: now,
      revokedAt: null,
    };
    const pendingStart: FactoryPendingStartRecord = {
      id: randomUUID(),
      orgId: input.orgId,
      githubProjectId: input.githubProjectId,
      bindingId: binding.id,
      kickoffKey: input.kickoffKey,
      message: input.kickoffMessage,
      status: 'pending',
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#bindings.set(binding.id, structuredClone(binding));
    this.#pendingStarts.set(pendingStart.id, structuredClone(pendingStart));
    return { item, binding, pendingStart, replayed: false };
  }

  async markPendingStart(
    bindingId: string,
    status: 'sent' | 'failed',
    lastError?: string,
  ): Promise<FactoryPendingStartRecord | null> {
    const pending = [...this.#pendingStarts.values()].find(entry => entry.bindingId === bindingId);
    if (!pending) return null;
    const updated = { ...pending, status, lastError: lastError ?? null, updatedAt: new Date() };
    this.#pendingStarts.set(updated.id, structuredClone(updated));
    return structuredClone(updated);
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

    if (input.sourceKey !== null) {
      const existing = [...this.#items.values()].find(
        item => item.orgId === orgId && item.githubProjectId === githubProjectId && item.sourceKey === input.sourceKey,
      );
      if (existing) {
        if (reuseMode === 'preserve') {
          return {
            created: false,
            item: this.#clone(existing),
            previous: { stages: [...existing.stages], sessionRoles: Object.keys(existing.sessions) },
          };
        }
        if (reuseMode === 'non-stage') {
          const patch: UpdateWorkItemInput = {
            title: input.title,
            url: input.url,
            parentWorkItemId: input.parentWorkItemId ?? undefined,
            metadata: input.metadata,
          };
          const updated = this.#applyPatch(existing, patch, userId, now);
          return { created: false, item: updated.item, previous: updated.previous };
        }
        const patch = input.parentWorkItemId === null ? { ...input, parentWorkItemId: undefined } : input;
        const updated = this.#applyPatch(existing, patch, userId, now);
        return { created: false, item: updated.item, previous: updated.previous };
      }
    }

    validateParentRelation(this.#projectItems(orgId, githubProjectId), undefined, input.parentWorkItemId ?? null);
    const row: WorkItemRow = {
      id: randomUUID(),
      orgId,
      createdBy: userId,
      githubProjectId,
      source: input.source,
      sourceKey: input.sourceKey,
      parentWorkItemId: input.parentWorkItemId ?? null,
      title: input.title,
      url: input.url,
      stages: input.stages,
      stageHistory: applyStageTransition([], [], input.stages, userId, now),
      sessions: stampSessions(input.sessions, userId),
      metadata: input.metadata,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.#items.set(row.id, structuredClone(row));
    return { created: true, item: row };
  }

  #applyPatch(
    existing: WorkItemRow,
    patch: UpdateWorkItemInput,
    userId: string,
    now: Date,
  ): { item: WorkItemRow; previous: WorkItemPriorState } {
    if (patch.parentWorkItemId !== undefined) {
      validateParentRelation(
        this.#projectItems(existing.orgId, existing.githubProjectId),
        existing.id,
        patch.parentWorkItemId,
      );
    }
    const { changes, previous } = computeWorkItemPatch(existing, patch, userId, now);
    const updated = { ...existing, ...changes };
    this.#items.set(updated.id, structuredClone(updated));
    return { item: this.#clone(updated), previous };
  }

  async update(
    orgId: string,
    id: string,
    userId: string,
    patch: UpdateWorkItemInput,
  ): Promise<{ item: WorkItemRow; previous: WorkItemPriorState } | null> {
    const existing = this.#items.get(id);
    if (!existing || existing.orgId !== orgId) return null;
    return this.#applyPatch(existing, patch, userId, new Date());
  }

  async delete(orgId: string, id: string): Promise<WorkItemRow | null> {
    const existing = this.#items.get(id);
    if (!existing || existing.orgId !== orgId) return null;
    this.#items.delete(id);
    for (const item of this.#items.values()) {
      if (item.orgId === orgId && item.parentWorkItemId === id) {
        item.parentWorkItemId = null;
        item.updatedAt = new Date();
      }
    }
    return this.#clone(existing);
  }
}
