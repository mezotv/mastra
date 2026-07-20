import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '../api/keys';
import { createAgentControllerClient } from '../../web/ui/domains/chat/services/agentControllerClient';

interface UseAgentControllerSettingsArgs {
  agentControllerId: string;
  resourceId: string;
  sessionScope?: string;
  baseUrl?: string;
  enabled?: boolean;
}

export function useAgentControllerSettings({
  agentControllerId,
  resourceId,
  sessionScope,
  baseUrl = '',
  enabled = true,
}: UseAgentControllerSettingsArgs) {
  const { session } = createAgentControllerClient({
    agentControllerId,
    resourceId,
    scope: sessionScope,
    baseUrl,
    enabled,
  });

  return useQuery({
    queryKey: queryKeys.agentControllerSettings(agentControllerId, resourceId, sessionScope),
    queryFn: async () => {
      const state = await session!.state();
      return state.settings ?? null;
    },
    enabled: enabled && Boolean(session),
  });
}
