import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '../api/keys';
import { createAgentControllerClient } from '../../web/ui/domains/chat/services/agentControllerClient';

export const AGENT_CONTROLLER_THREAD_PAGE_SIZE = 20;

interface UseAgentControllerThreadsArgs {
  agentControllerId: string;
  resourceId: string;
  sessionScope?: string;
  baseUrl?: string;
  enabled?: boolean;
}

export function useAgentControllerThreads({
  agentControllerId,
  resourceId,
  sessionScope,
  baseUrl = '',
  enabled = true,
}: UseAgentControllerThreadsArgs) {
  const { session } = createAgentControllerClient({
    agentControllerId,
    resourceId,
    scope: sessionScope,
    baseUrl,
    enabled,
  });

  return useQuery({
    queryKey: queryKeys.agentControllerThreads(agentControllerId, resourceId, sessionScope),
    queryFn: () =>
      session!.listThreads({
        limit: AGENT_CONTROLLER_THREAD_PAGE_SIZE,
        tags: sessionScope ? { sessionId: sessionScope } : undefined,
      }),
    enabled: enabled && Boolean(session),
  });
}
