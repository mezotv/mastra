import { Button } from '@mastra/playground-ui/components/Button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@mastra/playground-ui/components/Dialog';
import { Input } from '@mastra/playground-ui/components/Input';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { useApiConfig } from '../../../../../shared/api/config';
import { queryKeys } from '../../../../../shared/api/keys';
import { useWorkspaceActivity } from '../../../../../shared/hooks/useWorkspaceActivity';
import { useWorkspaceAttention } from '../../../../../shared/hooks/useWorkspaceAttention';
import { useWebAuth } from '../../../../../shared/hooks/useWebAuth';
import { useToast } from '../../../ui/toast';
import { createAgentControllerClient, requireAgentControllerSession } from '../../chat/services/agentControllerClient';
import { AGENT_CONTROLLER_ID } from '../../chat/services/constants';
import { useActiveFactoryContext } from '../context/ActiveFactoryProvider';
import { createGithubSession, deleteGithubSession, listGithubSessions } from '../services/github';
import type { GithubSessionResult } from '../services/github';
import type { Factory, Worktree } from '../services/factories';
import {
  isGithubFactory,
  loadFactories,
  removeWorktree,
  replaceGithubSessions,
  sessionResultToWorktree,
  upsertWorktree,
  USER_SESSION_BRANCH_PREFIX,
} from '../services/factories';
import { WorkspaceRow } from './WorkspacesSection';

type GithubSessionSummary = GithubSessionResult;

function latestFactory(factory: Factory): Factory {
  return loadFactories().find(stored => stored.id === factory.id) ?? factory;
}

function sessionLabel(session: GithubSessionSummary): string {
  return session.branch.startsWith(USER_SESSION_BRANCH_PREFIX)
    ? session.branch.slice(USER_SESSION_BRANCH_PREFIX.length)
    : session.branch;
}

function sessionAsWorktree(session: GithubSessionSummary): Worktree {
  return sessionResultToWorktree(session);
}

