import type { AgentControllerThreadInfo } from '@mastra/client-js';
import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '../api/keys';
import {
  createAgentControllerClient,
  requireAgentControllerSession,
} from '../../web/ui/domains/chat/services/agentControllerClient';

/** How often workspace activity is re-checked while the tab is focused. */
export const WORKSPACE_ACTIVITY_POLL_MS = 5000;

function threadMatchesScope(thread: AgentControllerThreadInfo, sessionScope: string): boolean {
  return thread.tags?.sessionId === sessionScope || thread.tags?.projectPath === sessionScope;
}

function isActiveWorkspaceThread(thread: AgentControllerThreadInfo, sessionScope: string): boolean {
  return threadMatchesScope(thread, sessionScope) && 'state' in thread && thread.state === 'active';
}

interface WorkspaceActivityOptions {
  agentControllerId: string;
  resourceId: string;
  /** The active session scope the listing is read through. */
  sessionScope: string | undefined;
  sessionScopes: string[];
  baseUrl?: string;
  enabled: boolean;
}

/**
 * The shared resource-wide thread listing behind the workspace hooks. Threads
 * are stamped with their session id tag and the server annotates each with its
 * run state (`active`/`idle`), so one poll covers every session sharing the
 * resourceId instead of a request per row.
 */
function useWorkspaceThreadsQuery({
  agentControllerId,
  resourceId,
  sessionScope,
  baseUrl,
  enabled,
}: Omit<WorkspaceActivityOptions, 'sessionScopes'>): AgentControllerThreadInfo[] {
  const query = useQuery({
    queryKey: queryKeys.agentControllerActivity(agentControllerId, resourceId),
    queryFn: async () => {
      const { session } = createAgentControllerClient({
        agentControllerId,
        resourceId,
        scope: sessionScope,
        baseUrl,
      });
      return requireAgentControllerSession(session).listThreads();
    },
    enabled,
    refetchInterval: WORKSPACE_ACTIVITY_POLL_MS,
    retry: false,
  });
  return query.data ?? [];
}

/** Reports which sessions have an agent run in flight, from a single thread listing. */
export function useWorkspaceActivity(options: WorkspaceActivityOptions): Record<string, boolean> {
  const threads = useWorkspaceThreadsQuery(options);
  return Object.fromEntries(
    options.sessionScopes.map(scope => [scope, threads.some(thread => isActiveWorkspaceThread(thread, scope))]),
  );
}

/**
 * A session's conversation thread: the most recent *titled* thread, falling
 * back to the most recent thread of any kind. Bringing a session online can
 * seed an empty untitled thread whose `updatedAt` sorts newer than the real
 * conversation, so recency alone is not a reliable signal — titled threads win
 * regardless of age. Both the sidebar row label and its navigation target use
 * this rule so they can never point at different threads.
 */
export function conversationThread<T extends { title?: string | null; updatedAt?: string; createdAt?: string }>(
  threads: T[],
): T | undefined {
  const sorted = [...threads].sort((a, b) =>
    (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''),
  );
  return sorted.find(thread => thread.title?.trim()) ?? sorted[0];
}

/** Maps each session scope to its conversation thread title. */
export function useWorkspaceThreadTitles(options: WorkspaceActivityOptions): Record<string, string> {
  const threads = useWorkspaceThreadsQuery(options);
  const titles: Record<string, string> = {};
  for (const scope of options.sessionScopes) {
    const thread = conversationThread(threads.filter(t => threadMatchesScope(t, scope)));
    const title = thread?.title?.trim();
    if (title) titles[scope] = title;
  }
  return titles;
}
