import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type { RequestContext } from '@mastra/core/request-context';

import type { WebAuthUser } from '../../auth.js';
import { getWebAuthOrgId } from '../../auth.js';
import type {
  FactoryRunBindingAddress,
  FactoryRunBindingSessionAddress,
} from '../../storage/domains/work-items/base.js';

interface FactorySessionState {
  githubProjectId?: string;
}

export function getFactorySessionCoordinates(
  requestContext: RequestContext | undefined,
): FactoryRunBindingSessionAddress | null {
  if (!requestContext || typeof requestContext.get !== 'function') return null;
  const context = requestContext.get('controller') as AgentControllerRequestContext<FactorySessionState> | undefined;
  const githubProjectId = context?.getState().githubProjectId;
  if (!context?.threadId || !context.resourceId || !context.scope || !githubProjectId) return null;
  return {
    githubProjectId,
    threadId: context.threadId,
    resourceId: context.resourceId,
    projectPath: context.scope,
  };
}

export function getFactorySessionAddress(requestContext: RequestContext | undefined): FactoryRunBindingAddress | null {
  const coordinates = getFactorySessionCoordinates(requestContext);
  if (!coordinates || !requestContext || typeof requestContext.get !== 'function') return null;
  const user = requestContext.get('user') as WebAuthUser | undefined;
  const orgId = getWebAuthOrgId(user);
  if (!orgId) return null;
  return { orgId, ...coordinates };
}
