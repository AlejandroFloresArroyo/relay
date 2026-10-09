import type { PersonalityClient } from './personalityPresetsClient.ts';
import type { PersonalityErrorCode } from '../../../protocol/personalityPresets.ts';
import type { ActivityErrorCode, ActivityPage, ActivityQuery } from '../../../protocol/activity.ts';
import type { AppUpdateDownloadOptions } from './appUpdateTransport.ts';
import type { AppUpdateManifest } from '../../../protocol/appUpdate.ts';
import type { AppUpdateErrorCode } from './appUpdate.ts';
import type { ServerUsage, UsagePeriod } from '../../../protocol/serverUsage.ts';
import type { AgentTools, AgentSkills, AgentToolsErrorCode } from '../../../protocol/agentTools.ts';
import type { AgentMemory, AgentSoul, MemoryChange, SoulChange, AgentMemoryErrorCode } from '../../../protocol/agentMemory.ts';
import type { ScheduledJob, ScheduledJobInput, ScheduledJobList, JobHistory, JobAction } from '../../../protocol/scheduledJobs.ts';
import type {
  ChatErrorCode,
  DecisionErrorCode,
  DecisionQuery,
  DecisionHistory,
  ConversationTranscript,
  ConversationQuery,
  ConversationPage,
  Conversation,
  ConversationCreateRequest,
  ConversationRenameRequest,
  ConversationDeletionPreview,
  ConversationDeleteRequest,
  ConversationDeleted,
  ConversationSearchQuery,
  ConversationSearchPage,
  AgentChatStatus,
  SteerRequest,
  SteerAccepted,
  RunSnapshot,
  ModelOptions,
  ConversationModelRequest,
  ConversationFilesQuery,
  ConversationFiles,
  Agent,
  Approval,
  ApprovalChoice,
  AuthErrorCode,
  DoctorReport,
  GatewayStatus,
  Health,
  Job,
  LogLevel,
  LogLine,
  ModelInfo,
  RunCreated,
  ChatRunEvent,
  RemoteErrorCode,
  RunRequest,
  ServerInfo,
  WhoAmI,
} from '../../../protocol/protocol.ts';

import type { AgentDetails, AgentSecurity, ApprovalModeRequest, BlockRuleRequest, AgentDetailsErrorCode } from '../../../protocol/agentDetails.ts';

export type RelayErrorCode = AppUpdateErrorCode | PersonalityErrorCode | ActivityErrorCode | import("../../../protocol/kanban.ts").KanbanErrorCode | 'kanban_unsupported' | AgentMemoryErrorCode | AgentToolsErrorCode | AgentDetailsErrorCode | AuthErrorCode | ChatErrorCode | DecisionErrorCode | RemoteErrorCode | 'pairing_required' | 'unauthorized' | 'unreachable' | 'cleartext_blocked' | 'timeout' | 'cancelled' | 'unavailable' | 'server_paused' | 'http' | 'bad_request';

export class RelayError extends Error {
  code: RelayErrorCode;
  status: number | null;
  constructor(code: RelayErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.status = status;
  }
}

export type GatewayAction = 'start' | 'stop' | 'restart';