export function UserSessionsSection() {
  const { baseUrl } = useApiConfig();
  const { activeFactory } = useActiveFactoryContext();
  const auth = useWebAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<GithubSessionSummary | null>(null);

  const githubFactory = activeFactory && isGithubFactory(activeFactory) ? activeFactory : undefined;
  const githubProjectId = githubFactory?.binding.githubProjectId;
  const resourceId = githubProjectId ?? '';

  const sessionsQuery = useQuery({
    queryKey: queryKeys.userSessions(activeFactory?.id),
    queryFn: async (): Promise<GithubSessionSummary[]> => {
      if (!githubFactory || !githubProjectId) throw new Error('User sessions require a GitHub factory');
      const sessions = await listGithubSessions(baseUrl, githubProjectId);
      replaceGithubSessions(latestFactory(githubFactory), sessions);
      return sessions;
    },
    enabled: Boolean(githubFactory && githubProjectId && !auth.isPending),
  });
  const sessions = sessionsQuery.data ?? [];

  const runningByPath = useWorkspaceActivity({
    agentControllerId: AGENT_CONTROLLER_ID,
    resourceId,
    sessionScope: sessions[0]?.id,
    sessionScopes: sessions.map(session => session.id),
    baseUrl,
    enabled: Boolean(githubProjectId && sessions.length > 0),
  });
  const { attentionByPath, clearAttention } = useWorkspaceAttention(runningByPath);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.userSessions(activeFactory?.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.factories() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.agentControllerActivity(AGENT_CONTROLLER_ID, resourceId) });
  };

  const userSessionFor = (sessionId: string) => {
    if (!githubProjectId) throw new Error('No GitHub project selected');
    const { session } = createAgentControllerClient({
      agentControllerId: AGENT_CONTROLLER_ID,
      resourceId: githubProjectId,
      scope: sessionId,
      baseUrl,
    });
    return requireAgentControllerSession(session);
  };

  const openSession = async (session: GithubSessionSummary) => {
    try {
      const chatSession = userSessionFor(session.id);
      const created = await chatSession.create({
        tags: { sessionId: session.id, githubProjectId: session.githubProjectId, branch: session.branch, baseBranch: session.baseBranch },
      });
      const threadId = session.threadId ?? created.threadId;
      if (!threadId) throw new Error('Could not resolve session thread');
      if (githubFactory && threadId !== session.threadId) {
        upsertWorktree(latestFactory(githubFactory), sessionResultToWorktree({ ...session, threadId }));
      }
      clearAttention(session.id);
      invalidate();
      void navigate(`/user/threads/${threadId}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Failed to open session', 'error');
    }
  };

  const createSession = useMutation({
    mutationFn: async (rawName: string) => {
      if (!githubFactory || !githubProjectId) throw new Error('No GitHub project selected');
      const slug = rawName.trim().toLowerCase().replace(/\s+/g, '-');
      if (!slug) throw new Error('Session name is required');
      const created = await createGithubSession(baseUrl, githubProjectId, `${USER_SESSION_BRANCH_PREFIX}${slug}`);
      const chatSession = userSessionFor(created.id);
      const controllerSession = await chatSession.create({
        tags: { sessionId: created.id, githubProjectId: created.githubProjectId, branch: created.branch, baseBranch: created.baseBranch },
      });
      const threadId = created.threadId ?? controllerSession.threadId;
      if (!threadId) throw new Error('Could not resolve session thread');
      const session = { ...created, threadId };
      upsertWorktree(latestFactory(githubFactory), sessionResultToWorktree(session));
      queryClient.setQueryData(queryKeys.agentControllerThreadMessages(AGENT_CONTROLLER_ID, githubProjectId, threadId), []);
      return threadId;
    },
    onSuccess: threadId => {
      setCreating(false);
      setName('');
      invalidate();
      void navigate(`/user/threads/${threadId}`);
    },
    onError: error => toast(error instanceof Error ? error.message : 'Failed to create session', 'error'),
  });

  const deleteSession = useMutation({
    mutationFn: async (session: GithubSessionSummary) => {
      if (!githubFactory || !githubProjectId) throw new Error('No GitHub project selected');
      const chatSession = userSessionFor(session.id);
      for (let round = 0; round < 20; round++) {
        const threads = await chatSession.listThreads({ limit: 50, tags: { sessionId: session.id } });
        if (threads.length === 0) break;
        for (const thread of threads) await chatSession.deleteThread(thread.id);
      }
      await deleteGithubSession(baseUrl, githubProjectId, session.id);
      removeWorktree(latestFactory(githubFactory), session.id);
      return session;
    },
    onSuccess: session => {
      setConfirmDelete(null);
      invalidate();
      toast('Session deleted');
      if (session.threadId && location.pathname === `/user/threads/${session.threadId}`) {
        void navigate('/new', { replace: true });
      }
    },
    onError: error => {
      setConfirmDelete(null);
      toast(error instanceof Error ? error.message : 'Failed to delete session', 'error');
    },
  });

  if (!githubFactory) return null;

  const pending = createSession.isPending || deleteSession.isPending || sessionsQuery.isFetching;
  const activeThread = location.pathname.startsWith('/user/threads/') ? location.pathname.split('/').pop() : undefined;

  const resetCreate = () => {
    setCreating(false);
    setName('');
  };

  const submitCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (name.trim()) createSession.mutate(name);
  };

  return (
    <section className="flex flex-col gap-2" aria-label="User sessions">
      <div className="flex items-center justify-between px-1">
        <Txt as="span" variant="ui-xs" className="text-icon3 uppercase tracking-wide">
          My sessions
        </Txt>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Create session"
          onClick={() => setCreating(true)}
          disabled={pending || auth.isPending}
        >
          <Plus size={14} />
        </Button>
      </div>

      {sessions.length === 0 ? (
        <Txt variant="ui-xs" className="px-2 text-icon3">
          No personal sessions yet.
        </Txt>
      ) : (
        <div className="flex flex-col gap-1">
          {sessions.map(session => (
            <WorkspaceRow
              key={session.id}
              worktree={sessionAsWorktree(session)}
              label={sessionLabel(session)}
              active={Boolean(activeThread && activeThread === session.threadId)}
              running={Boolean(runningByPath[session.id])}
              attention={Boolean(attentionByPath[session.id])}
              disabled={pending}
              onSelect={() => void openSession(session)}
              onDelete={() => setConfirmDelete(session)}
            />
          ))}
        </div>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create session</DialogTitle>
          </DialogHeader>
          <form onSubmit={submitCreate} className="flex flex-col gap-3">
            <Input
              autoFocus
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder="session-name"
              disabled={createSession.isPending}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={resetCreate} disabled={createSession.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || createSession.isPending}>
                Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(confirmDelete)} onOpenChange={open => !open && setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete session?</DialogTitle>
          </DialogHeader>
          <Txt variant="ui-sm" className="text-icon3">
            This deletes the session and its threads.
          </Txt>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setConfirmDelete(null)} disabled={deleteSession.isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={!confirmDelete || deleteSession.isPending}
              onClick={() => confirmDelete && deleteSession.mutate(confirmDelete)}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
