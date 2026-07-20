import { Notice } from '@mastra/playground-ui/components/Notice';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

import { useApiConfig } from '../../../../../shared/api/config';
import { queryKeys } from '../../../../../shared/api/keys';
import { SkeletonRows } from '../../../ui';
import { useActiveFactoryContext } from '../../workspaces/context/ActiveFactoryProvider';
import { listGithubSessions } from '../../workspaces/services/github';
import {
  findGithubSessionByThreadId,
  findUserSessionByThreadId,
  isGithubFactory,
  replaceGithubSessions,
} from '../../workspaces/services/factories';
import { deriveProjectPath } from '../../../../../shared/hooks/useWorkspaces';
import { useAgentControllerThreadMessages } from '../../../../../shared/hooks/useAgentControllerThreadMessages';
import { AGENT_CONTROLLER_ID } from '../services/constants';
import { ChatCommandsProvider } from './ChatCommandsProvider';
import { ChatModelsProvider } from './ChatModelsProvider';
import { ChatModesProvider } from './ChatModesProvider';
import { ChatPermissionsProvider } from './ChatPermissionsProvider';
import { ChatSessionContext } from './ChatSessionContext';
import { ChatTranscriptProvider } from './ChatTranscriptProvider';
import { useChatSessionContext } from './useChatSessionContext';

interface ChatThreadMessagesApi {
  threadId?: string;
  isPending: boolean;
  error: unknown;
}

const ChatThreadMessagesContext = createContext<ChatThreadMessagesApi | null>(null);

/** Stable project/API configuration for chat shell consumers such as the sidebar. */
export function ChatSessionConfigProvider({
  children,
  threadId,
  userScoped = false,
}: {
  children: ReactNode;
  threadId?: string;
  userScoped?: boolean;
}) {
  const { activeFactory, resourceId, sessionEnabled } = useActiveFactoryContext();
  const { baseUrl } = useApiConfig();
  const cachedSession = userScoped && threadId ? findGithubSessionByThreadId(threadId) : undefined;
  const legacyWorktreeSession = userScoped && threadId && !cachedSession ? findUserSessionByThreadId(threadId) : undefined;
  const candidateFactory = cachedSession?.factory ?? legacyWorktreeSession?.factory ?? activeFactory;
  const candidateGithubProjectId =
    candidateFactory && isGithubFactory(candidateFactory) ? candidateFactory.binding.githubProjectId : undefined;
  const sessionsQuery = useQuery({
    queryKey: [...queryKeys.userSessions(candidateFactory?.id), 'resolve', threadId ?? null] as const,
    queryFn: async () => {
      if (!candidateFactory || !candidateGithubProjectId) throw new Error('User session not found');
      const sessions = await listGithubSessions(baseUrl, candidateGithubProjectId);
      replaceGithubSessions(candidateFactory, sessions);
      return sessions.find(session => session.threadId === threadId) ?? null;
    },
    enabled: userScoped && Boolean(threadId && !cachedSession && candidateGithubProjectId),
    retry: false,
  });
  const resolvedSession = cachedSession?.session ?? sessionsQuery.data;
  const personalFactory = cachedSession?.factory ?? (resolvedSession ? candidateFactory : undefined) ?? legacyWorktreeSession?.factory;
  const personalGithubProjectId =
    personalFactory && isGithubFactory(personalFactory) ? personalFactory.binding.githubProjectId : undefined;
  const personalResourceId = resolvedSession?.resourceId ?? personalFactory?.resourceId ?? personalGithubProjectId;
  const sessionScope = userScoped ? (resolvedSession?.id ?? legacyWorktreeSession?.worktree.worktreePath ?? '') : deriveProjectPath(activeFactory);
  const githubFactory = activeFactory && isGithubFactory(activeFactory) ? activeFactory : undefined;
  const projectSessionEnabled = userScoped
    ? Boolean(personalResourceId && sessionScope)
    : sessionEnabled && (!githubFactory || Boolean(sessionScope));
  const value = {
    resourceId: userScoped ? (personalResourceId ?? resourceId) : resourceId,
    sessionEnabled: projectSessionEnabled,
    projectPath: sessionScope,
    projectState: !userScoped && githubFactory ? { githubProjectId: githubFactory.binding.githubProjectId } : undefined,
    baseUrl,
    kind: userScoped || !githubFactory ? ('user' as const) : ('factory' as const),
    threadBasePath: userScoped ? ('/user/threads' as const) : ('/threads' as const),
  };

  if (userScoped && threadId && !resolvedSession && !legacyWorktreeSession) {
    return (
      <ChatSessionContext.Provider value={value}>
        <ChatMessageFeedback
          threadId={threadId}
          isPending={sessionsQuery.isPending}
          error={sessionsQuery.isPending ? null : sessionsQuery.error ?? new Error('User session not found')}
        />
      </ChatSessionContext.Provider>
    );
  }

  return <ChatSessionContext.Provider value={value}>{children}</ChatSessionContext.Provider>;
}

