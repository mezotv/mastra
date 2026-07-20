import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '../api/keys';
import { createAgentControllerClient } from '../../web/ui/domains/chat/services/agentControllerClient';

interface UseAgentControllerPermissionsArgs {
  agentControllerId: string;
  resourceId: string;
  sessionScope?: string;
  baseUrl?: string;
  enabled?: boolean;
}

export function useAgentControllerPermissions({
  agentControllerId,
  resourceId,
  sessionScope,
  baseUrl = '',
  enabled = true,
}: UseAgentControllerPermissionsArgs) {
  const { session } = createAgentControllerClient({
    agentControllerId,
    resourceId,
    scope: sessionScope,
    baseUrl,
    enabled,
  });

  return useQuery({
    queryKey: queryKeys.agentControllerPermissions(agentControllerId, resourceId, sessionScope),
    queryFn: () => session!.getPermissions(),
    enabled: enabled && Boolean(session),
  });
}
