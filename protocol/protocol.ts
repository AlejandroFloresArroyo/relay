// Shared Relay wire contract. Types and side-effect-free constants only. No platform imports.
// Authentication: paired device bearer keys, except GET /health, GET /v1/whoami and POST /v1/pair
// (plus CORS preflight).

export interface ApiError {
  error: { code: string; message: string };
}

// Protocol generations are independent of the app and bridge product versions.
export const PROTOCOL_VERSION = 2;
export const MIN_BRIDGE_PROTOCOL_VERSION = 2;
export const MIN_APP_PROTOCOL_VERSION = 2;

export const PAIRING_QR_TYPE = 'relay-pair';
export const PAIRING_QR_VERSION = 1;
export const PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_LENGTH = 10;
export const PAIRING_TTL_MS = 300_000;
export const DEVICE_KEY_PREFIX = 'rly1_';
export const DEVICE_KEY_BYTES = 32;

export const AUTH_FAILURE_WINDOW_MS = 60_000;
export const AUTH_FAILURE_LIMIT = 5;
export const AUTH_PENALTY_MS = 300_000;

export const AUTH_ERROR_CODES = {
  pairingInvalid: 'pairing_invalid',
  keyUnknown: 'key_unknown',
  deviceRevoked: 'device_revoked',
  rateLimited: 'rate_limited',
  tailnetRequired: 'tailnet_required',
} as const;

