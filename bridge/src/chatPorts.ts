// Private adapter contracts. No HTTP authorization, ownership inference or platform UI types.
import type { ConversationKind, ConversationQuery, ConversationSearchQuery, ModelOptions, ModelSelection, RunCreated, RunRequest } from '../../protocol/protocol.ts';
import { unavailableChatPort } from './hermes.ts';
import type { AgentProfile, ChatStatus } from './hermes.ts';
import type { PersonalitySelectionState } from './personalitySelection.ts';
import type { ChangeRecord } from './changeLog.ts';

export interface StoredConversation {
  id: string; sessionId: string; source: string; createdSource: string | null; title: string | null;
  kind: ConversationKind; hidden: boolean; archived: boolean; startedAt: number; lastActiveAt: number;
  messageCount: number; preview: string | null; sessionIds: string[];
  continuationUncertain?: boolean;
}
export interface StoredConversationPage { conversations: StoredConversation[]; nextOffset: number | null }
export interface StoredConversationSearchPage {
  hits: { conversation: StoredConversation; match: 'title' | 'message'; messageId: string | null; snippet: string }[];
  nextOffset: number | null;
}
export interface StoredDeletionPreview {
  conversationId: string; messageCount: number; conversationCount: number; revision: string; sessionIds: string[];
  sessionRevisions?: Record<string, string>;
}
export interface HermesChat {
  listConversations(profile: string, query?: ConversationQuery): Promise<StoredConversationPage>;
  getConversation(profile: string, id: string): Promise<StoredConversation | null>;
  searchConversations(profile: string, query: ConversationSearchQuery): Promise<StoredConversationSearchPage>;
  createConversation(profile: string, id: string): Promise<void>;
  renameConversation(profile: string, sessionId: string, title: string): Promise<void>;
  deleteSession(profile: string, sessionId: string): Promise<void>;
  deletionPreview(profile: string, id: string): Promise<StoredDeletionPreview>;
  models(profile: string): Promise<ModelOptions>;
  chat(profile?: string): Promise<ChatStatus>;
  steerRun(profile: string, runId: string, input: string): Promise<void>;
}
// Paths stay inside the server adapter. Tickets and binary delivery belong to #40.
export interface AnnouncedMedia { messageId: string; path: string; displayText?: string }
export interface ValidatedMedia { path: string; name: string; mimeType: string; size: number; identity?: { dev: string; ino: string; mtimeNs: string; ctimeNs: string } }
export interface HermesMedia {
  announcements(profile: string, sessionId: string, messageId?: string): Promise<AnnouncedMedia[]>;
  validate(profile: string, path: string): Promise<ValidatedMedia>;
}
export interface ConversationReceipt {
  agentId: string; id: string; createdAt: number; createdByDeviceId: string; createRequestId: string;
  state: 'creating' | 'ready' | 'deleting'; sessionIds: string[]; model: ModelSelection | null;
  personality?: PersonalitySelectionState;
  deletePlan?: { revision: string; remainingSessionIds: string[] };
}
export interface ConversationState {
  schemaVersion: 1; conversations: ConversationReceipt[];
  deletedRequests: { agentId: string; deviceId: string; requestId: string; conversationId: string }[];
  auditOutbox: ChangeRecord[];
}
export interface ConversationStore {
  snapshot(): ConversationState;
  setModel(agentId: string, id: string, model: ModelSelection | null, actor: { kind: 'device'; id: string; name: string }): Promise<void>;
}
export interface RunContext { agentId: string; conversationId: string; sessionId: string }
export interface ConversationWritePort {
  assertWritable(agentId: string, id: string): Promise<RunContext>;
  withConversationWrite<T>(agentId: string, id: string | null, operation: (context: RunContext) => Promise<T>): Promise<T>;
}
export interface RunActivityPort { activeForConversation(agentId: string, id: string): boolean }
export interface PreparedRunRequest extends RunRequest { model?: ModelSelection | null; instructions?: string }
export interface RunStartPorts {
  // prepare holds the reservation through operation, including registration, then releases it.
  prepare<T>(agent: AgentProfile, request: RunRequest, operation: (context: RunContext) => Promise<T>): Promise<T>;
  decorateRequest(context: RunContext | null, request: RunRequest): Promise<PreparedRunRequest>;
  createUpstreamRun(agentId: string, request: PreparedRunRequest, context: RunContext | null): Promise<RunCreated>;
}

export const unavailableConversationWrites: ConversationWritePort = {
  assertWritable: unavailableChatPort,
  withConversationWrite: unavailableChatPort,
};
