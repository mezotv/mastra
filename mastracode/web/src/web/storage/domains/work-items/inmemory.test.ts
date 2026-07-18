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

    expect(replay).toMatchObject({ replayed: true, binding: { id: first.binding.id } });
    expect(replacement.item.revision).toBe(2);
    expect(
      (await storage.listRunBindings('org1', 'project1', first.item.id)).map(binding => binding.status).sort(),
    ).toEqual(['active', 'revoked']);
    expect(await storage.listPendingStarts('org1', 'project1')).toHaveLength(2);
    expect(await storage.listPendingStarts('other-org', 'project1')).toEqual([]);
  });
});
