import { describe, expect, it } from 'vitest';

import type { FactoryStorageContext } from '../../storage/domain';
import { GithubStorageInMemory } from './inmemory';
import { GITHUB_DDL, GithubStoragePG } from './pg';

function fakeContext(respond: (text: string) => unknown[] = () => []) {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return { rows: respond(text) };
    },
  };
  return { queries, ctx: { pool } as unknown as FactoryStorageContext };
}

describe('GithubStoragePG', () => {
  it('runs the complete idempotent DDL during init', async () => {
    const { queries, ctx } = fakeContext();
    const storage = new GithubStoragePG();

    await storage.init(ctx);

    expect(queries).toEqual([{ text: GITHUB_DDL, values: undefined }]);
    expect(GITHUB_DDL).toContain('CREATE TABLE IF NOT EXISTS github_installations');
    expect(GITHUB_DDL).toContain('CREATE TABLE IF NOT EXISTS github_projects');
    expect(GITHUB_DDL).toContain('CREATE TABLE IF NOT EXISTS github_project_sandboxes');
    expect(GITHUB_DDL).toContain('CREATE TABLE IF NOT EXISTS github_worktrees');
    expect(GITHUB_DDL).toContain('CREATE TABLE IF NOT EXISTS github_signal_subscriptions');
    expect(GITHUB_DDL).toContain('CREATE TABLE IF NOT EXISTS github_pull_request_provenance');
    for (const column of ['work_item_id uuid', 'thread_id text', 'assistant_message_id text', 'tool_call_id text']) {
      expect(GITHUB_DDL).toContain(`ALTER TABLE github_pull_request_provenance ADD COLUMN IF NOT EXISTS ${column}`);
    }
    expect(GITHUB_DDL).toContain('DELETE FROM github_pull_request_provenance');
    expect(GITHUB_DDL).toContain('ALTER COLUMN work_item_id SET NOT NULL');
    expect(GITHUB_DDL).toContain('CREATE UNIQUE INDEX IF NOT EXISTS github_pull_request_provenance_pr_unique');
    expect(GITHUB_DDL).toContain('CREATE UNIQUE INDEX IF NOT EXISTS github_pull_request_provenance_ingress_unique');
    expect(GITHUB_DDL).toContain('CREATE UNIQUE INDEX IF NOT EXISTS github_installations_org_installation_unique');
    expect(GITHUB_DDL).toContain('CREATE UNIQUE INDEX IF NOT EXISTS github_signal_subscriptions_target_pr_unique');
  });

  it('refreshes the sandbox provider when a project already exists', async () => {
    const dbRow = {
      id: 'project-1',
      org_id: 'org1',
      user_id: 'user1',
      installation_id: '12',
      repo_full_name: 'mastra-ai/mastra',
      repo_id: '34',
      default_branch: 'main',
      sandbox_provider: 'railway',
      sandbox_workdir: '/workspace/mastra',
      setup_command: null,
      created_at: new Date(),
    };
    const { queries, ctx } = fakeContext(text => (text.includes('INSERT INTO github_projects') ? [dbRow] : []));
    const storage = new GithubStoragePG();
    await storage.init(ctx);

    await storage.upsertProject({
      orgId: 'org1',
      userId: 'user1',
      installationId: 12,
      repoFullName: 'mastra-ai/mastra',
      repoId: 34,
      defaultBranch: 'main',
      sandboxProvider: 'railway',
      sandboxWorkdir: '/workspace/mastra',
    });

    expect(queries.at(-1)!.text).toContain('sandbox_provider = EXCLUDED.sandbox_provider');
  });

  it('refreshes the sandbox provider in memory too', async () => {
    const storage = new GithubStorageInMemory();
    const input = {
      orgId: 'org1',
      userId: 'user1',
      installationId: 12,
      repoFullName: 'mastra-ai/mastra',
      repoId: 34,
      defaultBranch: 'main',
      sandboxProvider: 'local',
      sandboxWorkdir: '/workspace/mastra',
    };
    await storage.upsertProject(input);

    const updated = await storage.upsertProject({ ...input, sandboxProvider: 'railway' });

    expect(updated.sandboxProvider).toBe('railway');
  });

  it('persists verified pull request provenance and lists every tenant project mapped to a repository', async () => {
    const projectRows = [
      {
        id: 'project-1',
        org_id: 'org1',
        user_id: 'user1',
        installation_id: '12',
        repo_full_name: 'mastra-ai/mastra',
        repo_id: '34',
        default_branch: 'main',
        sandbox_provider: 'local',
        sandbox_workdir: '/workspace',
        setup_command: null,
        created_at: new Date(),
      },
      {
        id: 'project-2',
        org_id: 'org2',
        user_id: 'user2',
        installation_id: '12',
        repo_full_name: 'mastra-ai/mastra',
        repo_id: '34',
        default_branch: 'main',
        sandbox_provider: 'local',
        sandbox_workdir: '/workspace',
        setup_command: null,
        created_at: new Date(),
      },
    ];
    const provenance = {
      id: 'provenance-1',
      org_id: 'org1',
      github_project_id: 'project-1',
      binding_id: 'binding-1',
      work_item_id: 'item-1',
      repository_id: '34',
      pull_request_number: '17',
      pull_request_url: 'https://github.com/mastra-ai/mastra/pull/17',
      thread_id: 'thread-1',
      assistant_message_id: 'message-1',
      tool_call_id: 'call-1',
      created_at: new Date(),
    };
    const { queries, ctx } = fakeContext(text => {
      if (text.includes('ORDER BY org_id, id')) return projectRows;
      if (text.includes('github_pull_request_provenance')) return [provenance];
      return [];
    });
    const storage = new GithubStoragePG();
    await storage.init(ctx);

    await expect(storage.findProjectsByRepo(12, 'mastra-ai/mastra')).resolves.toHaveLength(2);
    await expect(
      storage.recordPullRequestProvenance({
        orgId: 'org1',
        githubProjectId: 'project-1',
        bindingId: 'binding-1',
        workItemId: 'item-1',
        repositoryId: 34,
        pullRequestNumber: 17,
        pullRequestUrl: provenance.pull_request_url,
        threadId: 'thread-1',
        assistantMessageId: 'message-1',
        toolCallId: 'call-1',
      }),
    ).resolves.toMatchObject({ repositoryId: 34, pullRequestNumber: 17, workItemId: 'item-1' });
    expect(queries.at(-1)?.text).toContain('ON CONFLICT (github_project_id, repository_id, pull_request_number)');
    expect(queries.at(-1)?.text).toContain('pull_request_url = github_pull_request_provenance.pull_request_url');
    expect(queries.at(-1)?.text).not.toContain('work_item_id = EXCLUDED.work_item_id');
  });

  it('refuses queries before init succeeds', async () => {
    const storage = new GithubStoragePG();
    await expect(storage.listInstallations('org1')).rejects.toThrow(/Not initialized/);
  });
});