/** What a screen needs from one server. Implemented by the bridge client and by the demo fixtures. */
export interface RelayClient extends Partial<PersonalityClient> {
  activity(query?: ActivityQuery): Promise<ActivityPage>;
  kanban?: import("./kanbanClient.ts").KanbanClient;
  downloadAppUpdate(manifest: Extract<AppUpdateManifest, { state: 'published' }>, options: AppUpdateDownloadOptions): Promise<void>;
  appUpdate(signal?: AbortSignal, onDenial?: (error: RelayError) => void): Promise<AppUpdateManifest>;
  usage(period: UsagePeriod): Promise<ServerUsage>;
  /** GET /v1/metrics, unvalidated: read it through readServerMetrics (serverMetrics.ts). */
  metrics?(): Promise<unknown>;
  boardWeb?: import("./boardWebClient.ts").BoardWebClient;
  board?(): Promise<import("../../../protocol/board.ts").BoardPage>;
  agentTools?(agentId: string): Promise<AgentTools>;
  setToolset?(agentId: string, name: string, enabled: boolean): Promise<AgentTools>;
  agentSkills?(agentId: string): Promise<AgentSkills>;
  agentMemory(agentId: string): Promise<AgentMemory>;
  changeAgentMemory(agentId: string, request: MemoryChange): Promise<AgentMemory>;
  agentSoul(agentId: string): Promise<AgentSoul>;
  changeAgentSoul(agentId: string, request: SoulChange): Promise<AgentSoul>;
  health(): Promise<Health>;
  discovery(): Promise<import('../../../protocol/discovery.ts').DiscoveryResult>;
  whoami(): Promise<WhoAmI>;
  server(): Promise<ServerInfo>;
  agents(): Promise<Agent[]>;
  agentDetails(agentId: string): Promise<AgentDetails>;
  setApprovalMode(agentId: string, request: ApprovalModeRequest): Promise<AgentSecurity>;
  changeBlockRule(agentId: string, request: BlockRuleRequest): Promise<AgentSecurity>;
  transcript(agentId: string, sessionId?: string | null): Promise<ConversationTranscript>;
  conversations(agentId: string, query?: ConversationQuery): Promise<ConversationPage>;
  conversation(agentId: string, conversationId: string): Promise<Conversation>;
  createConversation(agentId: string, request: ConversationCreateRequest): Promise<Conversation>;
  renameConversation(agentId: string, conversationId: string, request: ConversationRenameRequest): Promise<Conversation>;
  conversationDeletion(agentId: string, conversationId: string): Promise<ConversationDeletionPreview>;
  deleteConversation(agentId: string, conversationId: string, request: ConversationDeleteRequest): Promise<ConversationDeleted>;
  searchConversations(agentId: string, query: ConversationSearchQuery): Promise<ConversationSearchPage>;
  agentChat(agentId: string): Promise<AgentChatStatus>;
  steerRun(runId: string, request: SteerRequest): Promise<SteerAccepted>;
  runSnapshot(runId: string): Promise<RunSnapshot>;
  reconnectRun(runId: string): Promise<RunSnapshot>;
  models(agentId: string): Promise<ModelOptions>;
  setConversationModel(agentId: string, conversationId: string, request: ConversationModelRequest): Promise<Conversation>;
  conversationFiles(agentId: string, conversationId: string, query?: ConversationFilesQuery): Promise<ConversationFiles>;
  // The sink writes to a private local file. The client owns auth, redirect policy and byte cap.
  downloadConversationFile(agentId: string, conversationId: string, fileId: string,
    sink: (chunk: Uint8Array) => Promise<void>, signal?: AbortSignal): Promise<{ bytes: number; mimeType: string }>;
  startRun(agentId: string, req: RunRequest): Promise<RunCreated>;
  /** Resolves when the stream ends. Rejects with RelayError on transport failure. */
  runEvents(runId: string, onEvent: (e: ChatRunEvent) => void, signal?: AbortSignal, afterEventId?: number): Promise<void>;
  stopRun(runId: string): Promise<void>;
  approvals(): Promise<Approval[]>;
  serverClockOffsetMs?(): number;
  decisions(query?: DecisionQuery): Promise<DecisionHistory>;
  decide(approvalId: string, choice: ApprovalChoice): Promise<void>;
  serverControl(): Promise<import('../../../protocol/serverControl.ts').ServerControlStatus>;
  pauseServer(): Promise<import('../../../protocol/serverControl.ts').ServerControlStatus>;
  resumeServer(): Promise<import('../../../protocol/serverControl.ts').ServerControlStatus>;
  gateway(): Promise<GatewayStatus>;
  gatewayAction(action: GatewayAction): Promise<GatewayStatus>;
  doctor(): Promise<DoctorReport>;
  logs(level: LogLevel | null, lines?: number, agentId?: string): Promise<LogLine[]>;
  model(): Promise<ModelInfo>;
  jobs(): Promise<Job[]>;
  scheduledJobs(agentId: string): Promise<ScheduledJobList>;
  scheduledJob(agentId: string, jobId: string): Promise<ScheduledJob>;
  jobHistory(agentId: string, jobId: string, offset?: number): Promise<JobHistory>;
  createJob(agentId: string, input: ScheduledJobInput): Promise<ScheduledJob>;
  editJob(agentId: string, jobId: string, input: ScheduledJobInput): Promise<ScheduledJob>;
  deleteJob(agentId: string, jobId: string): Promise<{ok: true}>;
  jobAction(agentId: string, jobId: string, action: JobAction): Promise<ScheduledJob>;
}

/** Stage-two preparation has no effects until each feature owner supplies its implementation. */
export async function unavailableChat(): Promise<never> {
  throw new RelayError('unavailable', 'Esta función del chat todavía no está disponible.');
}