/**
 * Route-thread state and transport. This boundary deliberately remains below
 * the persistent shell so only chat content responds to history loading.
 */
export function ChatSessionBoundary({
  children,
  threadId,
  deferUntilMessagesReady = false,
}: {
  children: ReactNode;
  threadId?: string;
  deferUntilMessagesReady?: boolean;
}) {
  const { resourceId, sessionEnabled, projectPath, baseUrl } = useChatSessionContext();
  const messagesQuery = useAgentControllerThreadMessages({
    agentControllerId: AGENT_CONTROLLER_ID,
    resourceId,
    sessionScope: projectPath,
    threadId,
    baseUrl,
    enabled: sessionEnabled && Boolean(threadId),
  });
  const messages = {
    threadId,
    isPending: Boolean(threadId) && messagesQuery.isPending,
    error: messagesQuery.error,
  };

  if (deferUntilMessagesReady && threadId && (messages.isPending || messages.error)) {
    return <ChatMessageFeedback {...messages} />;
  }

  return (
    <ChatTranscriptProvider
      key={`${resourceId}:${threadId ?? 'draft'}:${messagesQuery.isPending ? 'loading' : 'ready'}`}
      threadId={threadId}
      initialMessages={messagesQuery.data}
    >
      <ChatModesProvider>
        <ChatModelsProvider>
          <ChatCommandsProvider>
            <ChatThreadMessagesContext.Provider value={messages}>{children}</ChatThreadMessagesContext.Provider>
          </ChatCommandsProvider>
        </ChatModelsProvider>
      </ChatModesProvider>
    </ChatTranscriptProvider>
  );
}

/** Limits delayed thread-history feedback to the transcript content region. */
export function ChatMessageBoundary({ children }: { children: ReactNode }) {
  const value = useContext(ChatThreadMessagesContext);
  if (!value) throw new Error('ChatMessageBoundary must be used within a ChatSessionBoundary');

  if (value.isPending || value.error) return <ChatMessageFeedback {...value} />;

  return children;
}

function ChatMessageFeedback({ threadId, isPending, error }: ChatThreadMessagesApi) {
  if (threadId && isPending) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto scroll-smooth px-3 pb-2 pt-6 md:px-5 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[80ch]">
        <SkeletonRows label="Loading messages" rows={6} />
      </div>
    );
  }

  if (threadId && error) {
    const errorMessage = error instanceof Error ? error.message : undefined;
    return (
      <div className="flex min-h-0 flex-1 flex-col place-items-center gap-4 overflow-y-auto scroll-smooth px-3 pb-2 pt-6 md:px-5 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[80ch]">
        <Notice variant="destructive">
          {errorMessage ? `Failed to load messages: ${errorMessage}` : 'Failed to load messages.'}
        </Notice>
      </div>
    );
  }

  return null;
}

/** Backward-compatible full chat boundary for focused component tests. */
export function ChatSessionProvider({
  children,
  threadId,
  userScoped = false,
}: {
  children: ReactNode;
  threadId?: string;
  userScoped?: boolean;
}) {
  return (
    <ChatSessionConfigProvider threadId={threadId} userScoped={userScoped}>
      <ChatSessionBoundary threadId={threadId} deferUntilMessagesReady>
        {children}
      </ChatSessionBoundary>
    </ChatSessionConfigProvider>
  );
}
