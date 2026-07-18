import { describe, expect, it } from 'vitest';

import type { CommitFactoryTransitionInput } from './base';

import { WorkItemsStorageInMemory } from './inmemory';

const input = {
  source: 'github-issue' as const,
  sourceKey: 'github-issue:42',
  title: 'Fix login',
  url: null,
  stages: ['intake'],
  sessions: {},
  metadata: {},
};

describe('WorkItemsStorageInMemory', () => {
  it('deduplicates source keys within an org, not across orgs', async () => {
    const storage = new WorkItemsStorageInMemory();

    const first = await storage.upsert({ orgId: 'org1', userId: 'user1', githubProjectId: 'project1', input });
    const otherOrg = await storage.upsert({ orgId: 'org2', userId: 'user2', githubProjectId: 'project1', input });
    const reused = await storage.upsert({
      orgId: 'org1',
      userId: 'user3',
      githubProjectId: 'project1',
      input: { ...input, title: 'Updated title' },
    });

    expect(first.created).toBe(true);
    expect(otherOrg.created).toBe(true);
    expect(otherOrg.item.id).not.toBe(first.item.id);
    expect(reused.created).toBe(false);
    expect(reused.item.id).toBe(first.item.id);
  });

  it('commits one CAS winner with history, evaluation, ingress, and deferred decisions', async () => {
    const storage = new WorkItemsStorageInMemory();
    const item = (await storage.upsert({ orgId: 'org1', userId: 'user1', githubProjectId: 'project1', input })).item;
    const transition = (identity: string, destinationStage: string): CommitFactoryTransitionInput => ({
      orgId: 'org1',
      githubProjectId: 'project1',
      workItemId: item.id,
      expectedRevision: 1,
      destinationStage,
      actorId: 'user1',
      ingress: { identity, triggerType: 'human', transitionId: `transition-${identity}` },
      ruleSetVersion: 'rules-v1',
      causalChain: [],
      evaluation: {
        outcome: 'accepted',
        decisions: [{ type: 'notify', idempotencyKey: `notify-${identity}`, title: 'Moved' }],
      },
    });

    const [first, second] = await Promise.all([
      storage.commitTransition(transition('one', 'execute')),
      storage.commitTransition(transition('two', 'planning')),
    ]);

    expect(first.status).not.toBe('missing');
    expect(second.status).not.toBe('missing');
    if (first.status === 'missing' || second.status === 'missing') throw new Error('unexpected missing item');
    expect(first.result).toMatchObject({ status: 'accepted', revision: 2 });
    expect(second.result).toMatchObject({ status: 'rejected', code: 'stale' });
    const canonical = await storage.get('org1', 'project1', item.id);
    expect(canonical?.stages).toEqual(['execute']);
    expect(canonical?.stageHistory.map(entry => [entry.stage, entry.exitedAt !== undefined])).toEqual([
      ['intake', true],
      ['execute', false],
    ]);
    expect(await storage.listDeferredDecisions('org1', 'project1')).toHaveLength(1);
  });

  it('replays immutable ingress independently of the later rule version', async () => {
    const storage = new WorkItemsStorageInMemory();
    const item = (await storage.upsert({ orgId: 'org1', userId: 'user1', githubProjectId: 'project1', input })).item;
    const base: CommitFactoryTransitionInput = {
      orgId: 'org1',
      githubProjectId: 'project1',
      workItemId: item.id,
      expectedRevision: item.revision,
      destinationStage: 'execute',
      actorId: 'user1',
      ingress: { identity: 'same-event', triggerType: 'human', transitionId: 'transition-1' },
      ruleSetVersion: 'rules-v1',
      causalChain: [],
      evaluation: { outcome: 'accepted', decisions: [] },
    };
    const first = await storage.commitTransition(base);
    const replay = await storage.commitTransition({
      ...base,
      destinationStage: 'done',
      ruleSetVersion: 'rules-v2',
      evaluation: { outcome: 'rejected', code: 'forbidden', reason: 'new rule' },
    });

    expect(replay.status).toBe('replayed');
    if (first.status === 'missing' || replay.status === 'missing') throw new Error('unexpected missing item');
    expect(replay.result).toEqual(first.result);
    expect((await storage.get('org1', 'project1', item.id))?.stages).toEqual(['execute']);
  });

  it('preserves canonical stage when start preparation reuses an existing source key', async () => {
    const storage = new WorkItemsStorageInMemory();
    const existing = (
      await storage.upsert({
        orgId: 'org1',
        userId: 'user1',
        githubProjectId: 'project1',
        input: { ...input, stages: ['execute'] },
      })
    ).item;

    const prepared = await storage.prepareRunStart({
      orgId: 'org1',
      userId: 'user1',
      githubProjectId: 'project1',
      workItem: { input: { ...input, stages: ['intake'] } },
      role: 'work',
      session: { projectPath: '/worktree', branch: 'feature', threadId: 'thread-1' },
      resourceId: 'resource1',
      kickoffKey: 'collision-start',
      kickoffMessage: 'Start',
    });

    expect(prepared.item.id).toBe(existing.id);
    expect(prepared.item.stages).toEqual(['execute']);
    expect(prepared.item.sessions.work).toMatchObject({ threadId: 'thread-1' });
  });

  it('atomically prepares exact role bindings and tenant-scoped pending starts', async () => {
    const storage = new WorkItemsStorageInMemory();
    const prepare = (kickoffKey: string, threadId: string, id?: string) =>
      storage.prepareRunStart({
        orgId: 'org1',
        userId: 'user1',
        githubProjectId: 'project1',
        workItem: { id, input },
        role: 'work',
        session: { projectPath: '/worktree', branch: 'feature', threadId },
        resourceId: 'resource1',
        kickoffKey,
        kickoffMessage: 'Start',
      });

    const first = await prepare('kickoff-1', 'thread-1');
    const replay = await prepare('kickoff-1', 'thread-ignored');
    const replacement = await prepare('kickoff-2', 'thread-2', first.item.id);
    const sourceKeyRenewal = await prepare('kickoff-3', 'thread-2');

    expect(replay).toMatchObject({ replayed: true, binding: { id: first.binding.id } });
    expect(replacement.item.revision).toBe(2);
    expect(sourceKeyRenewal).toMatchObject({ item: { id: first.item.id, revision: 3 }, replayed: false });
    expect(
      (await storage.listRunBindings('org1', 'project1', first.item.id)).map(binding => binding.status).sort(),
    ).toEqual(['active', 'revoked', 'revoked']);
    expect(await storage.listPendingStarts('org1', 'project1')).toHaveLength(3);
    expect(await storage.listPendingStarts('other-org', 'project1')).toEqual([]);
  });
});
