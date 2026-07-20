import { act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { server } from '../../../../e2e/web-ui/msw-server';
import { renderHookWithProviders, waitForMutationsIdle, TEST_BASE_URL } from '../../../../e2e/web-ui/render';
import type { GithubFactory } from '../../../web/ui/domains/workspaces/services/factories';
import { isGithubFactory, loadFactories, saveFactories } from '../../../web/ui/domains/workspaces/services/factories';
import { useFactoriesQuery } from '../useFactories';
import {
  deriveProjectPath,
  useCreateWorkspaceMutation,
  useDeleteWorkspaceMutation,
  useSelectWorkspaceMutation,
  useWorkspacesQuery,
} from '../useWorkspaces';
import type { WorkspaceThreadSession } from '../useWorkspaces';

const ORIGIN = TEST_BASE_URL;
const FACTORY_ID = 'factory-gh';
const GITHUB_PROJECT_ID = 'github-project-1';

const rootFactory: GithubFactory = {
  id: FACTORY_ID,
  name: 'Mastra',
  resourceId: 'resource-gh',
  createdAt: 1,
  binding: {
    kind: 'github',
    githubProjectId: GITHUB_PROJECT_ID,
    gitBranch: 'main',
    sandboxWorkdir: '/sandbox/mastra',
    worktrees: [
      { branch: 'feat-ui', worktreePath: 'session-feat-ui', baseBranch: 'main' },
      { branch: 'feat-api', worktreePath: 'session-feat-api', baseBranch: 'main' },
      {
        branch: 'user/alice-notes',
        worktreePath: 'session-user-alice-notes',
        baseBranch: 'main',
        threadId: 'thread-user',
      },
    ],
    selectedWorktreePath: 'session-feat-ui',
  },
};

function saveFactory(factory: GithubFactory) {
  saveFactories([factory]);
}

describe('workspaces query hooks', () => {
  it('reads factory worktrees only: user/ session entries are excluded', async () => {
    saveFactory(rootFactory);

    const { result } = renderHookWithProviders(() => useWorkspacesQuery(rootFactory));

    await waitFor(() => expect(result.current.data?.selected?.branch).toBe('feat-ui'));
    expect(result.current.data?.worktrees.map(worktree => worktree.branch)).toEqual(['feat-ui', 'feat-api']);
  });

  it('selects a workspace, persists it, and refreshes factory consumers', async () => {
    saveFactory(rootFactory);

    const { result, client } = renderHookWithProviders(() => {
      const factories = useFactoriesQuery();
      const workspaces = useWorkspacesQuery(rootFactory);
      const selectWorkspace = useSelectWorkspaceMutation(rootFactory, {
        agentControllerId: 'code',
        resourceId: rootFactory.resourceId,
      });
      return { factories, workspaces, selectWorkspace };
    });

    await waitFor(() => expect(result.current.workspaces.data?.selected?.branch).toBe('feat-ui'));

    await act(async () => {
      await result.current.selectWorkspace.mutateAsync('session-feat-api');
    });
    await waitForMutationsIdle(client);

    const stored = loadFactories()[0];
    expect(isGithubFactory(stored!) && stored.binding.selectedWorktreePath).toBe('session-feat-api');
    await waitFor(() => expect(result.current.workspaces.data?.selected?.branch).toBe('feat-api'));
  });

  it('creates a workspace through a GitHub session row, upserts it, selects it, and refreshes consumers', async () => {
    saveFactory(rootFactory);
    let received: unknown;
    server.use(
      http.post(`${ORIGIN}/web/github/projects/${GITHUB_PROJECT_ID}/sessions`, async ({ request }) => {
        received = await request.json();
        return HttpResponse.json({
          id: 'session-feat-docs',
          scope: 'session-feat-docs',
          githubProjectId: GITHUB_PROJECT_ID,
          branch: 'feat-docs',
          baseBranch: 'main',
          resourceId: GITHUB_PROJECT_ID,
          threadId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        });
      }),
    );

    const { result, client } = renderHookWithProviders(() => {
      const workspaces = useWorkspacesQuery(rootFactory);
      const createWorkspace = useCreateWorkspaceMutation(rootFactory, {
        agentControllerId: 'code',
        resourceId: rootFactory.resourceId,
      });
      return { workspaces, createWorkspace };
    });

    await act(async () => {
      await result.current.createWorkspace.mutateAsync('feat-docs');
    });
    await waitForMutationsIdle(client);

    expect(received).toEqual({ branch: 'feat-docs' });
    const stored = loadFactories()[0];
    expect(isGithubFactory(stored!)).toBe(true);
    if (!isGithubFactory(stored!)) throw new Error('expected github factory');
    expect(stored.binding.selectedWorktreePath).toBe('session-feat-docs');
    expect(stored.binding.worktrees.map(worktree => worktree.branch)).toEqual(
      expect.arrayContaining(['feat-ui', 'feat-api', 'feat-docs', 'user/alice-notes']),
    );
    await waitFor(() => expect(result.current.workspaces.data?.selected?.worktreePath).toBe('session-feat-docs'));
  });

  it('deletes a workspace session, cascades threads, and falls back selection', async () => {
    saveFactory(rootFactory);
    let deletedSessionId = '';
    server.use(
      http.delete(`${ORIGIN}/web/github/projects/${GITHUB_PROJECT_ID}/sessions/:sessionId`, ({ params }) => {
        deletedSessionId = String(params.sessionId);
        return HttpResponse.json({ deleted: true, id: deletedSessionId });
      }),
    );

    const listThreads = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'thread-1' }, { id: 'thread-2' }])
      .mockResolvedValueOnce([]);
    const deleteThread = vi.fn().mockResolvedValue(undefined);
    const threadSession: WorkspaceThreadSession = { listThreads, deleteThread };

    const { result, client } = renderHookWithProviders(() => {
      const workspaces = useWorkspacesQuery(rootFactory);
      const deleteWorkspace = useDeleteWorkspaceMutation(rootFactory, threadSession, {
        agentControllerId: 'code',
        resourceId: rootFactory.resourceId,
      });
      return { workspaces, deleteWorkspace };
    });

    await waitFor(() => expect(result.current.workspaces.data?.selected?.branch).toBe('feat-ui'));

    await act(async () => {
      await result.current.deleteWorkspace.mutateAsync({ branch: 'feat-ui', worktreePath: 'session-feat-ui', baseBranch: 'main' });
    });
    await waitForMutationsIdle(client);

    expect(deletedSessionId).toBe('session-feat-ui');
    expect(listThreads).toHaveBeenCalledWith({ limit: 50, tags: { sessionId: 'session-feat-ui' } });
    expect(deleteThread).toHaveBeenCalledTimes(2);
    const stored = loadFactories()[0];
    expect(isGithubFactory(stored!) && stored.binding.selectedWorktreePath).toBe('session-feat-api');
    await waitFor(() => expect(result.current.workspaces.data?.selected?.branch).toBe('feat-api'));
    expect(deriveProjectPath(stored)).toBe('session-feat-api');
  });
});