export type AuthErrorCode =
  (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

export const AUTH_ERROR_STATUS = {
  pairing_invalid: 401,
  key_unknown: 401,
  device_revoked: 403,
  rate_limited: 429,
  tailnet_required: 403,
} as const satisfies Record<AuthErrorCode, number>;

export interface AuthApiError {
  error: { code: AuthErrorCode; message: string };
}

// All numeric timestamps in this protocol are Unix epoch milliseconds.
export interface PairedDevice {
  id: string;
  name: string;
  pairedAt: number;
  revokedAt: number | null;
}

export interface PairingQrPayload {
  type: typeof PAIRING_QR_TYPE;
  version: typeof PAIRING_QR_VERSION;
  url: string;
  code: string;
}

// POST /v1/pair, no bearer. Response: 201; never cached.
export interface PairingRequest {
  code: string;
}

export interface PairingResponse {
  deviceKey: string;
  device: PairedDevice & { revokedAt: null };
  server: { name: string };
}

// Optional on the wire only because old bridges did not declare compatibility.
export interface ProtocolAdvertisement {
  protocolVersion?: number;
  minAppProtocolVersion?: number;
}

// An omitted resolution on a legacy event is unknown, never inferred as expiry.
export type ApprovalResolution = 'decision' | 'expired';

// GET /health, no auth. New bridges always emit both protocol fields and `capabilities`.
export interface Health extends ProtocolAdvertisement {
  ok: true;
  service: 'relayd';
  version: string;
  /** V3 remote tools (ADR 0006). Absent on older bridges, which then have no capability at all. */
  capabilities?: Partial<Record<string, CapabilityAdvertisement>>;
}

// GET /v1/whoami (no auth) — who the caller is on the tailnet, from `tailscale whois`.
export interface WhoAmI {
  tailscale: boolean;
  device: string | null; // "iphone-dev"
  ip: string | null; // "100.84.12.7"
  tailnet: string | null; // "tail0a1b2c.ts.net"
}

// GET /v1/server
export interface ServerInfo {
  host: string; // machine hostname, e.g. "arch"
  hermesVersion: string; // "0.21.5"
  profiles: number;
  // Chat and approvals need the Hermes API server (API_SERVER_ENABLED). When it is off the
  // rest of the bridge still works and the app shows why chat is unavailable.
  chat: { available: boolean; reason: string | null };
}

export type AgentStatus = 'on' | 'busy' | 'err' | 'off';

// GET /v1/agents -> { agents: Agent[] }. One agent per Hermes profile.
export interface Agent {
  id: string; // Hermes profile name ("default", "coding")
  name: string;
  model: string; // "deepseek-v4.1-flash"
  provider: string; // "opencode-go"
  status: AgentStatus;
  pendingApprovals: number;
  lastMessage: { text: string; at: number } | null; // at = epoch ms
}

export type ToolStatus = 'running' | 'done' | 'error' | 'waiting';

// GET /v1/agents/:id/transcript -> { sessionId: string | null; items: TranscriptItem[] }
export type TranscriptItem =
  | { kind: 'user'; id: string; text: string; at: number;
      runId?: string; clientMessageId?: string; attachmentIds?: string[]; redirected?: boolean }
  | { kind: 'assistant'; id: string; text: string; at: number;
      runId?: string; runtime?: ModelSelection | null }
  | {
      kind: 'tool';
      id: string;
      tool: string; // Hermes tool name: "terminal", "read_file", "patch", "web_search", ...
      preview: string; // short argument preview ("npm test -- integration")
      status: ToolStatus;
      durationSeconds: number | null;
      result: string | null; // result preview; Hermes truncates it to 500 chars
      cwd?: string | null; // working directory, when known (Hermes events do not carry it)
      at: number;
    };

// POST /v1/agents/:id/runs  body: RunRequest -> RunCreated
export interface RunRequest {
  input: string;
  sessionId?: string | null;
}
export interface RunCreated {
  runId: string;
  sessionId: string | null;
}

// GET /v1/runs/:runId/events — text/event-stream. Each SSE `data:` line is one RunEvent.
export type RunEvent =
  | { type: 'message.delta'; text: string }
  | { type: 'tool.started'; toolCallId: string; tool: string; preview: string }
  | {
      type: 'tool.completed';
      toolCallId: string;
      tool: string;
      durationSeconds: number;
      error: boolean;
      preview: string;
    }
  | { type: 'approval.request'; approval: Approval }
  | {
      type: 'approval.resolved';
      approvalId: string;
      choice: ApprovalChoice;
      resolution?: ApprovalResolution;
    }
  | { type: 'run.completed'; output: string }
  | { type: 'run.failed'; error: string }
  | { type: 'run.cancelled' };

// POST /v1/runs/:runId/stop -> { ok: true }

export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny';

// GET /v1/approvals -> { approvals: Approval[] } (pending only, oldest first)
// POST /v1/approvals/:id  body: { choice: ApprovalChoice } -> { ok: true }
export interface Approval {
  id: string;
  runId: string;
  agentId: string;
  agentName: string;
  command: string;
  cwd: string | null;
  // Hermes only sends the flagged command and a pattern description. `reason` and `affects`
  // stay null unless the bridge can really derive them; the app hides those rows when null.
  reason: string | null;
  affects: string | null;
  risk: { level: 1 | 2 | 3 | 4 | 5; label: string; summary: string } | null;
  createdAt: number; // epoch ms
  expiresAt: number | null; // epoch ms
  choices: ApprovalChoice[];
}

// GET /v1/gateway -> GatewayStatus
// POST /v1/gateway/:action  (action = start | stop | restart) -> GatewayStatus
export interface GatewayStatus {
  state: 'active' | 'stopped' | 'unknown';
  pid: number | null;
  uptimeSeconds: number | null;
  port: number | null; // Hermes API server port when enabled
}

// POST /v1/doctor -> DoctorReport
export interface DoctorCheck {
  label: string;
  value: string;
  ok: boolean;
}
export interface DoctorReport {
  ranAt: number;
  checks: DoctorCheck[];
}

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

// GET /v1/logs?level=INFO|WARN|ERROR&lines=100 -> { lines: LogLine[] } (oldest first)
export interface LogLine {
  t: string; // "09:40:58"
  level: LogLevel;
  msg: string;
}

// GET /v1/model -> ModelInfo
export interface ModelInfo {
  model: string;
  provider: string;
}

// GET /v1/jobs -> { jobs: Job[] }
export interface Job {
  id: string;
  name: string;
  cron: string; // "0 9 * * 1-5"
  agent: string;
  nextRunAt: number | null; // epoch ms; null when paused
  enabled: boolean;
}

// Stage 2. All timestamps remain Unix epoch milliseconds.
export const CHAT_PROTOCOL_HEADER = 'X-Relay-Protocol';
export const CONVERSATION_TITLE_MAX_CHARS = 100;
export const CONVERSATION_QUERY_MAX_CHARS = 200;
export const CHAT_INPUT_MAX_BYTES = 64_000;
export const CHAT_REQUEST_MAX_BYTES = 9_000_000;
export const CHAT_IMAGE_MAX_BYTES = 2_000_000;
export const CHAT_IMAGE_MAX_COUNT = 1;
export const CHAT_IMAGE_MAX_EDGE = 1600;
export const AGENT_FILE_MAX_BYTES = 50_000_000;
export const DICTATION_LOCALE = 'es-US';
export const DICTATION_TAIL_MS = 1000;

export const CHAT_ERROR_STATUS = {
  invalid_request: 400,
  invalid_title: 400,
  invalid_query: 400,
  invalid_image: 400,
  invalid_steer_input: 400,
  model_not_configured: 400,
  conversation_read_only: 403,
  file_blocked: 403,
  conversation_not_found: 404,
  run_not_found: 404,
  file_not_found: 404,
  file_ticket_expired: 404,
  conversation_busy: 409,
  conversation_changed: 409,
  request_conflict: 409,
  run_not_accepting_steer: 409,
  steer_not_accepted: 409,
  file_missing: 410,
  stream_replay_lost: 410,
  image_too_large: 413,
  file_too_large: 413,
  protocol_upgrade_required: 426,
  chat_unavailable: 503,
  conversation_store_unavailable: 503,
  media_validation_unavailable: 503,
  operation_uncertain: 503,
  upstream_failure: 502,
} as const;
export type ChatErrorCode = keyof typeof CHAT_ERROR_STATUS;
export interface ChatApiError {
  error: { code: ChatErrorCode; message: string };
}

export interface ModelSelection {
  provider: string;
  model: string;
}
export interface ModelOption extends ModelSelection {
  label: string;
}
// GET /v1/agents/:agentId/models
export interface ModelOptions {
  models: ModelOption[];
  defaultModel: ModelSelection;
}

export type ConversationKind = 'interactive' | 'background';
export interface Conversation {
  id: string;
  sessionId: string;
  title: string | null;
  source: string;
  origin: 'relay' | 'external';
  originLabel: string;
  kind: ConversationKind;
  writable: boolean;
  archived: boolean;
  hidden: boolean;
  state: 'ready' | 'deleting';
  startedAt: number;
  lastActiveAt: number;
  messageCount: number;
  preview: string | null;
  // Null uses the Agent default; it is not the model that actually served a Turn.
  model: ModelSelection | null;
}
// GET /v1/agents/:agentId/conversations
// GET /v1/agents/:agentId/conversations/:conversationId -> Conversation
export interface ConversationQuery {
  background?: boolean;
  limit?: number;
  offset?: number;
}
export interface ConversationPage {
  conversations: Conversation[];
  nextOffset: number | null;
}
// POST /v1/agents/:agentId/conversations -> 201 Conversation
export interface ConversationCreateRequest {
  requestId: string;
}
// PATCH /v1/agents/:agentId/conversations/:conversationId -> Conversation
export interface ConversationRenameRequest {
  title: string;
}
// GET /v1/agents/:agentId/conversations/:conversationId/deletion
export interface ConversationDeletionPreview {
  conversationId: string;
  messageCount: number;
  conversationCount: number;
  revision: string;
}
// DELETE /v1/agents/:agentId/conversations/:conversationId
export interface ConversationDeleteRequest {
  revision: string;
}
export interface ConversationDeleted {
  conversationId: string;
  deleted: true;
  messageCount: number;
}
// GET /v1/agents/:agentId/conversations/search?q=...&background=false&limit=50&offset=0
export interface ConversationSearchQuery extends ConversationQuery {
  q: string;
}
export interface ConversationSearchHit {
  conversation: Conversation;
  match: 'title' | 'message';
  messageId: string | null;
  snippet: string;
}
export interface ConversationSearchPage {
  hits: ConversationSearchHit[];
  nextOffset: number | null;
}
// Existing GET /v1/agents/:agentId/transcript?sessionId=... gains optional metadata.
export interface ConversationTranscript {
  sessionId: string | null;
  items: TranscriptItem[];
  conversation?: Conversation | null;
}
// PUT /v1/agents/:agentId/conversations/:conversationId/model -> Conversation
export interface ConversationModelRequest {
  model: ModelSelection | null;
}
// GET /v1/agents/:agentId/chat
export interface AgentChatStatus {
  available: boolean;
  reason: string | null;
}

export type ChatImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp';
export interface ChatImage {
  attachmentId: string;
  mimeType: ChatImageMimeType;
  dataBase64: string;
  width: number;
  height: number;
}
/** A Servidor file attached by reference: the absolute canonical path Archivos lists. No content crosses. */
export interface ChatFileReference { path: string }
/** Not a remote tool: no X-Relay-Capability header, not in RemoteStatus. Advertised iff Archivos is wired. */
export const CHAT_FILES_CAPABILITY_NAME = 'chat_files';
export const CHAT_FILE_MAX_COUNT = 5;
export interface RunRequest {
  clientMessageId?: string;
  images?: ChatImage[];
  /** Sent only when the Puente advertises `chat_files`; an older one refuses the key. */
  files?: ChatFileReference[];
}
export interface RunCreated {
  conversationId?: string;
  clientMessageId?: string;
  inputMessageId?: string | null;
}
export type RunPhase =
  | 'queued' | 'running' | 'waiting_for_approval' | 'stopping'
  | 'completed' | 'failed' | 'cancelled' | 'unknown';
export type RunConnection = 'connected' | 'reconnecting' | 'lost';
export interface RunTerminalMetadata {
  runtime?: ModelSelection | null;
  pendingSteer?: string | null;
}
export type ChatRunTerminal = RunTerminalMetadata & (
  | { type: 'run.completed'; output: string }
  | { type: 'run.failed'; error: string }
  | { type: 'run.cancelled' }
);
export interface SteerRequest {
  requestId: string;
  input: string;
}
// POST /v1/runs/:runId/steer -> 200 SteerAccepted
export interface SteerAccepted {
  runId: string;
  requestId: string;
  accepted: true;
  // Accepted by Hermes's in-memory queue, not proof the instruction was consumed.
}
export interface SteerReceipt {
  requestId: string;
  // Unknown includes an in-flight request or a lost receipt. Retrying the same identity
  // never performs another upstream write; only accepted is proof of queue admission.
  status: 'accepted' | 'rejected' | 'unknown';
}
export type ChatRunEvent =
  | Exclude<RunEvent, { type: 'run.completed' | 'run.failed' | 'run.cancelled' }>
  | ChatRunTerminal
  | { type: 'run.steered'; requestId: string; accepted: true }
  | { type: 'run.steer_pending'; text: string }
  | { type: 'run.connection'; connection: RunConnection }
  | { type: 'run.resync_required'; reason: 'upstream_replay_lost' | 'snapshot_limit' }
  | { type: 'run.input'; clientMessageId: string; messageId: string; sessionId: string };
// GET /v1/runs/:runId
export interface RunSnapshot {
  runId: string;
  conversationId: string;
  sessionId: string;
  phase: RunPhase;
  connection: RunConnection;
  // -1 before the first event; omit Last-Event-ID when resuming this empty cursor.
  lastEventId: number;
  // This Turn only, materialized at lastEventId. Not a fresh asynchronous DB transcript.
  items: TranscriptItem[];
  // False preserves known partial items but cannot prove missing upstream events were recovered.
  complete: boolean;
  steers: SteerReceipt[];
  terminal: ChatRunTerminal | null;
}
// POST /v1/runs/:runId/reconnect -> RunSnapshot
// GET /v1/runs/:runId/events still uses SSE id: <monotonic integer> and JSON data: ChatRunEvent.

export type ConversationFileStatus = 'ready' | 'too_large' | 'missing' | 'blocked';
export interface ConversationFile {
  id: string;
  messageId: string;
  name: string;
  mimeType: string;
  size: number | null;
  status: ConversationFileStatus;
}
// GET /v1/agents/:agentId/conversations/:conversationId/files
export interface ConversationFilesQuery {
  messageId?: string;
  limit?: number;
  offset?: number;
}
export interface ConversationFiles {
  files: ConversationFile[];
  // Display text returned by Hermes's extractor, bound to the exact assistant message.
  displayMessages?: { messageId: string; text: string }[];
  nextOffset: number | null;
}
// GET /v1/agents/:agentId/conversations/:conversationId/files/:fileId
// Binary attachment. No path parameter, redirects, bearer in URL, or JSON/base64 envelope.

// Decision history is additive to protocol 2. Imported results do not prove consent time.
export type DecisionErrorCode = 'decision_store_unavailable' | 'decision_store_full' | 'decision_history_unavailable' | 'invalid_decision_query' | 'decision_uncertain';
export const DECISION_ERROR_STATUS = { decision_store_full: 503, decision_uncertain: 409, decision_store_unavailable: 503, decision_history_unavailable: 503, invalid_decision_query: 400 } as const satisfies Record<DecisionErrorCode, number>;
export const DECISION_HISTORY_LIMIT = 100;
export const DECISION_COMMAND_PREVIEW_LENGTH = 512;
export interface DecisionRecord {
  id: string; agentId: string; agentName: string; sessionId: string; runId: string | null;
  approvalId: string | null; toolCallId: string | null; command: string;
  /** Display-only preview; never used for an approval choice or durable consent identity. */
  commandTruncated?: boolean;
  actor: 'person' | 'guardian' | 'unknown' | 'expired';
  outcome: 'approved' | 'rejected' | 'expired' | 'executed';
  choice: ApprovalChoice | null; at: number; timeKind: 'decision' | 'result';
  origin: 'relay' | 'other'; source: string; originLabel: string;
}
export interface DecisionQuery { agentId?: string; origin?: 'relay' | 'other'; }
export interface DecisionAttempt { id:string; agentId:string; agentName:string; command:string; choice:ApprovalChoice; at:number; origin:'relay'; }
export interface DecisionHistory { decisions: DecisionRecord[]; capturedAt: number; uncertain?: DecisionAttempt[];
  /** Optional for protocol-2 legacy Bridges. Counts confirmed records matching the server query. */
  window?: { limit: number; total: number };
}

// ---- V3 remote tools (docs/adr/0006-capacidades-remotas-v3.md) ------------------------------
// Each tool is an additive capability with its own version, negotiated apart from
// PROTOCOL_VERSION. Per-tool contracts live in protocol/remote<Tool>.ts, created by each tool's task.

export type RemoteCapabilityName = 'environments' | 'terminal' | 'files' | 'web' | 'browser';
export const REMOTE_CAPABILITY_NAMES: readonly RemoteCapabilityName[] = ['environments', 'terminal', 'files', 'web', 'browser'];
/** Same rules as the protocol advertisement: non-negative safe integers, minAppVersion <= version. */
export interface CapabilityAdvertisement { version: number; minAppVersion: number }
/** Every /v1/remote/* request: `<name>/<negotiated version>`, besides X-Relay-Protocol and the key. */
export const REMOTE_CAPABILITY_HEADER = 'X-Relay-Capability';

export type RemoteUnavailableReason =
  | 'helper_missing' | 'helper_stopped' | 'helper_incompatible' | 'dependency_missing'
  | 'not_configured' | 'unsupported_platform'
  | 'not_reported'; // only produced by the app: advertised but absent from RemoteStatus
export type ToolAvailability = { state: 'available' } | { state: 'unavailable'; reason: RemoteUnavailableReason };
// GET /v1/remote/status, authenticated: what this machine has installed. Never in /health.
export interface RemoteStatus {
  serverNow: number;
  terminal?: ToolAvailability;
  files?: ToolAvailability;
  web?: { inRelay: ToolAvailability; external: ToolAvailability };
  browser?: { dedicated: ToolAvailability; habitual: ToolAvailability };
}

// ---- Machine metrics (Relay 3.1, docs/relay-v3.1.md «capacidad `metrics`») ----------------------
// Additive like the V3 capabilities: advertised in Health.capabilities with its own version and
// minAppVersion, without changing PROTOCOL_VERSION. It is no remote tool: not in RemoteStatus, not
// under /v1/remote/*, no X-Relay-Capability.
export const METRICS_CAPABILITY_NAME = 'metrics';
/** GET /v1/metrics, with the key and X-Relay-Protocol like the other /v1 reads. One reading of the whole machine. */
export interface ServerMetrics {
  /** Non-idle share of all CPUs between two samples, 0–100. */
  cpuPercent: number;
  /** (MemTotal − MemAvailable) / MemTotal, 0–100: the cache does not count as used. */
  memoryPercent: number;
  /** used / (used + available) of the filesystem that holds the Hermes directory, 0–100, like `df`. */
  diskPercent: number;
  /** Milliseconds on the Server's clock, the unit of serverNow. */
  measuredAt: number;
}

// IDs are generated by the Puente: random, >= 128 bits, base64url, with a type prefix. Never derived
// from a PID, path, port or time. The app keys them by Server: the same ID on two Servers differs.
export const REMOTE_ID_PREFIXES = { environment: 'env_', terminal: 'term_', operation: 'op_', app: 'app_', access: 'acc_' } as const;
export const REMOTE_ID_PATTERN = '^(env|term|op|app|acc)_[A-Za-z0-9_-]{22,64}$';
/** Client idempotency key of every creation, same format as clientMessageId. */
export const REMOTE_REQUEST_ID_PATTERN = '^[A-Za-z0-9_-]{8,128}$';

export type EnvironmentKind = 'terminal' | 'browser_dedicated' | 'browser_habitual';
/** 'shared' only for a connection to existing work: terminating disconnects and keeps that work. */
export type Ownership = 'own' | 'shared';
/** Recovery is listing again and reconnecting by ID; the Puente never creates a replacement. */
export type EnvironmentState = 'starting' | 'running' | 'terminating' | 'exited' | 'lost';
export interface RemoteEnvironment {
  id: string; kind: EnvironmentKind; ownership: Ownership; createdAt: number;
  state: EnvironmentState; exitCode?: number | null; endedAt?: number | null;
  terminationError?: 'supervisor_unreachable' | 'processes_remaining'; // only while 'terminating'
  /** Only for kind 'terminal': what it was opened with (protocol/remoteTerminal.ts). */
  terminal?: { shell: string; cwd: string };
}
/** POST /v1/remote/environments: the same requestId answers the same environment, never another.
 *  A terminal also carries `shell` and `cwd` (TerminalCreateRequest in protocol/remoteTerminal.ts). */
export interface RemoteEnvironmentCreateRequest { requestId: string; kind: EnvironmentKind }
/** GET /v1/remote/environments: only the device's own, oldest first. DELETE …/:id discards an ended one. */
export interface RemoteEnvironmentList { environments: RemoteEnvironment[] }
/** POST /v1/remote/environments/:id/terminate: idempotent, answers the real final state. */
export interface RemoteTerminateRequest { confirm: true }

// Continuous channels (terminal output, browser frames, search results): `seq` starts at 1 per
// stream and grows by one per frame; a terminal's stream is its output, across reconnections. The
// client acks the last seq received and sends it again on reconnect; what the Puente no longer holds
// arrives as a gap, never as apparent continuity. A transfer needs no channel: each chunk is a
// request whose offset plays the seq and whose answer the ack, one at a time (protocol/remoteFiles.ts).
export interface RemoteChannelAck { type: 'ack'; seq: number }
/** Inclusive range of seqs that will never be delivered. */
export interface RemoteChannelGap { type: 'gap'; from: number; to: number }

// Long operations (search, transfer): POST /v1/remote/operations/:id/cancel is idempotent and
// answers what really happened, so an operation that finished first stays 'completed'.
// Closing a terminal or browser channel disconnects; it never cancels nor terminates.
export type RemoteOperationState = 'running' | 'completed' | 'cancelled' | 'failed';
export interface RemoteOperation { id: string; state: RemoteOperationState }

// remote_conflict means the version a client read changed, so overwriting with `confirm` is a way
// out. What has no such way out has its own code (review N4): an existing destination, a file Relay
// cannot replace without changing its identity, a Hermes profile, the Puente's own state, another
// filesystem, a full disk.
export type RemoteErrorCode =
  | 'remote_invalid_request' | 'remote_upgrade_required' | 'remote_unavailable' | 'remote_not_found'
  | 'remote_ended' | 'remote_conflict' | 'remote_confirmation_required' | 'remote_permission_denied'
  | 'remote_limit_reached' | 'remote_too_large' | 'remote_cancelled'
  | 'remote_exists' | 'remote_not_replaceable' | 'remote_profile_protected' | 'remote_bridge_protected' | 'remote_cross_device' | 'remote_no_space'
  | 'remote_unsupported' | 'remote_browser_limited';
export const REMOTE_ERROR_STATUS = {
  remote_invalid_request: 400, remote_upgrade_required: 426, remote_unavailable: 503, remote_not_found: 404,
  remote_ended: 410, remote_conflict: 409, remote_confirmation_required: 428, remote_permission_denied: 403,
  remote_limit_reached: 429, remote_too_large: 413, remote_cancelled: 409,
  remote_exists: 409, remote_not_replaceable: 409, remote_profile_protected: 403, remote_bridge_protected: 403, remote_cross_device: 422, remote_no_space: 507,
  remote_unsupported: 422, remote_browser_limited: 409,
} as const satisfies Record<RemoteErrorCode, number>;
/** Fixed texts: an fs or process err.message carries paths and never reaches a client or a log. */
export const REMOTE_ERROR_MESSAGES = {
  remote_invalid_request: 'La solicitud a la herramienta remota no es válida.',
  remote_upgrade_required: 'Esta herramienta necesita otra versión de Relay o del Puente.',
  remote_unavailable: 'Esta herramienta no está disponible en este Servidor.',
  remote_not_found: 'No existe en este Servidor.',
  remote_ended: 'Ya terminó.',
  remote_conflict: 'Cambió en el Servidor. Vuelve a cargarlo antes de seguir.',
  remote_confirmation_required: 'Esta acción necesita tu confirmación.',
  remote_permission_denied: 'La cuenta del Servidor no tiene permiso para esta operación. Hazla en la computadora.',
  remote_limit_reached: 'Se alcanzó un límite de Relay en este Servidor.',
  remote_too_large: 'Supera el tamaño que admite Relay.',
  remote_cancelled: 'La operación se canceló.',
  remote_exists: 'Ya hay algo con ese nombre en el destino.',
  remote_not_replaceable: 'Relay no puede reemplazar este archivo sin cambiar su identidad: tiene otros enlaces o es de otra cuenta. Hazlo en la computadora.',
  remote_profile_protected: 'Relay protege los perfiles de Hermes. Haz este cambio en la computadora.',
  remote_bridge_protected: 'Relay protege los datos del Puente. Haz este cambio en la computadora.',
  remote_cross_device: 'Relay no mueve entre sistemas de archivos distintos. Hazlo en la computadora.',
  remote_no_space: 'No queda espacio en el Servidor para esta operación.',
  // What this browser mode or browser cannot do (#92, #93): explicit, never a silent no-op.
  remote_unsupported: 'Relay no puede hacer esto en este navegador o en esta página.',
  // The tab's limitation (protocol/remoteBrowser.ts) says which and how to solve it.
  remote_browser_limited: 'El navegador no deja controlar esta pestaña desde Relay.',
} as const satisfies Record<RemoteErrorCode, string>;

/** Initial values. A validation may lower one and records it in ADR 0006; raising needs pressure tests. */
export const REMOTE_LIMITS = {
  controlBodyBytes: 65_536, terminalFrameBytes: 65_536, channelWindowBytes: 1_048_576,
  // Lowered by #78: frames are at most 700 000 decoded JPEG bytes (docs/research/v3-cdp.md).
  terminalRingBytes: 2_097_152, browserFrameBytes: 700_000, editableTextBytes: 5_242_880,
  transferChunkBytes: 1_048_576, liveEnvironmentsPerDevice: 16, liveEnvironmentsTotal: 64,
  endedEnvironmentsPerDevice: 64, stalledChannelMs: 30_000, terminateGraceMs: 5_000,
  terminateGiveUpMs: 10_000, terminateRetryMs: 30_000,
} as const;
