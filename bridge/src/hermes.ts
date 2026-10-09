import type { ServerUsage, UsagePeriod } from '../../protocol/serverUsage.ts';
import { AGENT_TOOLS_ERROR_STATUS, type AgentToolsErrorCode } from '../../protocol/agentTools.ts';
import type { HermesAgentTools } from './agentToolsPort.ts';
// The only seam between relayd and Hermes. Everything the bridge knows about a Hermes install
// goes through this interface; tests use fakes (support/fake_hermes.ts) and never touch a real one.

import { CHAT_ERROR_STATUS, DECISION_ERROR_STATUS } from '../../protocol/protocol.ts';
import type { HermesChat, HermesMedia } from './chatPorts.ts';
import type {
  ChatErrorCode,
  DecisionErrorCode,
  DecisionRecord,
  ApprovalChoice,
  DoctorCheck,
  GatewayStatus,
  Job,
  LogLevel,
  LogLine,
  ModelInfo,
  ModelSelection,
  RunCreated,
  RunRequest,
  TranscriptItem,
} from '../../protocol/protocol.ts';

export type HermesErrorCode = AgentToolsErrorCode | ChatErrorCode | DecisionErrorCode | 'server_paused' | 'bad_request' | 'not_found' | 'conflict' | 'upstream' | 'unavailable';

export const HTTP_STATUS: Record<HermesErrorCode, number> = {
  ...CHAT_ERROR_STATUS,
  ...DECISION_ERROR_STATUS,
  server_paused: 409,
  ...AGENT_TOOLS_ERROR_STATUS,
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  upstream: 502,
  unavailable: 503,
};

// An expected failure with a message that is safe to send to the app (never contains secrets).
export class HermesError extends Error {
  code: HermesErrorCode;

  constructor(code: HermesErrorCode, message: string) {
    super(message);
    this.name = 'HermesError';
    this.code = code;
  }
}

export interface AgentProfile {
  id: string; // Hermes profile name
  name: string;
  model: string;
  provider: string;
}

export type GatewayAction = 'start' | 'stop' | 'restart';

// What the gateway says about one profile, before the bridge layers "busy" on top.
export type ProfileState = 'on' | 'err' | 'off';

export interface ChatStatus {
  available: boolean;
  reason: string | null;
}

// One event of Hermes's `GET /v1/runs/{id}/events` stream, as sent: `event` is the name, `seq`
// the upstream sequence number (used to resume), the rest is the event's own payload.
export interface UpstreamEvent {
  event: string;
  seq: number | null;
  [field: string]: unknown;
}

export interface UpstreamRunStatus {
  status: string; // queued | running | waiting_for_approval | stopping | completed | failed | cancelled | interrupted
  output: string | null;
  error: string | null;
  pendingSteer?: string;
  runtime?: ModelSelection;
}

export interface Transcript {
  sessionId: string | null;
  items: TranscriptItem[];
}

export interface Hermes extends HermesChat {
  readonly details?: import('./agentDetailsPorts.ts').HermesAgentDetails;
  readonly boardWeb?: import("./boardWebReader.ts").HermesBoardWeb;
  readonly board?: import("./board.ts").HermesBoard;
  readonly serverControl?: import('../../protocol/serverControl.ts').HermesServerControl;
  readonly agentTools?: HermesAgentTools;
  readonly memory?: import('./agentMemory.ts').HermesMemory;
  readonly jobsManager?: import('./jobsManager.ts').JobsManager;
  readonly media: HermesMedia;
  decisionHistory(profile: string): Promise<DecisionRecord[]>;
  usage?(period: UsagePeriod): Promise<ServerUsage>;
  version(): Promise<string>;
  profiles(): Promise<AgentProfile[]>;
  profileStates(ids: string[]): Promise<Record<string, ProfileState>>;
  lastMessage(profile: string): Promise<{ text: string; at: number } | null>;
  transcript(profile: string, sessionId: string | null): Promise<Transcript>;

  gateway(): Promise<GatewayStatus>;
  gatewayAction(action: GatewayAction): Promise<void>;
  doctor(): Promise<DoctorCheck[]>;
  logs(query: { level: LogLevel; lines: number; agentId?: string }): Promise<LogLine[]>;
  model(): Promise<ModelInfo>;
  jobs(): Promise<Job[]>;

  // Everything below needs the Hermes API server; it throws HermesError('unavailable') when off.
  chat(profile?: string): Promise<ChatStatus>;
  approvalTimeoutSeconds(profile: string): Promise<number>;
  createRun(profile: string, request: RunRequest): Promise<RunCreated>;
  runEvents(
    profile: string,
    runId: string,
    afterSeq: number | null,
    signal: AbortSignal,
  ): AsyncIterable<UpstreamEvent>;
  runStatus(profile: string, runId: string): Promise<UpstreamRunStatus | null>;
  stopRun(profile: string, runId: string): Promise<void>;
  resolveApproval(
    profile: string,
    runId: string,
    choice: ApprovalChoice,
    requestId: string | null,
  ): Promise<void>;
}

export async function unavailableChatPort(): Promise<never> {
  throw new HermesError('unavailable', 'Chat capability is not implemented.');
}
