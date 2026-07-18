import { describe, expect, it, vi } from 'vitest';
import type { GithubIntegration } from './integration.js';
import { recordFactoryPullRequestProvenance } from './provenance.js';
import { GithubStorageInMemory } from './storage/inmemory.js';

async function setup() {
  const storage = new GithubStorageInMemory();
  const project = await storage.upsertProject({
    orgId: 'org-1',
    userId: 'user-1',
    installationId: 7,
    repoFullName: 'acme/repo',
    repoId: 10,
    defaultBranch: 'main',
    sandboxProvider: 'local',
    sandboxWorkdir: '/workspace',
  });
  const pullsGet = vi.fn().mockResolvedValue({
    data: { number: 17, html_url: 'https://github.com/acme/repo/pull/17', base: { repo: { id: 10 } } },
  });
  const github = {
    storageDomain: storage,
    getInstallationOctokit: vi.fn(() => ({ pulls: { get: pullsGet } })),
  } as unknown as GithubIntegration;
  const input = {
    binding: {
      id: 'binding-1',
      orgId: 'org-1',
      githubProjectId: project.id,
      workItemId: 'item-1',
      threadId: 'thread-1',
      resourceId: 'resource-1',
      projectPath: '/workspace',
      branch: 'feature',
      role: 'work',
      status: 'active' as const,
      kickoffKey: 'kickoff-1',
      createdAt: new Date(),
      revokedAt: null,
    },
    item: {
      id: 'item-1',
      orgId: 'org-1',
      userId: 'user-1',
      createdBy: 'user-1',
      githubProjectId: project.id,
      source: 'github-issue' as const,
      sourceKey: 'github:10:issue:42',
      parentWorkItemId: null,
      title: 'Issue 42',
      url: 'https://github.com/acme/repo/issues/42',
      stages: ['execute'],
      sessions: {},
      metadata: {},
      revision: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
      stageHistory: [],
    },
    assistantMessageId: 'message-1',
    toolCallId: 'call-1',
    toolName: 'execute_command',
    toolInput: { command: 'gh pr create --title "PR 17" --body "body"' },
    toolResult: { stdout: 'https://github.com/acme/repo/pull/17\n' },
    status: 'success' as const,
  };
  return { storage, project, github, pullsGet, input };
}

describe('recordFactoryPullRequestProvenance', () => {
  it('records only a verified gh pr create result for the exact bound Factory work item', async () => {
    const { storage, project, github, pullsGet, input } = await setup();
    await recordFactoryPullRequestProvenance(github, input);

    expect(pullsGet).toHaveBeenCalledWith({ owner: 'acme', repo: 'repo', pull_number: 17 });
    await expect(storage.getPullRequestProvenance(project.id, 10, 17)).resolves.toMatchObject({
      bindingId: 'binding-1',
      workItemId: 'item-1',
      threadId: 'thread-1',
      assistantMessageId: 'message-1',
      toolCallId: 'call-1',
    });
  });

  it('ignores unrelated command results and API mismatches', async () => {
    const { storage, project, github, input, pullsGet } = await setup();
    await recordFactoryPullRequestProvenance(github, {
      ...input,
      toolInput: { command: 'gh pr view 17' },
    });
    expect(pullsGet).not.toHaveBeenCalled();

    pullsGet.mockResolvedValueOnce({
      data: { number: 17, html_url: 'https://github.com/other/repo/pull/17', base: { repo: { id: 99 } } },
    });
    await recordFactoryPullRequestProvenance(github, input);
    await expect(storage.getPullRequestProvenance(project.id, 10, 17)).resolves.toBeNull();
  });
});
