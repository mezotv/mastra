import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '../api/keys';
import {
  createAgentControllerClient,
  requireAgentControllerSession,
} from '../../web/ui/domains/chat/services/agentControllerClient';

interface AgentControllerMutationArgs {
  agentControllerId: string;
  resourceId: string;
  sessionScope?: string;
  baseUrl?: string;
  enabled?: boolean;
}

export function useSetAgentControllerStateMutation({
  agentControllerId,
  resourceId,
  sessionScope,
  baseUrl = '',
  enabled = true,
}: AgentControllerMutationArgs) {
  const queryClient = useQueryClient();
  const { session } = createAgentControllerClient({
    agentControllerId,
    resourceId,
    scope: sessionScope,
    baseUrl,
    enabled,
  });

  return useMutation({
    mutationFn: (updates: Record<string, unknown>) => requireAgentControllerSession(session).setState(updates),
    onSuccess: async (_data, updates) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.agentControllerConnectionState(agentControllerId, resourceId, sessionScope),
          exact: true,
        }),
        'settings' in updates
          ? queryClient.invalidateQueries({
              queryKey: queryKeys.agentControllerSettings(agentControllerId, resourceId, sessionScope),
              exact: true,
            })
          : Promise.resolve(),
      ]);
    },
  });
}

export function useSwitchAgentControllerModeMutation(args: AgentControllerMutationArgs) {
  const queryClient = useQueryClient();
  const { session } = createAgentControllerClient({ ...args, scope: args.sessionScope });

  return useMutation({
    mutationFn: (modeId: string) => requireAgentControllerSession(session).switchMode(modeId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.agentControllerConnectionState(args.agentControllerId, args.resourceId, args.sessionScope),
        exact: true,
      }),
  });
}

export function useSwitchAgentControllerModelMutation(args: AgentControllerMutationArgs) {
  const queryClient = useQueryClient();
  const { session } = createAgentControllerClient({ ...args, scope: args.sessionScope });

  return useMutation({
    mutationFn: (modelId: string) => requireAgentControllerSession(session).switchModel(modelId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.agentControllerConnectionState(args.agentControllerId, args.resourceId, args.sessionScope),
        exact: true,
      }),
  });
}
