import { createPersonalityClient } from './personalityPresetsClient.ts';
import { createBoardWebClient } from './boardWebClient.ts';
import { BOARD_WEB_HEADER, BOARD_WEB_VERSION } from '../../../protocol/boardWeb.ts';
import { activityQueryPath } from './activity.ts';
import { readActivityResponse } from './activityTransport.ts';
import { createKanbanClient } from './kanbanClient.ts';
import { parseAppUpdateManifest } from './appUpdate.ts';
import { readAppUpdateMetadata, streamAppUpdate } from './appUpdateTransport.ts';
import type { AgentDetails, AgentSecurity } from '../../../protocol/agentDetails.ts';
import { AGENT_DETAILS_ERROR_STATUS } from '../../../protocol/agentDetails.ts';
import { AGENT_FILE_MAX_BYTES, CHAT_ERROR_STATUS, DECISION_ERROR_STATUS, CHAT_PROTOCOL_HEADER, PROTOCOL_VERSION, REMOTE_ERROR_MESSAGES, type RemoteErrorCode } from '../../../protocol/protocol.ts';
import type { ServerUsage } from '../../../protocol/serverUsage.ts';
import { validServerUsage } from './serverUsage.ts';
import type { ServerControlStatus } from '../../../protocol/serverControl.ts';
import { AGENT_TOOLS_ERROR_MESSAGES, AGENT_TOOLS_ERROR_STATUS } from '../../../protocol/agentTools.ts';
import { isAgentTools } from './agentTools.ts';
import type { AgentTools, AgentSkills } from '../../../protocol/agentTools.ts';
import { AGENT_MEMORY_ERROR_STATUS, AGENT_MEMORY_MESSAGES, AGENT_MEMORY_REQUEST_MAX_BYTES, AGENT_MEMORY_RESPONSE_MAX_BYTES } from '../../../protocol/agentMemory.ts';
import type { AgentMemoryErrorCode } from '../../../protocol/agentMemory.ts';
import { isAgentMemory, isAgentSoul, utf8Bytes } from './agentMemory.ts';
import type { ScheduledJob, ScheduledJobList, JobHistory } from '../../../protocol/scheduledJobs.ts';
import type {
  Agent,
  Approval,
  DoctorReport,
  GatewayStatus,
  Health,
  Job,
  LogLine,
  ModelInfo,
  ModelOptions,
  RunCreated,
  ChatRunEvent,
  AgentChatStatus,
  SteerAccepted,
  RunSnapshot,
  ServerInfo,
  ConversationTranscript,
  Conversation,
  ConversationPage,
  ConversationQuery,
  ConversationDeletionPreview,
  ConversationDeleted,
  ConversationSearchPage,
  ConversationFiles,
  WhoAmI,
} from '../../../protocol/protocol.ts';
import { RelayError, unavailableChat, type RelayClient } from './client.ts';
import { readDecisionHistoryResponse } from './decisionHistoryTransport.ts';
import { createSseDecoder } from './sse.ts';
import { validateServerAddress } from './pairing.ts';

export interface BridgeClientOptions {
  baseUrl: string;
  key: string;
  /** Injected so tests use a fake and the app uses `expo/fetch` (needed for streaming on native). */
  fetch: typeof fetch;
  timeoutMs?: number;
  /** Set by the paired-server adapter; direct transport callers retain their existing contract. */
  pairingRequired?: boolean;
  /** Invalid persisted origins are kept for recovery but may never reach the transport. */
  invalidOrigin?: boolean;
}

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^[a-z]+:\/\//i.test(trimmed)) return trimmed;
  // No scheme given: a tailnet name means the bridge's plain HTTP (WireGuard encrypts the hop);
  // anything else gets https, which is the only thing Android would let through anyway.
  let host = '';
  try { host = new URL(`https://${trimmed}`).hostname.toLowerCase(); }
  catch { /* Pairing validation rejects malformed addresses before transport. */ }
  return `${host.endsWith('.ts.net') ? 'http' : 'https'}://${trimmed}`;
}

// OkHttp's refusal when Android's network security config forbids http:// to the host. expo/fetch
// passes it on as "fetch failed: java.net.UnknownServiceException: CLEARTEXT communication to <host>
// not permitted by network security policy". Nothing leaves the phone, so it is not "unreachable".
const CLEARTEXT_BLOCK = /CLEARTEXT communication to .+ not permitted/i;

