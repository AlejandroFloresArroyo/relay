import { useLocalSearchParams } from 'expo-router';

import { ChatRouteContent } from '@/screens/SharedChat';

export default function ChatRoute() {
  const { server, agent, conversationId, conversations, boardDraft, shareDraft } = useLocalSearchParams<{ server: string; agent: string; conversationId?: string; conversations?: string; boardDraft?: string; shareDraft?: string }>();
  return <ChatRouteContent shareDraft={shareDraft} serverId={server} agentId={agent} initialConversationId={conversationId} initialPanelOpen={conversations === '1'} initialDraft={typeof boardDraft === "string" && boardDraft.length <= 4000 ? boardDraft : undefined} />;
}
