import { useMutation } from '@tanstack/react-query';
import {
  createAgentControllerClient,
  requireAgentControllerSession,
} from '../../web/ui/domains/chat/services/agentControllerClient';

interface AgentControllerGoalMutationArgs {
  agentControllerId: string;
  resourceId: string;
  sessionScope?: string;
  baseUrl?: string;
  enabled?: boolean;
}

function toClientArgs({ agentControllerId, resourceId, sessionScope, baseUrl, enabled }: AgentControllerGoalMutationArgs) {
  return { agentControllerId, resourceId, scope: sessionScope, baseUrl, enabled };
}

export function useSetAgentControllerGoalMutation(args: AgentControllerGoalMutationArgs) {
  const { session } = createAgentControllerClient(toClientArgs(args));
  return useMutation({
    mutationFn: (objective: string) => requireAgentControllerSession(session).setGoal(objective),
  });
}

export function usePauseAgentControllerGoalMutation(args: AgentControllerGoalMutationArgs) {
  const { session } = createAgentControllerClient(toClientArgs(args));
  return useMutation({
    mutationFn: () => requireAgentControllerSession(session).updateGoal({ status: 'paused' }),
  });
}

export function useResumeAgentControllerGoalMutation(args: AgentControllerGoalMutationArgs) {
  const { session } = createAgentControllerClient(toClientArgs(args));
  return useMutation({
    mutationFn: () => requireAgentControllerSession(session).updateGoal({ status: 'active' }),
  });
}

export function useClearAgentControllerGoalMutation(args: AgentControllerGoalMutationArgs) {
  const { session } = createAgentControllerClient(toClientArgs(args));
  return useMutation({
    mutationFn: () => requireAgentControllerSession(session).clearGoal(),
  });
}