function networkFailure(e: unknown, fallback: string): RelayError {
  const message = e instanceof Error ? e.message : fallback;
  if (CLEARTEXT_BLOCK.test(message)) return new RelayError('cleartext_blocked', 'Android bloquea http:// fuera de *.ts.net');
  return new RelayError('unreachable', message);
}

export function createBridgeClient(opts: BridgeClientOptions): RelayClient {
  const base = normalizeBaseUrl(opts.baseUrl);
  const timeoutMs = opts.timeoutMs ?? 5000;
  // Pulled out of `opts` on purpose: `opts.fetch(...)` would pass `opts` as `this`, and the
  // browser's fetch rejects any receiver other than the window with "Illegal invocation".
  const doFetch = opts.fetch;

  async function request(method: string, path: string, body?: unknown, auth = true, chat = false, deferErrors = false, extraHeaders: Record<string, string> = {}, externalSignal?: AbortSignal, onLateDenial?: (error: RelayError) => void): Promise<Response> {
    if (opts.invalidOrigin) throw new RelayError('bad_request', 'Corrige la dirección del Servidor antes de conectar');
    if (auth && opts.pairingRequired) throw new RelayError('pairing_required', 'Empareja este teléfono de nuevo');
    if (externalSignal?.aborted) throw new RelayError('cancelled', 'Descarga cancelada.');
    const ctrl = new AbortController();
    const forwardAbort = () => ctrl.abort();
    externalSignal?.addEventListener('abort', forwardAbort, { once: true });
    let abortRequest: (() => void) | undefined;
    const requestTimeout = path === '/v1/discovery' ? Math.max(timeoutMs, 15000) : timeoutMs;
    const timer = setTimeout(() => ctrl.abort(), requestTimeout);
    let res: Response;
    try {
      const fetching = doFetch(`${base}${path}`, {
        method,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          ...extraHeaders,
          ...(auth ? { Authorization: `Bearer ${opts.key}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(chat ? { [CHAT_PROTOCOL_HEADER]: String(PROTOCOL_VERSION) } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const scopedFetching = externalSignal ? fetching.then(response => {
        if (ctrl.signal.aborted) {
          // Cancellation retires a view, never a known denial of this paired client.
          if ([401, 403, 426].includes(response.status)) onLateDenial?.(new RelayError(response.status === 426 ? 'protocol_upgrade_required' : 'unauthorized', 'El Puente rechazó esta identidad.', response.status));
          void response.body?.cancel?.().catch(() => {});
          throw new RelayError(externalSignal.aborted ? 'cancelled' : 'timeout', 'La consulta fue interrumpida.');
        }
        return response;
      }) : fetching;
      res = externalSignal ? await Promise.race([scopedFetching, new Promise<never>((_, reject) => {
        abortRequest = () => reject(new RelayError(externalSignal.aborted ? 'cancelled' : 'timeout', 'La consulta fue interrumpida.'));
        ctrl.signal.addEventListener('abort', abortRequest, { once: true });
        if (ctrl.signal.aborted) abortRequest();
      })]) : await scopedFetching;
    } catch (e) {
      if (externalSignal?.aborted) throw new RelayError('cancelled', 'Descarga cancelada.');
      if (ctrl.signal.aborted) throw new RelayError('timeout', `Sin respuesta en ${requestTimeout / 1000} s`);
      throw networkFailure(e, 'network error');
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', forwardAbort);
      if (abortRequest) ctrl.signal.removeEventListener('abort', abortRequest);
    }
    if (!res.ok && !deferErrors) throw await responseError(res);
    return res;
  }

  const json = async <T>(method: string, path: string, body?: unknown, auth = true, chat = false) =>
    (await (await request(method, path, body, auth, chat)).json()) as T;

  async function toolsResponse(method: string, path: string, body?: unknown): Promise<AgentTools> {
    const value = await json<unknown>(method, path, body, true, true);
    if (!isAgentTools(value)) throw new RelayError('agent_tools_unavailable', AGENT_TOOLS_ERROR_MESSAGES.agent_tools_unavailable, 503);
    return value;
  }

  let clockOffsetMs = 0;
  const id = encodeURIComponent;
  const jobPath = (agent:string, job?:string) => `/v1/agents/${id(agent)}/jobs${job===undefined?'':`/${id(job)}`}`;
  const conversationPath = (agentId: string, conversationId?: string) =>
    `/v1/agents/${id(agentId)}/conversations${conversationId === undefined ? '' : `/${id(conversationId)}`}`;
  const pageQuery = (query: ConversationQuery = {}, search?: string) => {
    const q = new URLSearchParams();
    if (search !== undefined) q.set('q', search);
    q.set('background', String(query.background ?? false));
    q.set('limit', String(query.limit ?? 50));
    q.set('offset', String(query.offset ?? 0));
    return q.toString();
  };

  async function memoryRequest(kind: 'memory' | 'soul', method: string, agentId: string, body?: unknown) {
    try {
      if (body !== undefined && utf8Bytes(JSON.stringify(body)) > AGENT_MEMORY_REQUEST_MAX_BYTES) throw new RelayError('agent_memory_invalid', AGENT_MEMORY_MESSAGES.agent_memory_invalid);
      const response = await request(method, `/v1/agents/${id(agentId)}/${kind}`, body, true, true, true);
      const length = response.headers?.get('Content-Length');
      if (length && (!Number.isSafeInteger(Number(length)) || Number(length) < 0 || Number(length) > AGENT_MEMORY_RESPONSE_MAX_BYTES)) throw new Error('Invalid memory payload.');
      let result: unknown;
      if (response.body) {
        const reader = response.body.getReader();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          result = await Promise.race([
            (async () => {
              const chunks: Uint8Array[] = []; let size = 0;
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                size += chunk.value.byteLength;
                if (size > AGENT_MEMORY_RESPONSE_MAX_BYTES) throw new Error('Invalid memory payload.');
                chunks.push(chunk.value);
              }
              const bytes = new Uint8Array(size); let offset = 0;
              for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
              return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            })(),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new RelayError('timeout', 'Sin respuesta del Servidor.')), timeoutMs); }),
          ]);
        } finally {
          clearTimeout(timer);
          void reader.cancel().catch(() => {});
          try { reader.releaseLock(); } catch { /* A timed-out read is cancelled asynchronously. */ }
        }
      } else {
        result = await response.json();
        if (utf8Bytes(JSON.stringify(result)) > AGENT_MEMORY_RESPONSE_MAX_BYTES) throw new Error('Invalid memory payload.');
      }
      if (!response.ok) {
        const code = result && typeof result === 'object' && 'error' in result && result.error && typeof result.error === 'object' && 'code' in result.error ? result.error.code : null;
        const known = ['device_revoked', 'unauthorized', 'key_unknown', 'pairing_required', 'protocol_upgrade_required', 'rate_limited', 'tailnet_required', 'bad_request'] as const;
        const preserved = known.find(value => value === code);
        if (typeof code === 'string' && Object.hasOwn(AGENT_MEMORY_ERROR_STATUS, code)) throw new RelayError(code as AgentMemoryErrorCode, AGENT_MEMORY_MESSAGES[code as AgentMemoryErrorCode], response.status);
        throw new RelayError(preserved ?? (response.status === 401 || response.status === 403 ? 'unauthorized' : 'agent_memory_unavailable'), AGENT_MEMORY_MESSAGES.agent_memory_unavailable, response.status);
      }
      if (kind === 'memory' ? !isAgentMemory(result, agentId) : !isAgentSoul(result, agentId)) throw new RelayError('agent_memory_unavailable', AGENT_MEMORY_MESSAGES.agent_memory_unavailable);
      return result;
    } catch (error) {
      if (error instanceof RelayError) {
        if (Object.hasOwn(AGENT_MEMORY_MESSAGES, error.code)) throw new RelayError(error.code, AGENT_MEMORY_MESSAGES[error.code as AgentMemoryErrorCode], error.status);
        const messages: Record<string, string> = {
          device_revoked: 'Este teléfono fue revocado. Empareja de nuevo el Servidor.', pairing_required: 'Empareja de nuevo el Servidor.',
          unauthorized: 'Empareja de nuevo el Servidor.', key_unknown: 'Empareja de nuevo el Servidor.',
          protocol_upgrade_required: 'Actualiza Relay para leer memoria y personalidad.',
          unreachable: 'Sin respuesta del Servidor.', timeout: 'Sin respuesta del Servidor.',
          cleartext_blocked: 'Android bloquea http:// fuera de *.ts.net.',
        };
        throw new RelayError(error.status === 404 ? 'agent_memory_unavailable' : error.code,
          error.status === 404 ? 'Actualiza el Puente para leer memoria y personalidad.' : messages[error.code] ?? AGENT_MEMORY_MESSAGES.agent_memory_unavailable, error.status);
      }
      throw new RelayError('agent_memory_unavailable', AGENT_MEMORY_MESSAGES.agent_memory_unavailable);
    }
  }
  return {
    ...createPersonalityClient((method, path, body) => request(method, path, body, true, true, true), timeoutMs),
    activity: async (query = {}) => readActivityResponse(await request('GET', activityQueryPath(query), undefined, true, true, true), query, timeoutMs),
    kanban: createKanbanClient((method,path,body) => request(method,path,body,true,true,true),timeoutMs),
    downloadAppUpdate: async (manifest, options) => {
      const validated = parseAppUpdateManifest(manifest, '"' + manifest.revision + '"');
      if (validated.state !== 'published') throw new RelayError('app_update_invalid', 'No hay un APK publicado.');
      return streamAppUpdate(await request('GET', '/v1/app-update/apk', undefined, true, true, true, { 'If-Match': '"' + validated.revision + '"' }, options.signal, options.onDenial), validated, options);
    },
    appUpdate: async (signal = new AbortController().signal, onDenial) => readAppUpdateMetadata(await request('GET', '/v1/app-update', undefined, true, true, true, {}, signal, onDenial), signal, timeoutMs),
    agentDetails: (agentId) => json<AgentDetails>('GET', `/v1/agents/${encodeURIComponent(agentId)}/details`, undefined, true, true),
    setApprovalMode: (agentId, request) => json<AgentSecurity>('POST', `/v1/agents/${encodeURIComponent(agentId)}/approval-mode`, request, true, true),
    changeBlockRule: (agentId, request) => json<AgentSecurity>('POST', `/v1/agents/${encodeURIComponent(agentId)}/block-rules`, request, true, true),
    agentTools: (agentId) => toolsResponse('GET', `/v1/agents/${id(agentId)}/tools`),
    setToolset: (agentId, name, enabled) => toolsResponse('POST', `/v1/agents/${id(agentId)}/tools/${id(name)}`, { enabled }),
    agentSkills: (agentId) => json<AgentSkills>('GET', `/v1/agents/${id(agentId)}/skills`, undefined, true, true),
    agentMemory: async agentId => await memoryRequest('memory', 'GET', agentId) as import('../../../protocol/agentMemory.ts').AgentMemory,
    changeAgentMemory: async (agentId, body) => await memoryRequest('memory', 'PATCH', agentId, body) as import('../../../protocol/agentMemory.ts').AgentMemory,
    agentSoul: async agentId => await memoryRequest('soul', 'GET', agentId) as import('../../../protocol/agentMemory.ts').AgentSoul,
    changeAgentSoul: async (agentId, body) => await memoryRequest('soul', 'PUT', agentId, body) as import('../../../protocol/agentMemory.ts').AgentSoul,
    scheduledJobs: (agent) => json<ScheduledJobList>('GET',jobPath(agent)),
    scheduledJob: (agent,job) => json<ScheduledJob>('GET',jobPath(agent,job)),
    jobHistory: (agent,job,offset=0) => json<JobHistory>('GET',`${jobPath(agent,job)}/history?offset=${offset}`),
    createJob: (agent,input) => json<ScheduledJob>('POST',jobPath(agent),input),
    editJob: (agent,job,input) => json<ScheduledJob>('PATCH',jobPath(agent,job),input),
    deleteJob: (agent,job) => json<{ok:true}>('DELETE',jobPath(agent,job),{}),
    jobAction: (agent,job,action) => json<ScheduledJob>('POST',`${jobPath(agent,job)}/${action}`,{}),
    health: () => json<Health>('GET', '/health', undefined, false),
    whoami: () => json<WhoAmI>('GET', '/v1/whoami', undefined, false),
    server: () => json<ServerInfo>('GET', '/v1/server'),
    boardWeb: createBoardWebClient((path, signal) => request('GET', path, undefined, true, true, true, { [BOARD_WEB_HEADER]: BOARD_WEB_VERSION }, signal), timeoutMs),
    board: () => json<import('../../../protocol/board.ts').BoardPage>('GET', '/v1/board'),
    agents: async () => (await json<{ agents: Agent[] }>('GET', '/v1/agents')).agents,
    transcript: (agentId, sessionId) =>
      json<ConversationTranscript>('GET', `/v1/agents/${id(agentId)}/transcript${sessionId ? `?sessionId=${id(sessionId)}` : ''}`, undefined, true, true),
    conversations: (agentId, query) => json<ConversationPage>('GET', `${conversationPath(agentId)}?${pageQuery(query)}`, undefined, true, true),
    conversation: (agentId, conversationId) => json<Conversation>('GET', conversationPath(agentId, conversationId), undefined, true, true),
    createConversation: (agentId, body) => json<Conversation>('POST', conversationPath(agentId), body, true, true),
    renameConversation: (agentId, conversationId, body) => json<Conversation>('PATCH', conversationPath(agentId, conversationId), body, true, true),
    conversationDeletion: (agentId, conversationId) => json<ConversationDeletionPreview>('GET', `${conversationPath(agentId, conversationId)}/deletion`, undefined, true, true),
    deleteConversation: (agentId, conversationId, body) => json<ConversationDeleted>('DELETE', conversationPath(agentId, conversationId), body, true, true),
    searchConversations: (agentId, query) => json<ConversationSearchPage>('GET', `${conversationPath(agentId)}/search?${pageQuery(query, query.q)}`, undefined, true, true),
    agentChat: (agentId) => json<AgentChatStatus>('GET', `/v1/agents/${id(agentId)}/chat`, undefined, true, true),
    steerRun: (runId, body) => json<SteerAccepted>('POST', `/v1/runs/${id(runId)}/steer`, body, true, true),
    runSnapshot: (runId) => json<RunSnapshot>('GET', `/v1/runs/${id(runId)}`, undefined, true, true),
    reconnectRun: (runId) => json<RunSnapshot>('POST', `/v1/runs/${id(runId)}/reconnect`, undefined, true, true),
    models: (agentId) => json<ModelOptions>('GET', `/v1/agents/${id(agentId)}/models`, undefined, true, true),
    setConversationModel: (agentId, conversationId, body) => json<Conversation>('PUT', `${conversationPath(agentId, conversationId)}/model`, body, true, true),
    conversationFiles: (agentId, conversationId, query = {}) => {
      const parameters = new URLSearchParams();
      if (query.messageId !== undefined) parameters.set('messageId', query.messageId);
      parameters.set('limit', String(query.limit ?? 50)); parameters.set('offset', String(query.offset ?? 0));
      return json<ConversationFiles>('GET', `${conversationPath(agentId, conversationId)}/files?${parameters}`, undefined, true, true);
    },
    async downloadConversationFile(agentId, conversationId, fileId, sink, signal) {
      if (opts.invalidOrigin) throw new RelayError('bad_request', 'Corrige la dirección del Servidor antes de conectar');
      if (opts.pairingRequired) throw new RelayError('pairing_required', 'Empareja este teléfono de nuevo');
      const control = new AbortController();
      const cancel = () => control.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) control.abort();
      let timer: ReturnType<typeof setTimeout>;
      const rearm = () => { clearTimeout(timer); timer = setTimeout(() => control.abort(), opts.timeoutMs ?? 30_000); };
      rearm();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await doFetch(`${base}${conversationPath(agentId, conversationId)}/files/${id(fileId)}`, { method: 'GET', redirect: 'error', headers: { Accept: 'application/octet-stream', Authorization: `Bearer ${opts.key}`, [CHAT_PROTOCOL_HEADER]: String(PROTOCOL_VERSION) }, signal: control.signal });
        if (!response.ok) throw await responseError(response);
        const length = response.headers.get('Content-Length');
        const expected = length === null ? null : Number(length);
        if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0 || expected > AGENT_FILE_MAX_BYTES)) throw new RelayError('file_too_large', 'El archivo pesa más de 50 MB.');
        if (!response.body) throw new RelayError('http', 'No se pudo descargar el archivo. Reintenta.');
        reader = response.body.getReader(); let bytes = 0;
        for (;;) {
          if (control.signal.aborted) throw new RelayError(signal?.aborted ? 'cancelled' : 'timeout', signal?.aborted ? 'Descarga cancelada.' : 'La descarga dejó de responder.');
          const chunk = await reader.read(); rearm();
          if (control.signal.aborted) throw new RelayError(signal?.aborted ? 'cancelled' : 'timeout', 'Descarga interrumpida.');
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > AGENT_FILE_MAX_BYTES) throw new RelayError('file_too_large', 'El archivo pesa más de 50 MB.');
          await sink(chunk.value);
        }
        if (expected !== null && bytes !== expected) throw new RelayError('http', 'La descarga quedó incompleta. Reintenta.');
        return { bytes, mimeType: response.headers.get('Content-Type') ?? 'application/octet-stream' };
      } catch (error) {
        if (error instanceof RelayError) throw error;
        if (control.signal.aborted) throw new RelayError(signal?.aborted ? 'cancelled' : 'timeout', signal?.aborted ? 'Descarga cancelada.' : 'La descarga dejó de responder.');
        throw networkFailure(error, 'No se pudo descargar el archivo. Reintenta.');
      } finally { clearTimeout(timer!); signal?.removeEventListener('abort', cancel); await reader?.cancel().catch(() => {}); }
    },
    startRun: (agentId, req) => json<RunCreated>('POST', `/v1/agents/${id(agentId)}/runs`, req, true, true),
    stopRun: async (runId) => {
      await request('POST', `/v1/runs/${id(runId)}/stop`, undefined, true, true);
    },
    approvals: async () => {
      const inbox = await json<{ approvals: Approval[]; serverNow?: number }>('GET', '/v1/approvals');
      clockOffsetMs = typeof inbox.serverNow === 'number' && Number.isSafeInteger(inbox.serverNow) ? Date.now() - inbox.serverNow : 0;
      return inbox.approvals;
    },
    serverClockOffsetMs: () => clockOffsetMs,
    decisions: (query = {}) => {
      const params = new URLSearchParams();
      if (query.agentId) params.set('agentId',query.agentId);
      if (query.origin) params.set('origin',query.origin);
      return request('GET',`/v1/decisions${params.size ? `?${params}`:''}`,undefined,true,false,true).then(response => readDecisionHistoryResponse(response,timeoutMs));
    },
    decide: async (approvalId, choice) => {
      await request('POST', `/v1/approvals/${id(approvalId)}`, { choice });
    },
    serverControl: () => json<ServerControlStatus>('GET', '/v1/server/control', undefined, true, true),
    pauseServer: () => json<ServerControlStatus>('POST', '/v1/server/pause', undefined, true, true),
    resumeServer: () => json<ServerControlStatus>('POST', '/v1/server/resume', undefined, true, true),
    gateway: () => json<GatewayStatus>('GET', '/v1/gateway'),
    gatewayAction: (action) => json<GatewayStatus>('POST', `/v1/gateway/${action}`, undefined, true, true),
    doctor: () => json<DoctorReport>('POST', '/v1/doctor'),
    discovery: () => json('GET', '/v1/discovery'),
    logs: async (level, lines = 100, agentId) => {
      const q = new URLSearchParams({ lines: String(lines) });
      if (level) q.set('level', level);
      if (agentId) q.set('agentId', agentId);
      return (await json<{ lines: LogLine[] }>('GET', `/v1/logs?${q}`)).lines;
    },
    model: () => json<ModelInfo>('GET', '/v1/model'),
    usage: async (period) => {
      const value = await json<ServerUsage>('GET', `/v1/usage?period=${period}`);
      if (!validServerUsage(value, period)) throw new RelayError('unavailable', 'El Puente no pudo calcular el uso.');
      return value;
    },
    jobs: async () => (await json<{ jobs: Job[] }>('GET', '/v1/jobs')).jobs,
    metrics: () => json<unknown>('GET', '/v1/metrics', undefined, true, true),

    async runEvents(runId, onEvent, signal, afterEventId) {
      if (opts.invalidOrigin) throw new RelayError('bad_request', 'Corrige la dirección del Servidor antes de conectar');
      if (opts.pairingRequired) throw new RelayError('pairing_required', 'Empareja este teléfono de nuevo');
      let res: Response;
      try {
        res = await doFetch(`${base}/v1/runs/${id(runId)}/events`, {
          redirect: 'error',
          headers: { Accept: 'text/event-stream', Authorization: `Bearer ${opts.key}`, [CHAT_PROTOCOL_HEADER]: String(PROTOCOL_VERSION), ...(afterEventId !== undefined && afterEventId >= 0 ? { 'Last-Event-ID': String(afterEventId) } : {}) },
          signal,
        });
      } catch (e) {
        if (signal?.aborted) return;
        throw networkFailure(e, 'network error');
      }
      if (!res.ok) throw await responseError(res);
      if (!res.body) throw new RelayError('http', `HTTP ${res.status}`, res.status);

      let cursor = afterEventId ?? -1;
      const decoder = createSseDecoder((data, eventId) => {
        if (eventId !== undefined && eventId <= cursor) return;
        let event: ChatRunEvent;
        try {
          const parsed: unknown = JSON.parse(data);
          if (!parsed || typeof parsed !== 'object' || !('type' in parsed) || typeof parsed.type !== 'string') return;
          event = parsed as ChatRunEvent;
        } catch { return; }
        if (eventId !== undefined) cursor = eventId;
        onEvent(event);
      });
      const reader = res.body.getReader();
      const text = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          decoder.push(text.decode(value, { stream: true }));
        }
        decoder.end();
      } catch (e) {
        if (signal?.aborted) return;
        throw networkFailure(e, 'stream error');
      }
    },
  };
}

/** Public probes remain usable after migrating a legacy server; private calls never send its key. */
export function createPairedBridgeClient(opts: BridgeClientOptions & { deviceId?: string }): RelayClient {
  const pairingRequired = !opts.deviceId?.trim() || !opts.key.trim();
  let baseUrl = '';
  let invalidOrigin = false;
  try { baseUrl = validateServerAddress(opts.baseUrl); } catch { invalidOrigin = true; }
  return createBridgeClient({ ...opts, baseUrl, key: pairingRequired || invalidOrigin ? '' : opts.key, pairingRequired, invalidOrigin });
}

async function responseError(res: Response): Promise<RelayError> {
  let message = `HTTP ${res.status}`;
  let code: string | undefined;
  try {
    const parsed = await res.json() as { error?: { code?: string; message?: string } };
    code = parsed?.error?.code;
    if (typeof parsed?.error?.message === 'string') message = parsed.error.message;
  } catch {
    // Preserve the status for non-JSON responses.
  }
  const known = ['pairing_invalid', 'key_unknown', 'device_revoked', 'rate_limited', 'tailnet_required', 'server_paused', 'unauthorized', 'unavailable', 'bad_request'] as const;
  if (typeof code === 'string' && Object.hasOwn({ ...CHAT_ERROR_STATUS, ...AGENT_DETAILS_ERROR_STATUS }, code)) {
    return new RelayError(code as keyof typeof CHAT_ERROR_STATUS, message, res.status);
  }
  // #114: a file a Turno names, refused by the Puente: its fixed text, never the server's message.
  if (typeof code === 'string' && Object.hasOwn(REMOTE_ERROR_MESSAGES, code)) return new RelayError(code as RemoteErrorCode, REMOTE_ERROR_MESSAGES[code as RemoteErrorCode], res.status);
  if (typeof code === 'string' && Object.hasOwn(DECISION_ERROR_STATUS,code)) return new RelayError(code as keyof typeof DECISION_ERROR_STATUS,message,res.status);
  if (typeof code === 'string' && Object.hasOwn(AGENT_TOOLS_ERROR_STATUS, code)) {
    return new RelayError(code as keyof typeof AGENT_TOOLS_ERROR_STATUS, message, res.status);
  }
  if (typeof code === 'string' && Object.hasOwn(AGENT_MEMORY_ERROR_STATUS, code)) return new RelayError(code as AgentMemoryErrorCode, AGENT_MEMORY_MESSAGES[code as AgentMemoryErrorCode], res.status);
  const preserved = known.find((value) => value === code);
  if (preserved) return new RelayError(preserved, message, res.status);
  if (res.status === 401 || res.status === 403) return new RelayError('unauthorized', message, res.status);
  if (res.status === 503) return new RelayError('unavailable', message, res.status);
  return new RelayError('http', message, res.status);
}
