import { decisionHistoryView } from './decisionHistory.ts';
import { BoardWeb } from './boardWeb.ts';
import { BoardWebError } from './boardWebReader.ts';
import { BOARD_WEB_HEADER, BOARD_WEB_VERSION, BOARD_WEB_ID_PATTERN, BOARD_WEB_ASSET_PATTERN, BOARD_WEB_LEGACY_TEXT } from '../../protocol/boardWeb.ts';
import { Kanban, KanbanError, kanbanQuery } from './kanban.ts';
import { createKanbanStoreForStateRoot } from './kanbanStore.ts';
import { KANBAN_REQUEST_MAX_BYTES, KANBAN_RESPONSE_MAX_BYTES } from '../../protocol/kanban.ts';
import { ActivityError, activityQuery, createActivityReader, type ActivityReader } from './activity.ts';
import { NOTIFICATIONS_HEADER, NOTIFICATION_REQUEST_MAX_BYTES } from '../../protocol/notifications.ts';
import { WIDGET_LABEL_PATTERN, WIDGET_LABEL_SECRET, WIDGET_MAX_AGENTS, WIDGET_MAX_COUNT, WIDGET_OBSERVATION_TTL_MS, WIDGET_SCHEMA, type WidgetProjection } from '../../protocol/widget.ts';
import { NotificationProducers } from './notificationProducers.ts';
import { Notifications, type NotificationPublisher } from './notifications.ts';
import { createNtfyPublisher } from './ntfyTransport.ts';
import { AppUpdates, AppUpdateError } from './appUpdate.ts';
import { PersonalityApplications } from './personalityApplications.ts';
import { PersonalityCatalog, PersonalityError } from './personalityCatalog.ts';
import { PERSONALITY_ERROR_STATUS, PERSONALITY_MESSAGES, PERSONALITY_REQUEST_MAX_BYTES } from '../../protocol/personalityPresets.ts';
import { BOARD_MAX_AGENTS } from '../../protocol/board.ts';
import type { BoardCard } from '../../protocol/board.ts';
import { ServerControl } from './serverControl.ts';
import { AGENT_TOOLS_ERROR_MESSAGES } from '../../protocol/agentTools.ts';
import { AgentMemoryError } from './agentMemory.ts';
import { AGENT_MEMORY_ERROR_STATUS, AGENT_MEMORY_MESSAGES, AGENT_MEMORY_REQUEST_MAX_BYTES } from '../../protocol/agentMemory.ts';
import { ScheduledJobs, ScheduledJobsError, jobInput } from './scheduledJobs.ts';
import { AgentFiles } from './agentFiles.ts';
// The HTTP surface of relayd: exactly the routes described in protocol/protocol.ts.

import http from 'node:http';
import { AgentDetailsService } from './agentDetails.ts';
import { AgentDetailsError } from './agentDetailsError.ts';
import type { ApprovalMode } from '../../protocol/agentDetails.ts';
import os from 'node:os';

import { randomUUID } from 'node:crypto';
import { CHAT_FILES_CAPABILITY, parseChatFiles, parseChatImages } from './chatImages.ts';
import { withFileNotes } from '../../protocol/chatFiles.ts';
import { CHAT_REQUEST_MAX_BYTES } from '../../protocol/protocol.ts';
import { CHAT_FILES_CAPABILITY_NAME, CHAT_INPUT_MAX_BYTES, CHAT_PROTOCOL_HEADER, CONVERSATION_QUERY_MAX_CHARS, CONVERSATION_TITLE_MAX_CHARS, PROTOCOL_VERSION, REMOTE_CAPABILITY_HEADER, REMOTE_LIMITS } from '../../protocol/protocol.ts';
import type { ConversationQuery, ConversationSearchQuery } from '../../protocol/protocol.ts';
import { createConversationStore, isConversationId, isConversationRequestId, isModelSelection } from './conversationStore.ts';
import type { ConversationActor } from './conversationStore.ts';
import { ConversationService } from './conversations.ts';
import type {
  Agent,
  ApiError,
  ApprovalChoice,
  DecisionRecord,
  DoctorReport,
  GatewayStatus,
  Health,
  LogLevel,
  ServerInfo,
  ServerMetrics,
  WhoAmI,
} from '../../protocol/protocol.ts';
import { AuthorizationError, checkBearer, createAuthLimiter, guardAuthorization, normalizePeerIp } from './auth.ts';
import type { AuthorizationContext } from './auth.ts';
import { exactObject, StateError } from './changeLog.ts';
import type { DeviceStore } from './deviceStore.ts';
import { PairingError } from './pairing.ts';
import type { Pairing } from './pairing.ts';
import type { Config } from './config.ts';
import { createHealth } from './protocolHealth.ts';
import { advertise, RemoteError, remoteRoute, RemoteStream } from './remote/routes.ts';
import { METRICS_CAPABILITY, type Metrics } from './metrics.ts';
import { createEnvironments } from './remote/environments.ts';
import { createTerminals } from './remote/terminals.ts';
import { createBrowsers } from './remote/browsers.ts';
import { createWebApps } from './remote/web.ts';
import { createHabitualSessions } from './remote/habitualBrowser.ts';
import type { RemoteTools } from './remote/ports.ts';
import { HermesError, HTTP_STATUS } from './hermes.ts';
import type { AgentProfile, GatewayAction, Hermes } from './hermes.ts';
import type { RunManager } from './runs.ts';
import { isTailscaleIp } from './tailnet.ts';
import type { Tailnet } from './tailnet.ts';

export const RELAYD_VERSION = '0.2.0-preview.3';

export interface AppDeps {
  /** `port` is the control API's own, never offered as a local web app. */
  config: Pick<Config, 'corsOrigins' | 'ntfyOrigin' | 'appUpdateRoot'> & Partial<Pick<Config, 'port'>>;
  store: DeviceStore;
  pairing: Pairing;
  // Test harness only; the production entrypoint always uses the socket peer.
  peerAddress?: (req: http.IncomingMessage) => string;
  hermes: Hermes;
  runs: RunManager;
  notificationOrigin?: string;
  notificationIO?: import('./changeLog.ts').StateIO;
  notificationPublisher?: NotificationPublisher;
  conversations?: ConversationService;
  activity?: ActivityReader;
  tailnet: Tailnet;
  discovery?: import('./discovery.ts').Discovery;
  hostname?: string;
  version?: string;
  now?: () => number;
  /** Monotonic milliseconds for what the Puente expires (web tickets, the external hour); performance.now unless a test fakes it. */
  monotonic?: () => number;
  /** Deadlines on that clock (the end of an external authorization); setTimeout unless a test drives the clock. */
  timer?: (ms: number, run: () => void) => () => void;
  log?: (line: string) => void;
  keepaliveMs?: number;
  /** V3 remote tools this build implements; none until each tool's task wires its boundary. */
  remote?: RemoteTools;
  /** Reconciliation retry; REMOTE_LIMITS.terminateRetryMs unless a test shortens it. */
  environmentRetryMs?: number;
  /** The `metrics` capability; null or absent when the system reader does not work here. */
  metrics?: Metrics | null;
}

const MAX_BODY_BYTES = 1024 * 1024;
const LOG_LEVELS: readonly LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
const CHOICES: readonly ApprovalChoice[] = ['once', 'session', 'always', 'deny'];
const GATEWAY_ACTIONS: readonly GatewayAction[] = ['start', 'stop', 'restart'];

class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what);
const badRequest = (message: string) => new HttpError(400, 'bad_request', message);

export function createApp(deps: AppDeps): http.Server {
  const { config, hermes, runs, tailnet, store, pairing } = deps;
  const remote = deps.remote ?? {};
  const boardWeb = new BoardWeb(hermes);
  const control = new ServerControl(store.directory, () => hermes.serverControl, runs, store.changeLog);
  const limiter = createAuthLimiter(store);
  const scheduledJobs = hermes.jobsManager ? new ScheduledJobs(hermes.jobsManager, store.directory, store.changeLog) : null;
  const now = deps.now ?? Date.now;
  const activity = deps.activity ?? createActivityReader({ directory: store.directory, now });
  const notificationOrigin = deps.notificationOrigin ?? deps.config.ntfyOrigin ?? null;
  const notifications = new Notifications({ store, runs, origin: notificationOrigin, now, observedKinds: ['task', 'error', 'server'],
    publish: deps.notificationPublisher ?? (notificationOrigin ? createNtfyPublisher(notificationOrigin,{now}) : undefined), io: deps.notificationIO, timer: deps.timer });
  const unsubscribeNotifications = runs.subscribeApprovals(notifications);
  const personalities = new PersonalityCatalog(store.directory, store.changeLog, now);
  const personalityApplications = new PersonalityApplications(personalities, () => hermes.memory);
  const producers = new NotificationProducers(notifications, now, deps.log ?? (() => {}));
  const unsubscribeTerminals = runs.subscribeTerminals(event => notifications.observed(event.outcome === 'completed' ? 'task' : 'error', event.id, event.at));
  const unsubscribeWidget = runs.subscribeChanges(() => notifications.widgetChanged());
  const contexts = new Map<http.ServerResponse, AuthorizationContext>();
  const requestContexts = new WeakMap<http.IncomingMessage, AuthorizationContext>();
  const appUpdateControllers = new Map<http.ServerResponse, AbortController>();
  const appUpdates = config.appUpdateRoot ? new AppUpdates({ root: config.appUpdateRoot, privateRoot: store.directory }) : null;
  const discoveryControllers = new Map<http.ServerResponse, AbortController>();
  const streamCleanups = new Map<http.ServerResponse, () => void>();
  /** In-flight /v1/remote/* responses. */
  const remoteResponses = new Set<http.ServerResponse>();
  const peerIp = (req: http.IncomingMessage) => normalizePeerIp(deps.peerAddress?.(req) ?? req.socket.remoteAddress);

  function contextDevice(req: http.IncomingMessage): string { return requestContexts.get(req)!.deviceId!; }
  function guard(req: http.IncomingMessage): void {
    guardAuthorization(store.snapshot(), requestContexts.get(req)!, now());
  }
  const unsubscribeStore = store.subscribe(() => {
    // Transfers and searches of a revoked or removed device end, and their temporary files go (ADR 0006 «Revocación»).
    remote.files?.port.retain(new Set(store.snapshot().devices.filter((device) => device.revokedAt === null).map((device) => device.id)));
    for (const [res, context] of contexts) {
      try { guardAuthorization(store.snapshot(), context, now()); }
      catch (error) {
        appUpdateControllers.get(res)?.abort(error);
        discoveryControllers.get(res)?.abort();
        if (res.headersSent) { streamCleanups.get(res)?.(); res.end(); }
        // A remote request that has not answered yet answers its revocation now, without waiting for
        // its tool: the device learns at once and nothing it started keeps that request open.
        else if (remoteResponses.has(res) && error instanceof AuthorizationError) {
          fail(res, error.code === 'device_revoked' ? 403 : 429, error.code, error.message, false, error.retryAfter);
        }
      }
    }
  });
  const log = deps.log ?? (() => {});
  // The habitual browser's connections; their environments are listed and ended with the others.
  const habitual = remote.environments && remote.browser?.port.habitual ? createHabitualSessions({ browser: remote.browser.port.habitual, store, now, log }) : null;
  // Its reconciliation starts now and on every store change, supervisor connection and retry.
  const environments = remote.environments
    ? createEnvironments({ supervisor: remote.environments.port, store, now, log, retryMs: deps.environmentRetryMs, browser: remote.browser?.port.dedicated ?? null, habitual })
    : null;
  const terminals = remote.terminal ? createTerminals(remote.terminal.port) : null;
  const browsers = remote.browser ? createBrowsers({ dedicated: remote.browser.port.dedicated, habitual }) : null;
  // Its listeners start now, one per registered app, apart from this server.
  const webApps = remote.web ? createWebApps({ registry: remote.web.port.apps, publisher: remote.web.port.publisher, store, now,
    monotonic: deps.monotonic ?? (() => performance.now()), timer: deps.timer, log, excludedPorts: config.port ? [config.port] : [] }) : null;
  const keepaliveMs = deps.keepaliveMs ?? 15_000;
  const version = deps.version ?? RELAYD_VERSION;
  const hostname = deps.hostname ?? os.hostname();
  const files = new AgentFiles({ media: hermes.media, privateDirectory: store.directory, now });
  let conversationModule: Promise<ConversationService> | null = null;
  function conversations(): Promise<ConversationService> {
    conversationModule ??= deps.conversations ? Promise.resolve(deps.conversations) : createConversationStore({ directory: store.directory, changeLog: store.changeLog, now })
      .then((conversationStore) => new ConversationService({ hermes, store: conversationStore, runs, now, presets:personalities }))
      .catch(() => { throw new HermesError('conversation_store_unavailable', 'El registro de Conversaciones de Relay no está disponible.'); });
    return conversationModule;
  }
  let kanbanModule: Promise<Kanban> | null = null;
  function kanban(): Promise<Kanban> {
    kanbanModule ??= createKanbanStoreForStateRoot({ directory: store.directory, changeLog: store.changeLog, now })
      .then(kanbanStore => new Kanban({ store: kanbanStore, now, agentExists: async id => (await hermes.profiles()).some(p => p.id === id), notifications: {
        admit: (operation, authorize) => control.admit(operation, authorize),
        start: async (agentId, input, key, actingDevice, admission, onConversation, onAccepted) => {
          const agent = (await hermes.profiles()).find(p => p.id === agentId); admission();
          if (!agent) throw new KanbanError('kanban_agent_unavailable');
          const chat = await hermes.chat(agentId); admission();
          if (!chat.available) throw new HermesError('chat_unavailable', 'El chat no está disponible.');
          const module = await conversations(); admission();
          const selected = await module.create(agentId, `kanban:${key}`, actingDevice, admission);
          await onConversation(selected.id); admission();
          await module.withConversationWrite(agentId, selected.id, async context => {
            admission(); const request = await module.decorateRequest(context, { input, sessionId: context.sessionId }); admission();
            const created = await details.beforeTurn(agentId, admission, () => runs.start(agent, request, context, admission));
            await onAccepted(selected.id, created.runId); admission();
          }); admission();
        },
        observe: async (agentId, conversationId, runId) => {
          // Hermes status lacks Conversation identity. Missing local evidence stays unknown;
          // neither an ID collision nor an unscoped remote status may release the reservation.
          const phase = runs.phaseForConversation(agentId, conversationId, runId);
          return phase === null ? null : { phase, observedAt: now() };
        },
      } }))
      // Only success is cached, so an operator fix (e.g. removing a stale lock) needs no restart.
      .catch((error: unknown) => { kanbanModule = null; throw error; });
    return kanbanModule;
  }
  const details = new AgentDetailsService({ hermes, store, runs, conversations, now });
  function actor(req: http.IncomingMessage): ConversationActor {
    guard(req);
    const device = store.snapshot().devices.find((candidate) => candidate.id === requestContexts.get(req)?.deviceId)!;
    return { kind: 'device', id: device.id, name: device.name };
  }
  function requireChatProtocol(req: http.IncomingMessage): void {
    if (req.headers[CHAT_PROTOCOL_HEADER.toLowerCase()] !== String(PROTOCOL_VERSION)) {
      throw new HermesError('protocol_upgrade_required', 'Actualiza Relay para gestionar Conversaciones con este Puente.');
    }
  }
  function conversationQuery(url: URL, search = false): ConversationQuery | ConversationSearchQuery {
    const allowed = search ? ['q', 'background', 'limit', 'offset'] : ['background', 'limit', 'offset'];
    for (const key of url.searchParams.keys()) {
      if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new HermesError('invalid_query', 'La búsqueda no es válida.');
    }
    const background = url.searchParams.get('background');
    if (background !== null && background !== 'true' && background !== 'false') throw new HermesError('invalid_query', 'El filtro de fondo no es válido.');
    const limit = url.searchParams.get('limit') ?? '50'; const offset = url.searchParams.get('offset') ?? '0';
    if (!/^\d+$/.test(limit) || !/^\d+$/.test(offset) || !Number.isSafeInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 100
      || !Number.isSafeInteger(Number(offset))) throw new HermesError('invalid_query', 'La paginación no es válida.');
    const query: ConversationQuery = { background: background === 'true', limit: Number(limit), offset: Number(offset) };
    if (!search) return query;
    const q = url.searchParams.get('q');
    if (q === null || q.trim() === '' || Array.from(q).length > CONVERSATION_QUERY_MAX_CHARS || /[\x00-\x1f\x7f]/.test(q)) throw new HermesError('invalid_query', 'Escribe una búsqueda de hasta 200 caracteres.');
    return { ...query, q };
  }

  let doctorInFlight: Promise<DoctorReport> | null = null;
  let gatewayActionInFlight = false;

  function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    if (status >= 200 && status < 300 && contexts.has(res)) guardAuthorization(store.snapshot(), contexts.get(res)!, now());
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(payload);
  }

  function fail(res: http.ServerResponse, status: number, code: string, message: string, bearer = true, retryAfter = 0): void {
    const body: ApiError = { error: { code, message } };
    json(res, status, body, { ...(status === 401 && bearer ? { 'WWW-Authenticate': 'Bearer realm="relayd"' } : {}), ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}) });
  }

  function cors(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader('Vary', 'Origin');
    const origin = req.headers.origin;
    if (!origin || !config.corsOrigins.includes(origin)) return;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', `ETag, Content-Length, Retry-After, ${BOARD_WEB_HEADER}`);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', `Authorization, Content-Type, Last-Event-ID, If-Match, ${CHAT_PROTOCOL_HEADER}, ${BOARD_WEB_HEADER}, ${REMOTE_CAPABILITY_HEADER}`);
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }

  function readBody(req: http.IncomingMessage, maximum: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []; let size = 0;
      const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', error); };
      const error = () => { cleanup(); reject(badRequest('Request body is unavailable.')); };
      const data = (chunk: Buffer) => {
        size += chunk.length;
        if (size > maximum) { cleanup(); req.resume(); reject(badRequest('Request body is too large.')); }
        else chunks.push(chunk);
      };
      const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
      req.on('data', data); req.on('end', end); req.on('error', error); req.on('aborted', error);
    });
  }

  async function readJson(req: http.IncomingMessage, maximum = MAX_BODY_BYTES): Promise<unknown> {
    const bytes = await readBody(req, maximum);
    try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); }
    catch { throw badRequest('Request body must be JSON.'); }
  }

  function asObject(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw badRequest('Request body must be a JSON object.');
    }
    return value as Record<string, unknown>;
  }

  async function agentOr404(req: http.IncomingMessage, id: string): Promise<AgentProfile> {
    const profile = (await hermes.profiles()).find((candidate) => candidate.id === id);
    guard(req);
    if (!profile) throw notFound('Unknown agent.');
    return profile;
  }

  // ---- handlers ---------------------------------------------------------------------------

  async function whoami(req: http.IncomingMessage): Promise<WhoAmI> {
    const nobody: WhoAmI = { tailscale: false, device: null, ip: null, tailnet: null };
    const ip = peerIp(req);
    if (!ip || !isTailscaleIp(ip)) return nobody;
    const found = await tailnet.whois(ip);
    if (!found) return nobody;
    return { tailscale: true, device: found.device, ip, tailnet: found.tailnet };
  }

  async function serverInfo(req: http.IncomingMessage): Promise<ServerInfo> {
    guard(req);
    const [hermesVersion, profiles, chat] = await Promise.all([hermes.version(), hermes.profiles(), hermes.chat()]);
    return { host: hostname, hermesVersion, profiles: profiles.length, chat };
  }

  async function agents(req: http.IncomingMessage): Promise<{ agents: Agent[] }> {
    const profiles = await hermes.profiles();
    guard(req);
    const states = await hermes.profileStates(profiles.map((profile) => profile.id));
    guard(req);
    const list = await Promise.all(
      profiles.map(async (profile): Promise<Agent> => {
        const state = states[profile.id] ?? 'off';
        return {
          id: profile.id,
          name: profile.name,
          model: profile.model,
          provider: profile.provider,
          status: state === 'on' && runs.busy(profile.id) ? 'busy' : state,
          pendingApprovals: runs.pendingFor(profile.id),
          lastMessage: await hermes.lastMessage(profile.id).catch(() => null),
        };
      }),
    );
    return { agents: list };
  }

  // The home-screen projection (protocol/widget.ts): never a transcript, command, model or Aprobación identity.
  async function widget(req: http.IncomingMessage): Promise<WidgetProjection> {
    requireChatProtocol(req);
    const profiles = (await hermes.profiles()).slice(0, WIDGET_MAX_AGENTS);
    guard(req);
    const states = await hermes.profileStates(profiles.map((profile) => profile.id));
    guard(req);
    const observedAt = now();
    // An unknown expiry is never counted as a current Aprobación.
    const deadlines = runs.approvals().flatMap((approval) => approval.expiresAt !== null && approval.expiresAt > observedAt ? [approval.expiresAt] : []);
    return {
      schema: WIDGET_SCHEMA, observedAt, expiresAt: Math.min(observedAt + WIDGET_OBSERVATION_TTL_MS, ...deadlines),
      count: Math.min(deadlines.length, WIDGET_MAX_COUNT),
      agents: profiles.map((profile) => {
        const state = states[profile.id] ?? 'off';
        const label = WIDGET_LABEL_PATTERN.test(profile.name) && !WIDGET_LABEL_SECRET.test(profile.name) ? profile.name : 'Agente';
        return { label, state: state === 'on' && runs.busy(profile.id) ? 'busy' : state };
      }),
    };
  }

  async function startRun(req: http.IncomingMessage, agentId: string, admission: () => void) {
    const agent = await agentOr404(req, agentId);
    admission();
    let value: unknown;
    try { value = await readJson(req, CHAT_REQUEST_MAX_BYTES); }
    catch (error) {
      if (error instanceof HttpError && error.message === 'Request body is too large.') throw new HermesError('image_too_large', 'La petición es demasiado grande.');
      throw error;
    }
    admission();
    const body = asObject(value);
    const images = parseChatImages(body.images);
    const files = parseChatFiles(body.files);
    if (typeof body.input !== 'string' || body.input.trim() === '' && !images && !files || Buffer.byteLength(body.input) > CHAT_INPUT_MAX_BYTES || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body.input)) {
      throw badRequest('"input" must be a non-empty string of at most 64 000 bytes.');
    }
    let input = body.input;
    if (body.sessionId !== undefined && body.sessionId !== null && typeof body.sessionId !== 'string') {
      throw badRequest('"sessionId" must be a string or null.');
    }
    if (body.sessionId !== undefined && body.sessionId !== null && !isConversationId(body.sessionId)) throw badRequest('"sessionId" is invalid.');
    if (req.headers[CHAT_PROTOCOL_HEADER.toLowerCase()] !== undefined) requireChatProtocol(req);
    if (!exactObject(body, ['input'], ['sessionId', 'images', 'files', 'clientMessageId']) || body.clientMessageId !== undefined && (typeof body.clientMessageId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.clientMessageId))) throw new HermesError('invalid_request', 'Las opciones del Turno no son válidas.');
    if (images) {
      requireChatProtocol(req);
      if (!body.clientMessageId) throw new HermesError('invalid_request', 'La imagen necesita un recibo de mensaje.');
    }
    // #114: every file is checked before any Conversación or Turno; Hermes gets only the notes with the real paths.
    if (files) {
      requireChatProtocol(req);
      if (!remote.files) throw new RemoteError('remote_unavailable');
      const port = remote.files.port;
      input = withFileNotes(input, [...new Set(files.map((file) => port.reference(file).realPath))]);
    }
    const chat = await hermes.chat(agent.id);
    admission();
    if (!chat.available) throw new HermesError('chat_unavailable', 'El chat de este Agente no está disponible.');
    const module = await conversations();
    admission();
    const selected = body.sessionId ?? (await module.create(agent.id, `implicit:${randomUUID()}`, actor(req), () => admission())).id;
    return module.withConversationWrite(agent.id, selected, async (context) => {
      admission();
      const request = await module.decorateRequest(context, { input, sessionId: context.sessionId,
        ...(images ? { images } : {}), ...(body.clientMessageId ? { clientMessageId: body.clientMessageId as string } : {}) });
      admission();
      return details.beforeTurn(agent.id, admission, () => runs.start(agent, request, context, admission));
    });
  }

  async function steer(req: http.IncomingMessage, runId: string) {
    requireChatProtocol(req);
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new HermesError('invalid_steer_input', 'La instrucción debe ser JSON.');
    let body: unknown;
    try { body = await readJson(req); }
    catch (error) {
      guard(req);
      if (error instanceof HttpError && error.code === 'bad_request') throw new HermesError('invalid_steer_input', 'La instrucción debe ser JSON válido.');
      throw error;
    }
    guard(req);
    if (!exactObject(body, ['requestId', 'input']) || !isConversationRequestId(body.requestId)
      || typeof body.input !== 'string' || body.input.trim() === '' || Buffer.byteLength(body.input) > CHAT_INPUT_MAX_BYTES
      || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body.input)) {
      throw new HermesError('invalid_steer_input', 'La instrucción no es válida.');
    }
    return control.admit((admission) => runs.steer(runId, { requestId: body.requestId as string, input: body.input as string }, admission), () => guard(req));
  }

  function streamEvents(req: http.IncomingMessage, res: http.ServerResponse, runId: string): void {
    guard(req);
    if (!runs.has(runId)) throw notFound('Unknown run.');
    if (req.headers[CHAT_PROTOCOL_HEADER.toLowerCase()] !== undefined) requireChatProtocol(req);
    const cursor = req.headers['last-event-id'];
    if (cursor !== undefined && (typeof cursor !== 'string' || !/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)) || Number(cursor) > runs.snapshot(runId).lastEventId)) {
      throw new HermesError('invalid_request', 'El punto de reanudación no es válido.');
    }
    const afterSeq = cursor === undefined ? -1 : Number(cursor);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': open\n\n');
    let closed = false;
    let unsubscribe: (() => void) | null | undefined;
    const cleanup = () => {
      if (closed) return;
      closed = true; clearInterval(keepalive); unsubscribe?.(); streamCleanups.delete(res); res.end();
    };
    const allowed = () => {
      try { guardAuthorization(store.snapshot(), contexts.get(res)!, now()); return !closed && !res.destroyed; }
      catch { cleanup(); return false; }
    };
    const keepalive = setInterval(() => { if (allowed()) res.write(': keepalive\n\n'); }, keepaliveMs);
    keepalive.unref();
    streamCleanups.set(res, cleanup);
    unsubscribe = runs.subscribe(runId, afterSeq, (seq, event) => {
      if (allowed()) res.write(`id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`);
    }, cleanup);
    if (closed) unsubscribe?.();
    res.on('close', cleanup);
  }

  /**
   * A terminal output stream (ADR 0006 «Canales»): registered in `contexts` like every request, so a
   * revocation ends it; every frame passes guardAuthorization again before it is written.
   */
  function remoteStream(req: http.IncomingMessage, res: http.ServerResponse, stream: RemoteStream): void {
    guard(req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': open\n\n');
    let closed = false;
    let stop: (() => void) | undefined;
    const cleanup = () => {
      if (closed) return;
      closed = true; clearInterval(keepalive); stop?.(); streamCleanups.delete(res); res.end();
    };
    const allowed = () => {
      try { guard(req); return !closed && !res.destroyed; }
      catch { cleanup(); return false; }
    };
    const keepalive = setInterval(() => { if (allowed()) res.write(': keepalive\n\n'); }, keepaliveMs);
    keepalive.unref();
    streamCleanups.set(res, cleanup);
    res.on('close', cleanup);
    stop = stream.start((event, id) => {
      if (allowed()) res.write(`${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`);
    }, cleanup);
    // The client may have left while the route was still attaching: its close already went by.
    if (closed) stop(); else if (res.destroyed) cleanup();
  }

  async function decide(req: http.IncomingMessage, approvalId: string): Promise<{ ok: true }> {
    const value = await readJson(req);
    guard(req);
    const body = asObject(value);
    const choice = CHOICES.find((candidate) => candidate === body.choice);
    if (!choice) throw badRequest(`"choice" must be one of: ${CHOICES.join(', ')}.`);
    await runs.decide(approvalId, choice, () => guard(req));
    return { ok: true };
  }

  async function gatewayAction(req: http.IncomingMessage, action: GatewayAction): Promise<GatewayStatus> {
    requireChatProtocol(req);
    if (gatewayActionInFlight) throw new HttpError(409, 'conflict', 'Another gateway action is still running.');
    gatewayActionInFlight = true;
    const device = actor(req);
    const audit = (outcome: string) => store.changeLog.appendChange({ actor: device, action: `gateway.${action}.${outcome}`, target: { kind: 'server', id: 'local' } });
    try {
      const beforeRead = producers.beginGatewayRead();
      const before = await hermes.gateway(); guard(req); producers.gateway(before, () => guard(req), beforeRead);
      await audit('requested'); guard(req);
      await hermes.gatewayAction(action); guard(req);
      const statusRead = producers.beginGatewayRead();
      const status = await hermes.gateway(); guard(req);
      if (status.state !== (action === 'stop' ? 'stopped' : 'active')) throw new Error();
      await audit('succeeded'); guard(req);
      producers.gateway(status, () => guard(req), statusRead);
      return status;
    } catch {
      await audit('failed').catch(() => {}); guard(req);
      throw new HermesError('upstream', 'El cambio del gateway quedó sin confirmar. Revisa su estado y reintenta.');
    } finally { gatewayActionInFlight = false; }
  }

  // Doctor is slow and makes real provider calls; concurrent requests share one run.
  function doctor(req: http.IncomingMessage): Promise<DoctorReport> {
    guard(req);
    doctorInFlight ??= hermes
      .doctor()
      .then((checks) => ({ ranAt: now(), checks }))
      .finally(() => {
        doctorInFlight = null;
      });
    return doctorInFlight;
  }

  function logsQuery(url: URL): { level: LogLevel; lines: number; agentId?: string } {
    for (const key of url.searchParams.keys()) {
      if (!['level', 'lines', 'agentId'].includes(key) || url.searchParams.getAll(key).length !== 1) throw badRequest('Invalid logs query.');
    }
    const agentId = url.searchParams.get('agentId');
    if (agentId !== null && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(agentId))) throw badRequest('Invalid agent.');
    const rawLevel = url.searchParams.get('level') ?? 'INFO';
    const level = LOG_LEVELS.find((candidate) => candidate === rawLevel);
    if (!level) throw badRequest(`"level" must be one of: ${LOG_LEVELS.join(', ')}.`);
    const rawLines = url.searchParams.get('lines') ?? '100';
    if (!/^\d+$/.test(rawLines) || Number(rawLines) < 1) throw badRequest('"lines" must be a positive integer.');
    return { level, lines: Math.min(Number(rawLines), 1000), ...(agentId === null ? {} : { agentId }) };
  }

  // ---- routing ----------------------------------------------------------------------------

  async function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (method === 'GET' && path === '/health') {
      const body: Health = createHealth(version, { ...advertise(remote), ...(deps.metrics ? { metrics: METRICS_CAPABILITY } : {}),
        ...(remote.files ? { [CHAT_FILES_CAPABILITY_NAME]: CHAT_FILES_CAPABILITY } : {}) });
      return json(res, 200, body);
    }
    if (method === 'GET' && path === '/v1/whoami') return json(res, 200, await whoami(req));

    const ip = peerIp(req);
    if (!ip || !isTailscaleIp(ip)) return fail(res, 403, 'tailnet_required', 'A Tailscale peer is required.', false);
    await limiter.check(ip);
    guardAuthorization(store.snapshot(), { ip }, now());

    if (method === 'POST' && path === '/v1/pair') {
      try {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw badRequest('Request body must be JSON.');
        const body = await readJson(req, 4096);
        if (!exactObject(body, ['code']) || typeof body.code !== 'string') throw badRequest('Pairing requires only a code.');
        if (!await pairing.verify(body.code, ip)) throw new PairingError('pairing_invalid');
        await limiter.check(ip);
        guardAuthorization(store.snapshot(), { ip }, now());
        const peer = await tailnet.whois(ip);
        if (!peer?.device) throw new PairingError('unavailable');
        const response = await pairing.redeem(body.code, peer.device, ip);
        return json(res, 201, response);
      } catch (error) {
        if ((error instanceof HttpError && error.code === 'bad_request') || (error instanceof PairingError && error.code === 'pairing_invalid')) {
          const failure = await limiter.failure(ip);
          if (failure.blocked) return fail(res, 429, 'rate_limited', 'Too many failed attempts.', false, failure.retryAfter);
        }
        if (error instanceof HttpError) return fail(res, error.status, error.code, error.message, false);
        if (error instanceof PairingError) return fail(res, error.code === 'pairing_invalid' ? 401 : error.code === 'rate_limited' ? 429 : 503, error.code, error.message, false, error.retryAfter);
        throw error;
      }
    }

    const result = checkBearer(req.headers.authorization, store.snapshot().devices);
    if (!result.ok) {
      const failure = await limiter.failure(ip);
      if (failure.blocked) return fail(res, 429, 'rate_limited', 'Too many failed attempts.', true, failure.retryAfter);
      return fail(res, result.code === 'device_revoked' ? 403 : 401, result.code, result.code === 'device_revoked' ? 'Device has been revoked.' : 'Missing or invalid bearer key.');
    }
    const currentLimit = await limiter.success(ip);
    if (currentLimit.blocked) return fail(res, 429, 'rate_limited', 'Too many failed attempts.', false, currentLimit.retryAfter);
    const context = { ip, deviceId: result.deviceId };
    requestContexts.set(req, context);
    guard(req);
    if (res.destroyed) return;
    contexts.set(res, context);
    res.on('close', () => { appUpdateControllers.get(res)?.abort(); discoveryControllers.get(res)?.abort(); contexts.delete(res); });
    if (method === 'GET' && (path === '/v1/app-update' || path === '/v1/app-update/apk')) {
      requireChatProtocol(req);
      if (url.search || req.headers.range !== undefined) throw badRequest('La actualización no acepta parámetros ni rangos.');
      if (!appUpdates) throw new AppUpdateError('app_update_unavailable', 404);
      const controller = new AbortController(); appUpdateControllers.set(res, controller);
      const allowed = () => { guard(req); controller.signal.throwIfAborted(); if (res.destroyed) throw new AppUpdateError(); };
      const context = { deviceId: contextDevice(req), guard: allowed, signal: controller.signal };
      const timeout = setTimeout(() => controller.abort(new AppUpdateError()), 10 * 60_000); timeout.unref();
      let idle: ReturnType<typeof setTimeout> | undefined;
      const progress = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(new AppUpdateError()), 30_000); idle.unref(); };
      const onAbort = () => { if (res.headersSent) res.destroy(); };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      try {
        allowed();
        if (path === '/v1/app-update') {
          const result = await appUpdates.manifest(context); allowed();
          return json(res, 200, result, result.state === 'published' ? { ETag: '"' + result.revision + '"' } : {});
        }
        const download = await appUpdates.download(req.headers['if-match'], context);
        try {
          allowed(); progress();
          res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive',
            'Content-Length': download.manifest.artifact.byteLength, 'Content-Disposition': 'attachment; filename="relay.apk"',
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ETag: '"' + download.manifest.revision + '"' });
          const buffer = Buffer.alloc(64 * 1024); let position = 0;
          while (position < download.manifest.artifact.byteLength) {
            allowed();
            const read = await download.file.read(buffer, 0, Math.min(buffer.length, download.manifest.artifact.byteLength - position), position); allowed();
            if (read.bytesRead === 0) throw new AppUpdateError();
            position += read.bytesRead;
            progress();
            if (!res.write(Buffer.from(buffer.subarray(0, read.bytesRead)))) {
              await new Promise<void>((resolve, reject) => {
                const cleanup = () => { res.off('drain', drain); res.off('close', close); controller.signal.removeEventListener('abort', abort); };
                const drain = () => { cleanup(); resolve(); };
                const close = () => { cleanup(); reject(new AppUpdateError()); };
                const abort = () => { cleanup(); reject(controller.signal.reason); };
                res.once('drain', drain); res.once('close', close); controller.signal.addEventListener('abort', abort, { once: true });
                if (controller.signal.aborted) abort(); else if (res.destroyed) close();
              }); allowed();
            }
          }
          allowed(); res.end();
        } finally { await download.release(); }
      } catch (error) {
        if (res.destroyed) return;
        // Headers promised Content-Length; ending early would leave the client waiting for bytes.
        if (res.headersSent) { res.destroy(); return; }
        guard(req); throw error;
      }
      finally { clearTimeout(timeout); clearTimeout(idle); controller.signal.removeEventListener('abort', onAbort); appUpdateControllers.delete(res); }
      return;
    }
    if (path === '/v1/personality-presets' || path.startsWith('/v1/personality-presets/')) {
      requireChatProtocol(req);
      if (url.search) throw new PersonalityError('personality_invalid');
      const presetParts=path.split('/').slice(3);
      if(method==='GET'&&path==='/v1/personality-presets') {const catalog=await personalities.list();guard(req);return json(res,200,catalog);}
      if(method==='GET'&&presetParts.length===1) {const value=await personalities.get(presetParts[0]);guard(req);return json(res,200,value);}
      if(method==='GET'&&presetParts.length===3&&presetParts[1]==='versions') {const value=await personalities.get(presetParts[0],presetParts[2]);guard(req);return json(res,200,value);}
      const operation=method==='POST'&&path==='/v1/personality-presets'?'create':method==='PATCH'&&presetParts.length===1?'update':method==='DELETE'&&presetParts.length===1?'delete':null;
      if(!operation)throw notFound();
      const body=await readJson(req,PERSONALITY_REQUEST_MAX_BYTES);guard(req);
      const value=await personalities.change(operation,operation==='create'?undefined:presetParts[0],body,actor(req),()=>guard(req));
      try{guard(req);}catch{throw new PersonalityError('personality_uncertain');}
      return json(res,operation==='create'?201:200,value);
    }
    if (method === 'GET' && path === '/v1/metrics') {
      if (!deps.metrics) throw notFound();
      requireChatProtocol(req);
      if (url.search) throw badRequest('Metrics accept no query.');
      // The reader's own error text carries the Hermes path: only this fixed answer leaves.
      const reading = await deps.metrics.read().catch(() => { throw new HttpError(503, 'metrics_unavailable', 'No se pudieron leer las métricas del Servidor. Reintenta.'); });
      guard(req);
      return json(res, 200, { ...reading, measuredAt: now() } satisfies ServerMetrics);
    }
    if (method === 'GET' && path === '/v1/discovery') {
      if (url.search) throw badRequest('Discovery accepts no query.');
      if (!deps.discovery) throw new HttpError(503, 'unavailable', 'El descubrimiento no está disponible.');
      const controller = new AbortController();
      discoveryControllers.set(res, controller);
      try {
        const result = await deps.discovery.discover(controller.signal);
        if (res.destroyed) return;
        guard(req);
        return json(res, 200, result);
      } catch {
        if (res.destroyed) return;
        guard(req);
        throw new HttpError(503, 'unavailable', 'No se pudo consultar la tailnet. Reintenta.');
      } finally { discoveryControllers.delete(res); }
    }

    let parts: string[];
    try {
      parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      throw badRequest('Malformed path.');
    }
    const [v1, resource, id, sub] = parts;
    if (v1 !== 'v1') throw notFound();
    // The Pausa general does not apply to remote tools.
    if (resource === 'remote') {
      remoteResponses.add(res);
      res.on('close', () => remoteResponses.delete(res));
      const result = await remoteRoute(req, parts, url, remote, {
        now, environments, terminals, web: webApps, browsers, deviceId: contextDevice(req), actor: () => actor(req), guard: () => guard(req),
        lastEventId: req.headers['last-event-id'],
        body: async () => {
          let body: unknown;
          try { body = await readJson(req, REMOTE_LIMITS.controlBodyBytes); } catch (error) {
            throw new RemoteError(error instanceof HttpError && error.message === 'Request body is too large.' ? 'remote_too_large' : 'remote_invalid_request');
          }
          guard(req);
          return body;
        },
        bytes: async () => {
          if (req.headers['content-type'] !== 'application/octet-stream') throw new RemoteError('remote_invalid_request');
          let bytes: Buffer;
          try { bytes = await readBody(req, REMOTE_LIMITS.transferChunkBytes); } catch (error) {
            throw new RemoteError(error instanceof HttpError && error.message === 'Request body is too large.' ? 'remote_too_large' : 'remote_invalid_request');
          }
          guard(req);
          return bytes;
        },
      });
      if (result instanceof RemoteStream) return remoteStream(req, res, result);
      // A download chunk: raw bytes, after the same check json() makes before any success.
      if (Buffer.isBuffer(result)) {
        guard(req);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': result.length, 'Cache-Control': 'no-store' });
        res.end(result);
        return;
      }
      return json(res, 200, result);
    }

    const is = (m: string, length: number) => method === m && parts.length === length;
    if (resource === 'notifications') {
      requireChatProtocol(req);
      if (url.search) throw badRequest('La ruta de Avisos no admite parámetros.');
      if (req.headers[NOTIFICATIONS_HEADER.toLowerCase()] !== '1') throw new HttpError(426, 'protocol_upgrade_required', 'Actualiza Relay para gestionar Avisos.');
      if (is('GET', 2)) return json(res, 200, await notifications.status(actor(req).id!));
      if (id === 'registration' && parts.length === 3 && ['PUT','DELETE'].includes(method)) {
        const body = await readJson(req, NOTIFICATION_REQUEST_MAX_BYTES); guard(req); const person = actor(req);
        return json(res,200, await notifications[method === 'PUT' ? 'register' : 'unregister'](person.id!,body,person,() => guard(req)));
      }
      if (id === 'notices' && parts.length === 4 && is('GET',4)) return json(res,200,await notifications.notice(actor(req).id!,sub));
      if (id === 'notices' && parts.length === 5 && parts[4] === 'decision' && is('POST',5)) {
        const body = await readJson(req, NOTIFICATION_REQUEST_MAX_BYTES); guard(req);
        return json(res,200,await notifications.decide(actor(req).id!,sub,body,() => guard(req)));
      }
      throw notFound();
    }

    if (resource === 'kanban' && id === 'items') {
      requireChatProtocol(req); guard(req);
      const query = kanbanQuery(url.searchParams, parts.length === 3);
      if (req.method !== 'GET' && url.searchParams.size) throw new KanbanError('kanban_invalid_request');
      const module = await kanban(); guard(req);
      const send = (status: number, body: unknown) => {
        guard(req); if (Buffer.byteLength(JSON.stringify(body)) > KANBAN_RESPONSE_MAX_BYTES) throw new KanbanError('kanban_store_unavailable');
        return json(res, status, body);
      };
      const body = async () => { try { const value = await readJson(req, KANBAN_REQUEST_MAX_BYTES); guard(req); return value; }
        catch (error) { if (error instanceof HttpError) throw new KanbanError('kanban_invalid_request'); throw error; } };
      if (is('GET', 3)) return send(200, await module.list(query, actor(req), () => guard(req)));
      if (is('POST', 3)) return send(201, await module.create(await body(), actor(req), () => guard(req)));
      if (is('GET', 4)) { if (url.searchParams.size) throw new KanbanError('kanban_invalid_request'); return send(200, await module.detail(sub, actor(req), () => guard(req))); }
      if (is('PATCH', 4)) return send(200, await module.update(sub, await body(), actor(req), () => guard(req)));
      if (parts[4] === 'comments' && is('GET', 5)) return send(200, await module.comments(sub, query, actor(req), () => guard(req)));
      if (parts[4] === 'comments' && is('POST', 5)) return send(201, await module.comment(sub, await body(), actor(req), () => guard(req)));
      if (parts[4] === 'notify' && is('POST', 5)) return send(202, await module.notify(sub, await body(), actor(req), () => guard(req)));
      if (parts[4] === 'notifications' && is('GET', 6)) { if (url.searchParams.size) throw new KanbanError('kanban_invalid_request'); return send(200, await module.notification(sub, parts[5], actor(req), () => guard(req))); }
      throw notFound();
    }
    if (resource === 'activity'  && is('GET', 2)) {
      requireChatProtocol(req);
      const query = activityQuery(url.searchParams);
      const page = await activity.list(query, requestContexts.get(req)!.deviceId!, () => guard(req));
      guard(req);
      return json(res, 200, page);
    }
    if (resource === 'usage' && is('GET', 2)) {
      const period = url.searchParams.get('period');
      if (url.searchParams.size !== 1 || !['day', 'week', 'month'].includes(period ?? '')) throw badRequest('Invalid usage period.');
      if (!hermes.usage) throw new HermesError('unavailable', 'Usage is unavailable.');
      const usage = await hermes.usage(period as 'day' | 'week' | 'month');
      guard(req);
      return json(res, 200, usage);
    }
    if (resource === 'board' && is('GET', 2)) {
      if (url.searchParams.size) throw badRequest('Board does not accept query parameters.');
      const web = req.headers[BOARD_WEB_HEADER.toLowerCase()];
      if (web !== undefined) { requireChatProtocol(req); if (web !== BOARD_WEB_VERSION) throw new BoardWebError('board_web_unsupported', 426); }
      if (!hermes.board) throw new HermesError('unavailable', 'Board unavailable.');
      const profiles = await hermes.profiles(); guard(req);
      if (profiles.length > BOARD_MAX_AGENTS) throw new HermesError('unavailable', 'Board limit exceeded.');
      const cards: BoardCard[] = []; const failedAgents: string[] = [];
      for (const profile of profiles) {
        try { const published = await hermes.board.read(profile.id); guard(req); cards.push(...published.map(card => ({ ...card, agentId: profile.id, agentName: profile.name }))); }
        catch { guard(req); failedAgents.push(profile.id); }
      }
      const response = web === BOARD_WEB_VERSION ? cards : cards.map(card => card.content.type === 'web' ? { ...card, content: { type: 'text', text: BOARD_WEB_LEGACY_TEXT } } : card);
      return json(res, 200, { cards: response, failedAgents, observedAt: now() }, web === BOARD_WEB_VERSION ? { [BOARD_WEB_HEADER]: BOARD_WEB_VERSION } : {});
    }
    if (resource === 'agents' && sub === 'board-web') {
      requireChatProtocol(req);
      if (req.headers[BOARD_WEB_HEADER.toLowerCase()] !== BOARD_WEB_VERSION) throw new BoardWebError('board_web_unsupported', 426);
      const bundle = parts[4], revision = parts[5], section = parts[6], asset = parts[7];
      if (method !== 'GET' || url.searchParams.size || req.headers.range || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || !new RegExp(BOARD_WEB_ID_PATTERN).test(bundle ?? '') || !/^[a-f0-9]{64}$/.test(revision ?? '')
        || !(section === 'manifest' && parts.length === 7 || section === 'assets' && parts.length === 8 && asset.length <= 64 && new RegExp(BOARD_WEB_ASSET_PATTERN).test(asset))) throw badRequest('La solicitud de contenido web no es válida.');
      return boardWeb.read(id, bundle, revision, () => { guard(req); if (res.destroyed) throw new BoardWebError('board_web_unavailable', 404); }, async snapshot => {
        if (section === 'manifest') { guard(req); json(res, 200, { bundleRef: bundle, revision, manifest: snapshot.manifest }, { [BOARD_WEB_HEADER]: BOARD_WEB_VERSION }); return; }
        const metadata = snapshot.manifest.files.find(file => file.name === asset), bytes = snapshot.assets.get(asset);
        if (!metadata || !bytes) throw new BoardWebError('board_web_unavailable', 404);
        guard(req);
        await new Promise<void>((resolve, reject) => {
          const closed = () => { res.off('error', failed); resolve(); }; const failed = (error: Error) => { res.off('close', closed); reject(error); };
          res.once('close', closed); res.once('error', failed);
          res.writeHead(200, { 'Content-Type': metadata.mime, 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', [BOARD_WEB_HEADER]: BOARD_WEB_VERSION });
          res.end(bytes, () => { res.off('close', closed); res.off('error', failed); resolve(); });
        });
      });
    }
    if (resource === 'server' && is('GET', 2)) return json(res, 200, await serverInfo(req));
    if (resource === 'widget' && is('GET', 2)) return json(res, 200, await widget(req));
    if (resource === 'agents' && is('GET', 2)) return json(res, 200, await agents(req));
    if (resource === 'agents' && ['details', 'approval-mode', 'block-rules'].includes(sub) && parts.length === 4) {
      requireChatProtocol(req);
      const agent = await agentOr404(req, id);
      if (sub === 'details' && is('GET', 4)) return json(res, 200, await details.read(agent, () => guard(req)));
      if (sub !== 'details' && is('POST', 4)) {
        const body = await readJson(req, 4096); guard(req);
        if (sub === 'approval-mode') {
          if (!exactObject(body, ['mode', 'revision']) || !['manual','smart','off'].includes(String(body.mode)) || typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)) throw new AgentDetailsError('agent_security_invalid');
          return json(res, 200, await details.mode(agent.id, body.mode as ApprovalMode, body.revision, actor(req), () => guard(req)));
        }
        if (!exactObject(body, ['action', 'pattern', 'revision']) || !['add','remove'].includes(String(body.action)) || typeof body.pattern !== 'string' || (body.action === 'add' && body.pattern.trim() !== body.pattern) || body.pattern.trim().length < 1 || body.pattern.length > 256 || /[\x00-\x1f\x7f]/.test(body.pattern) || typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)) throw new AgentDetailsError('agent_security_invalid');
        return json(res, 200, await details.rule(agent.id, { action: body.action as 'add'|'remove', pattern: body.pattern, revision: body.revision }, actor(req), () => guard(req)));
      }
    }
    if (resource === 'agents' && (sub === 'memory' || sub === 'soul') && (parts.length === 4 || sub === 'soul' && parts.length === 5 && ['preset-preview','preset'].includes(parts[4]))) {
      requireChatProtocol(req);
      const agent = await agentOr404(req, id);
      if (!hermes.memory) throw new AgentMemoryError('agent_memory_unavailable');
      if(sub==='soul'&&parts.length===5&&parts[4]==='preset-preview'&&method==='GET') {
        requireChatProtocol(req);
        if([...url.searchParams.keys()].some(key=>!['presetId','presetRevision'].includes(key)||url.searchParams.getAll(key).length!==1))throw new PersonalityError('personality_invalid');
        const preview=await personalityApplications.preview(agent.id,url.searchParams.get('presetId')??'',url.searchParams.get('presetRevision')??'',()=>guard(req));guard(req);return json(res,200,preview);
      }
      if(sub==='soul'&&parts.length===5&&parts[4]==='preset'&&method==='PUT') {
        requireChatProtocol(req);const body=await readJson(req,PERSONALITY_REQUEST_MAX_BYTES);guard(req);
        const cancellation=new AbortController();const check=()=>{try{guard(req);}catch(error){cancellation.abort(error);}};const unsubscribe=store.subscribe(check);
        try {
          check();cancellation.signal.throwIfAborted();
          const applied=await personalityApplications.apply(agent.id,body,{directory:store.directory,changeLog:store.changeLog,actor:actor(req),guard:()=>guard(req),signal:cancellation.signal});
          try{guard(req);}catch{throw new PersonalityError('personality_uncertain');}
          return json(res,200,applied);
        } finally{unsubscribe();}
      }
      if(parts.length!==4)throw notFound();
      if (method === 'GET') return json(res, 200, sub === 'memory' ? await hermes.memory.readMemory(agent.id) : await hermes.memory.readSoul(agent.id));
      if (method === (sub === 'memory' ? 'PATCH' : 'PUT')) {
        const body = await readJson(req, AGENT_MEMORY_REQUEST_MAX_BYTES);
        const cancellation = new AbortController();
        const check = () => { try { guard(req); } catch (error) { cancellation.abort(error); } };
        const unsubscribe = store.subscribe(check);
        try {
          const context = { directory: store.directory, changeLog: store.changeLog, actor: actor(req), guard: () => guard(req), signal:cancellation.signal };
          check(); cancellation.signal.throwIfAborted();
          return json(res, 200, sub === 'memory' ? await hermes.memory.changeMemory(agent.id, body, context) : await hermes.memory.changeSoul(agent.id, body, context));
        } finally { unsubscribe(); }
      }
      throw notFound();
    }
    if (resource === 'agents' && sub === 'jobs' && parts.length >= 4) {
      const agent = await agentOr404(req, id);
      const manager = hermes.jobsManager;
      if (!manager || !scheduledJobs) throw new HermesError('unavailable', 'Tareas no disponibles.');
      const job = parts[4];
      if (job !== undefined && !/^[a-f0-9]{12}$/.test(job)) throw badRequest('Invalid job id.');
      if (is('GET', 6) && parts[5] === 'history') {
        if ([...url.searchParams.keys()].some(k=>k!=='offset') || url.searchParams.getAll('offset').length>1) throw badRequest('Invalid pagination.');
        const offset = url.searchParams.get('offset') ?? '0';
        if (!/^\d{1,6}$/.test(offset)) throw badRequest('Invalid pagination.');
        const history = await manager.history(agent.id,job,Number(offset)); guard(req);
        producers.jobs(agent.id, job, history, () => guard(req));
        return json(res,200,history);
      }
      if (url.searchParams.size) throw badRequest('Unexpected query.');
      if (is('GET',4)) return json(res,200,await manager.list(agent.id));
      if (is('GET',5)) return json(res,200,await manager.get(agent.id,job));
      if (is('POST',4) || is('PATCH',5)) {
        const body = jobInput(await readJson(req,32768)); guard(req);
        if (is('POST',4) && !body.prompt.trim() && body.skills.length === 0) throw badRequest('A prompt or skills are required.');
        return json(res,is('POST',4)?201:200,await scheduledJobs.mutate(agent.id,job??null,is('POST',4)?'create':'edit',body,actor(req),()=>guard(req)));
      }
      const action = parts[5];
      if (is('DELETE',5) || is('POST',6) && (action==='pause'||action==='resume'||action==='run')) {
        const body = await readJson(req,1024); guard(req);
        if (!exactObject(body,[])) throw badRequest('Unexpected fields.');
        return json(res,200,await scheduledJobs.mutate(agent.id,job,is('DELETE',5)?'delete':action as 'pause'|'resume'|'run',undefined,actor(req),()=>guard(req)));
      }
      throw notFound();
    }
    if (resource === 'agents' && sub === 'chat' && is('GET', 4)) {
      requireChatProtocol(req);
      const agent = await agentOr404(req, id);
      const chat = await hermes.chat(agent.id);
      guard(req);
      return json(res, 200, { available: chat.available, reason: chat.available ? null : 'El chat de este Agente no está disponible en el Servidor.' });
    }
    if (resource === 'agents' && (sub === 'tools' || sub === 'skills') && (is('GET', 4) || (sub === 'tools' && is('POST', 5)))) {
      requireChatProtocol(req);
      const agent = await agentOr404(req, id);
      const port = hermes.agentTools;
      if (!port) throw new HermesError('agent_tools_unavailable', 'Este Puente no ofrece herramientas y skills.');
      if (method === 'GET') return json(res, 200, await (sub === 'skills' ? port.skills(agent.id) : port.tools(agent.id)));
      const body = await readJson(req, 1024); guard(req);
      if (!exactObject(body, ['enabled']) || typeof body.enabled !== 'boolean' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(parts[4])) throw badRequest('La selección de herramienta no es válida.');
      const enabled = body.enabled;
      const result = await port.setToolset(agent.id, parts[4], enabled, {
        backupDirectory: store.directory,
        guard: () => guard(req),
        beforeWrite: async () => {
          await store.changeLog.appendChange({ actor: actor(req), action: enabled ? 'agent.tools.enable.requested' : 'agent.tools.disable.requested', target: { kind: 'agent', id: agent.id } });
          guard(req);
        },
      });
      return json(res, 200, result);
    }
    if (resource === 'agents' && sub === 'models' && is('GET', 4)) {
      requireChatProtocol(req);
      const agent = await agentOr404(req, id);
      const options = await hermes.models(agent.id); guard(req);
      return json(res, 200, options);
    }
    if (resource === 'agents' && sub === 'transcript' && is('GET', 4)) {
      const agent = await agentOr404(req, id);
      guard(req);
      const module = await conversations();
      const selected = url.searchParams.get('sessionId');
      if (selected !== null && !isConversationId(selected)) throw new HermesError('invalid_request', 'La Conversación no es válida.');
      const conversation = selected ? await module.get(agent.id, selected) : (await module.list(agent.id, { background: false, limit: 1, offset: 0 })).conversations[0] ?? null;
      guard(req);
      const transcript = conversation ? await hermes.transcript(agent.id, conversation.sessionId) : { sessionId: null, items: [] };
      return json(res, 200, { ...transcript, conversation });
    }
    if (resource === 'agents' && sub === 'conversations' && parts.length >= 4) {
      requireChatProtocol(req);
      const agent = await agentOr404(req, id);
      const module = await conversations();
      guard(req);
      if (is('GET', 4)) return json(res, 200, await module.list(agent.id, conversationQuery(url)));
      if (is('POST', 4)) {
        const body = await readJson(req, 4096); guard(req);
        if (!exactObject(body, ['requestId']) || !isConversationRequestId(body.requestId)) throw new HermesError('invalid_request', 'La solicitud de creación no es válida.');
        return json(res, 201, await module.create(agent.id, body.requestId, actor(req), () => guard(req)));
      }
      const conversationId = parts[4];
      if (conversationId === 'search' && is('GET', 5)) return json(res, 200, await module.search(agent.id, conversationQuery(url, true) as ConversationSearchQuery));
      if (!isConversationId(conversationId)) throw new HermesError('invalid_request', 'La Conversación no es válida.');
      if (is('GET', 5)) return json(res, 200, await module.get(agent.id, conversationId));
      if (parts[5] === 'personality') {
        if(url.searchParams.size)throw new PersonalityError('personality_invalid');
        if(is('GET',6))return json(res,200,await module.getPersonality(agent.id,conversationId,()=>guard(req)));
        if(is('PUT',6)){const body=await readJson(req,4096);guard(req);return json(res,200,await module.selectPersonality(agent.id,conversationId,body,actor(req),()=>guard(req)));}
        throw notFound();
      }
      if (parts[5] === 'model' && is('PUT', 6)) {
        const body = await readJson(req, 4096); guard(req);
        if (!exactObject(body, ['model']) || body.model !== null && !isModelSelection(body.model)) throw new HermesError('invalid_request', 'La selección de modelo no es válida.');
        return json(res, 200, await module.setModel(agent.id, conversationId, body.model, actor(req), () => guard(req)));
      }
      if (parts[5] === 'files') {
        const conversation = await module.get(agent.id, conversationId); guard(req);
        if (is('GET', 6)) {
          if ([...url.searchParams.keys()].some((key) => !['messageId', 'limit', 'offset'].includes(key))) throw new HermesError('invalid_query', 'La consulta de archivos no es válida.');
          const limit = Number(url.searchParams.get('limit') ?? '50'), offset = Number(url.searchParams.get('offset') ?? '0');
          const messageId = url.searchParams.get('messageId') ?? undefined;
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || messageId !== undefined && !isConversationId(messageId)) throw new HermesError('invalid_query', 'La consulta de archivos no es válida.');
          return json(res, 200, await files.list(agent.id, conversation.id, conversation.sessionId, { limit, offset, messageId }, () => guard(req)));
        }
        if (is('GET', 7)) {
          if (url.searchParams.size !== 0) throw new HermesError('invalid_query', 'La descarga no admite opciones.');
          const staged = await files.stage(agent.id, conversation.id, conversation.sessionId, parts[6], () => guard(req));
          try {
            guard(req);
            const mimeType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(staged.mimeType) ? staged.mimeType : 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': mimeType, 'Content-Length': staged.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(staged.name)}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            const buffer = Buffer.alloc(64 * 1024); let position = 0;
            for (;;) {
              guard(req); if (res.destroyed) break;
              const chunk = await staged.file.read(buffer, 0, buffer.length, position); guard(req);
              if (chunk.bytesRead === 0) break; position += chunk.bytesRead;
              if (!res.write(Buffer.from(buffer.subarray(0, chunk.bytesRead)))) await new Promise<void>((resolve) => { const finish = () => { res.off('drain', finish); res.off('close', finish); resolve(); }; res.once('drain', finish); res.once('close', finish); });
            }
            res.end(); return;
          } finally { await staged.dispose(); }
        }
        throw notFound();
      }
      if (parts[5] === 'deletion' && is('GET', 6)) return json(res, 200, await module.deletionPreview(agent.id, conversationId));
      if (is('PATCH', 5)) {
        const body = await readJson(req, 4096); guard(req);
        if (!exactObject(body, ['title']) || typeof body.title !== 'string' || body.title.trim() === '' || Array.from(body.title.trim()).length > CONVERSATION_TITLE_MAX_CHARS
          || /[\x00-\x1f\x7f]/.test(body.title)) throw new HermesError('invalid_title', 'El título debe tener entre 1 y 100 caracteres.');
        return json(res, 200, await module.rename(agent.id, conversationId, body.title.trim(), actor(req), () => guard(req)));
      }
      if (is('DELETE', 5)) {
        const body = await readJson(req, 4096); guard(req);
        if (!exactObject(body, ['revision']) || typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)) throw new HermesError('invalid_request', 'Primero confirma el conteo de mensajes que se borrarán.');
        return json(res, 200, await module.delete(agent.id, conversationId, body.revision, actor(req), () => guard(req)));
      }
      throw notFound();
    }
    if (resource === 'agents' && sub === 'runs' && is('POST', 4)) return json(res, 200, await control.admit((admission) => startRun(req, id, admission), () => guard(req)));
    if (resource === 'runs' && is('GET', 3)) {
      requireChatProtocol(req); guard(req);
      return json(res, 200, runs.snapshot(id));
    }
    if (resource === 'runs' && sub === 'steer' && is('POST', 4)) return json(res, 200, await steer(req, id));
    if (resource === 'runs' && sub === 'reconnect' && is('POST', 4)) {
      requireChatProtocol(req);
      const body = (req.headers['content-length'] === undefined || req.headers['content-length'] === '0') && req.headers['transfer-encoding'] === undefined ? {} : await readJson(req, 4096);
      guard(req);
      if (!exactObject(body, [])) throw new HermesError('invalid_request', 'La reconexión no admite opciones.');
      return json(res, 200, await control.admit(async (admission) => runs.reconnect(id, admission), () => guard(req)));
    }
    if (resource === 'runs' && sub === 'events' && is('GET', 4)) return streamEvents(req, res, id);
    if (resource === 'runs' && sub === 'stop' && is('POST', 4)) {
      await runs.stop(id, () => guard(req));
      return json(res, 200, { ok: true });
    }
    if (resource === 'decisions' && is('GET',2)) {
      for (const key of url.searchParams.keys()) if (!['agentId','origin'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new HermesError('invalid_decision_query','El filtro de Decisiones no es válido.');
      const agentId = url.searchParams.get('agentId'); const origin = url.searchParams.get('origin');
      if (agentId !== null && !isConversationId(agentId) || origin !== null && !['relay','other'].includes(origin)) throw new HermesError('invalid_decision_query','El filtro de Decisiones no es válido.');
      const profiles = await hermes.profiles(); guard(req);
      if (agentId !== null && !profiles.some(profile => profile.id === agentId)) throw notFound();
      const selected = profiles.filter(profile => agentId === null || profile.id === agentId);
      const ledger = (await runs.decisionHistory()).filter(record => agentId === null || record.agentId === agentId);
      const module = await conversations(); guard(req);
      const imported = await Promise.all(selected.map(async profile => {
        const rows = await hermes.decisionHistory(profile.id);
        return rows.flatMap(record => {
          const owned = module.ownsSession(profile.id,record.sessionId);
          if (owned && record.actor !== 'guardian') return [];
          return [{...record,agentName:profile.name,origin:owned ? 'relay' as const:'other' as const,originLabel:owned ? 'Relay':record.originLabel}];
        });
      }));
      guard(req);
      const decisions: DecisionRecord[] = [...ledger,...imported.flat()].filter(record => origin === null || record.origin === origin);
      const uncertain = (await runs.uncertainDecisions()).filter(record => (agentId === null || record.agentId === agentId) && origin !== 'other'); guard(req);
      return json(res,200,decisionHistoryView(decisions,now(),uncertain));
    }
    if (resource === 'approvals' && is('GET', 2)) return json(res, 200, { approvals: runs.approvals(), serverNow: now() });
    if (resource === 'approvals' && is('POST', 3)) return json(res, 200, await decide(req, id));
    if (resource === 'server' && id === 'control' && is('GET', 3)) {
      requireChatProtocol(req);
      const read = producers.beginPausedRead();
      const status = await control.status(); guard(req); producers.paused(status.phase === 'pending' ? null : status.hermesPaused, () => guard(req), read);
      return json(res, 200, status);
    }
    if (resource === 'server' && (id === 'pause' || id === 'resume') && is('POST', 3)) {
      requireChatProtocol(req);
      const beforeRead = producers.beginPausedRead();
      const before = await control.status(); guard(req); producers.paused(before.phase === 'pending' ? null : before.hermesPaused, () => guard(req), beforeRead);
      const statusRead = producers.beginPausedRead();
      const status = await control.change(id, actor(req), () => guard(req)); guard(req);
      producers.paused(status.hermesPaused, () => guard(req), statusRead);
      return json(res, 200, status);
    }
    if (resource === 'gateway' && is('GET', 2)) {
      const read = producers.beginGatewayRead();
      const status = await hermes.gateway(); guard(req); producers.gateway(status, () => guard(req), read);
      return json(res, 200, status);
    }
    if (resource === 'gateway' && is('POST', 3)) {
      const action = GATEWAY_ACTIONS.find((candidate) => candidate === id);
      if (!action) throw notFound('Unknown gateway action.');
      return json(res, 200, await gatewayAction(req, action));
    }
    if (resource === 'doctor' && is('POST', 2)) return json(res, 200, await doctor(req));
    if (resource === 'logs' && is('GET', 2)) return json(res, 200, { lines: await hermes.logs(logsQuery(url)) });
    if (resource === 'model' && is('GET', 2)) return json(res, 200, await hermes.model());
    if (resource === 'jobs' && is('GET', 2)) return json(res, 200, { jobs: await hermes.jobs() });
    throw notFound();
  }

  const server = http.createServer((req, res) => {
    const started = now();
    let label = 'unmatched';
    res.on('close', () => log(`${req.method} ${label} ${res.statusCode} ${now() - started}ms`));
    cors(req, res);
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://relayd'); label = routeLabel(req.method ?? 'GET', url.pathname); }
    catch { fail(res, 400, 'bad_request', 'Invalid request URL.', false); return; }
    route(req, res, url).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof RemoteError) return fail(res, error.status, error.code, error.message);
      if (error instanceof BoardWebError) return fail(res, error.status, error.code, error.message, false, error.status === 429 ? 1 : 0);
      if (error instanceof KanbanError) return fail(res, error.status, error.code, error.message);
      if (error instanceof ActivityError) return fail(res, error.status, error.code, error.message);
      if (error instanceof AppUpdateError) return fail(res, error.status, error.code, error.message, false, error.status === 429 ? 1 : 0);
      if (error instanceof AuthorizationError) return fail(res, error.code === 'device_revoked' ? 403 : 429, error.code, error.message, false, error.retryAfter);
      if (error instanceof PersonalityError) return fail(res, PERSONALITY_ERROR_STATUS[error.code], error.code, PERSONALITY_MESSAGES[error.code]);
      if (error instanceof AgentMemoryError) return fail(res, AGENT_MEMORY_ERROR_STATUS[error.code], error.code, AGENT_MEMORY_MESSAGES[error.code]);
      if (error instanceof HttpError) return fail(res, error.status, error.code, error.message);
      if (error instanceof AgentDetailsError) return fail(res, error.status, error.code, error.message);
      if (error instanceof ScheduledJobsError) return fail(res, error.status, error.code, error.message);
      if (error instanceof HermesError) {
        const notificationMessages: Record<string,string> = {
          bad_request:'La solicitud de Avisos no es válida.', not_found:'Este Aviso es desconocido.',
          conflict:'El Aviso o su inscripción cambió o expiró. Actualiza Relay.',
          upstream:'La solicitud de Avisos no se completó.',
          unavailable:'El canal de Avisos no está disponible o no está configurado.',
        };
        if (label === '/v1/notifications/:resource/:notice/:action' && notificationMessages[error.code])
          return fail(res,HTTP_STATUS[error.code],error.code,notificationMessages[error.code]);
        const messages = { bad_request: 'Hermes rejected the request.', not_found: 'Not found.', conflict: 'Hermes refused: conflicting state.',
          upstream: 'Hermes request failed.', unavailable: 'Hermes API server is unavailable; check API_SERVER_KEY and the local service.' };
        const safeMessages: Record<string, string> = {
          decision_store_full: 'El registro de Decisiones está lleno. No se borró el historial; conserva una copia antes de reintentar.', decision_uncertain: 'La Decisión quedó sin confirmar. No se enviará otra vez.', decision_store_unavailable: 'El registro de Decisiones de Relay no está disponible.', decision_history_unavailable: 'No se pudo leer el historial de comandos de Hermes. Reintenta.', invalid_decision_query: 'El filtro de Decisiones no es válido.',
          server_paused: 'Pausa general: reanuda el Servidor antes de iniciar trabajo. Conserva el mensaje para reenviarlo.',
          ...AGENT_TOOLS_ERROR_MESSAGES,
          invalid_title: 'El título no es válido o ya está en uso; elige otro de hasta 100 caracteres.',
          invalid_query: 'La búsqueda no es válida.', invalid_request: 'La solicitud no es válida.',
          conversation_read_only: 'Esta Conversación nació fuera de Relay; ábrela en solo lectura.',
          conversation_not_found: 'La Conversación ya no existe.', conversation_busy: 'La Conversación tiene un Turno en marcha.',
          conversation_changed: 'La Conversación cambió. Confirma de nuevo el borrado.',
          request_conflict: 'Esta solicitud ya corresponde a otra operación.',
          file_ticket_expired: 'Actualiza la lista de archivos y vuelve a descargarlo.', file_blocked: 'El archivo no se puede entregar.', file_not_found: 'El archivo ya no está en el Servidor.', file_too_large: 'El archivo pesa más de 50 MB.',
          model_not_configured: 'El modelo no está configurado para este Agente. Elige otro modelo.',
          invalid_image: 'La imagen no es válida. Elige una imagen JPEG, PNG o WebP.',
          image_too_large: 'La imagen y el mensaje son demasiado grandes. Elige una imagen más pequeña.',
          invalid_steer_input: 'Escribe una instrucción válida de hasta 64 000 bytes.',
          run_not_found: 'El Puente ya no conoce este Turno.',
          run_not_accepting_steer: 'El Turno ya no admite redirección. Conserva el texto para reenviarlo.',
          steer_not_accepted: 'Hermes no aceptó la instrucción. Conserva el texto para reenviarlo.',
          protocol_upgrade_required: 'Actualiza Relay para gestionar Conversaciones con este Puente.',
          chat_unavailable: 'El chat de este Agente no está disponible en el Servidor.', conversation_store_unavailable: 'El registro de Conversaciones de Relay no está disponible.',
          operation_uncertain: 'La operación quedó sin confirmar. Conserva el texto y la misma solicitud; no se enviará otra vez.',
          upstream_failure: 'Hermes no pudo completar la operación.',
        };
        return fail(res, HTTP_STATUS[error.code], error.code, safeMessages[error.code] ?? messages[error.code as keyof typeof messages] ?? 'Chat capability is unavailable.');
      }
      if (error instanceof StateError) {
        const conversationRequest = /^\/v1\/agents\/[^/]+\/(?:conversations(?:\/|$)|runs$|transcript$)/.test(url.pathname);
        return fail(res, 503, conversationRequest ? 'conversation_store_unavailable' : 'unavailable', 'El registro privado de Relay no está disponible.');
      }
      log('Unexpected request failure.');
      fail(res, 500, 'internal', 'Internal error.');
    });
  });
  server.on('close', () => {
    void boardWeb.close();
    environments?.close();
    void webApps?.shutdown();
    unsubscribeStore();
    unsubscribeNotifications();
    unsubscribeTerminals();
    unsubscribeWidget();
    notifications.close();
    for (const controller of appUpdateControllers.values()) controller.abort();
    void appUpdates?.close();
  });
  return server;
}

function routeLabel(method: string, pathname: string): string {
  if (method === 'OPTIONS') return 'preflight';
  if (/^\/v1\/agents\/[^/]+\/board-web(?:\/|$)/.test(pathname)) return '/v1/agents/:agent/board-web/:bundle/:revision/:asset';
  if (pathname.startsWith('/v1/notifications')) return '/v1/notifications/:resource/:notice/:action';
  if (/^\/v1\/kanban\/items(?:\/[^/]+)?(?:\/(comments|notify|notifications\/[^/]+))?$/.test(pathname)) return '/v1/kanban/items/:itemId/:action';
  if (/^\/v1\/agents\/[^/]+\/jobs(?:\/[^/]+)?(?:\/(history|pause|resume|run))?$/.test(pathname)) return '/v1/agents/:agent/jobs/:job/:action';
  const routes: Array<[string, RegExp, string]> = [
    ['GET', /^\/v1\/app-update(?:\/apk)?$/, pathname],
    ['GET', /^\/v1\/personality-presets$/, '/v1/personality-presets'],
    ['POST', /^\/v1\/personality-presets$/, '/v1/personality-presets'],
    ['GET', /^\/v1\/personality-presets\/[^/]+(?:\/versions\/[^/]+)?$/, '/v1/personality-presets/:id/:version'],
    ['PATCH', /^\/v1\/personality-presets\/[^/]+$/, '/v1/personality-presets/:id'],
    ['DELETE', /^\/v1\/personality-presets\/[^/]+$/, '/v1/personality-presets/:id'],
    ['GET', /^\/v1\/agents\/[^/]+\/soul\/preset-preview$/, '/v1/agents/:id/soul/preset-preview'],
    ['PUT', /^\/v1\/agents\/[^/]+\/soul\/preset$/, '/v1/agents/:id/soul/preset'],
    ['GET', /^\/v1\/agents\/[^/]+\/conversations\/[^/]+\/personality$/, '/v1/agents/:id/conversations/:conversationId/personality'],
    ['PUT', /^\/v1\/agents\/[^/]+\/conversations\/[^/]+\/personality$/, '/v1/agents/:id/conversations/:conversationId/personality'],
    ['GET', /^\/v1\/remote\/status$/, '/v1/remote/status'],
    ['GET', /^\/v1\/remote\/environments$/, '/v1/remote/environments'], ['POST', /^\/v1\/remote\/environments$/, '/v1/remote/environments'],
    ['POST', /^\/v1\/remote\/environments\/[^/]+\/terminate$/, '/v1/remote/environments/:id/terminate'],
    ['DELETE', /^\/v1\/remote\/environments\/[^/]+$/, '/v1/remote/environments/:id'],
    ['GET', /^\/v1\/remote\/shells$/, '/v1/remote/shells'],
    ['GET', /^\/v1\/remote\/terminals\/[^/]+\/output$/, '/v1/remote/terminals/:id/output'],
    ['POST', /^\/v1\/remote\/terminals\/[^/]+\/ack$/, '/v1/remote/terminals/:id/ack'],
    ['POST', /^\/v1\/remote\/terminals\/[^/]+\/input$/, '/v1/remote/terminals/:id/input'],
    ['POST', /^\/v1\/remote\/terminals\/[^/]+\/resize$/, '/v1/remote/terminals/:id/resize'],
    ['GET', /^\/v1\/remote\/browsers\/[^/]+\/tabs$/, '/v1/remote/browsers/:id/tabs'], ['POST', /^\/v1\/remote\/browsers\/[^/]+\/tabs$/, '/v1/remote/browsers/:id/tabs'],
    ['DELETE', /^\/v1\/remote\/browsers\/[^/]+\/tabs\/[^/]+$/, '/v1/remote/browsers/:id/tabs/:tab'],
    ['POST', /^\/v1\/remote\/browsers\/[^/]+\/tabs\/[^/]+\/action$/, '/v1/remote/browsers/:id/tabs/:tab/action'],
    ['GET', /^\/v1\/remote\/browsers\/[^/]+\/frames$/, '/v1/remote/browsers/:id/frames'],
    ['POST', /^\/v1\/remote\/browsers\/[^/]+\/view$/, '/v1/remote/browsers/:id/view'],
    ['POST', /^\/v1\/remote\/browsers\/[^/]+\/ack$/, '/v1/remote/browsers/:id/ack'],
    ['GET', /^\/v1\/remote\/web\/candidates$/, '/v1/remote/web/candidates'],
    ['GET', /^\/v1\/remote\/web\/apps$/, '/v1/remote/web/apps'], ['POST', /^\/v1\/remote\/web\/apps$/, '/v1/remote/web/apps'],
    ['DELETE', /^\/v1\/remote\/web\/apps\/[^/]+$/, '/v1/remote/web/apps/:id'],
    ['POST', /^\/v1\/remote\/web\/apps\/[^/]+\/open$/, '/v1/remote/web/apps/:id/open'],
    ['POST', /^\/v1\/remote\/web\/apps\/[^/]+\/close$/, '/v1/remote/web/apps/:id/close'],
    ['GET', /^\/v1\/remote\/web\/apps\/[^/]+\/authorizations$/, '/v1/remote/web/apps/:id/authorizations'],
    ['POST', /^\/v1\/remote\/web\/apps\/[^/]+\/authorizations$/, '/v1/remote/web/apps/:id/authorizations'],
    ['POST', /^\/v1\/remote\/web\/apps\/[^/]+\/authorizations\/[^/]+\/cancel$/, '/v1/remote/web/apps/:id/authorizations/:accessId/cancel'],
    ['POST', /^\/v1\/remote\/files\/(list|read|create|move|delete|search|saves|uploads|downloads)$/, pathname],
    ['PUT', /^\/v1\/remote\/files\/saves\/[^/]+\/[^/]+$/, '/v1/remote/files/saves/:id/:offset'],
    ['POST', /^\/v1\/remote\/files\/saves\/[^/]+\/commit$/, '/v1/remote/files/saves/:id/commit'],
    ['PUT', /^\/v1\/remote\/files\/uploads\/[^/]+\/[^/]+$/, '/v1/remote/files/uploads/:id/:offset'],
    ['POST', /^\/v1\/remote\/files\/uploads\/[^/]+\/commit$/, '/v1/remote/files/uploads/:id/commit'],
    ['GET', /^\/v1\/remote\/files\/downloads\/[^/]+\/[^/]+$/, '/v1/remote/files/downloads/:id/:offset'],
    ['POST', /^\/v1\/remote\/operations\/[^/]+\/cancel$/, '/v1/remote/operations/:id/cancel'],
    ['POST', /^\/v1\/remote\/operations\/[^/]+\/ack$/, '/v1/remote/operations/:id/ack'],
    ['GET', /^\/v1\/remote\/operations\/[^/]+\/events$/, '/v1/remote/operations/:id/events'],
    ['GET', /^\/health$/, '/health'], ['GET', /^\/v1\/whoami$/, '/v1/whoami'], ['POST', /^\/v1\/pair$/, '/v1/pair'],
    ['GET', /^\/v1\/agents\/[^/]+\/details$/, '/v1/agents/:id/details'], ['POST', /^\/v1\/agents\/[^/]+\/(approval-mode|block-rules)$/, '/v1/agents/:id/security'], ['GET', /^\/v1\/(server|agents|approvals|decisions|gateway|logs|model|jobs|usage|board|discovery|activity|widget|metrics)$/, pathname], ['POST', /^\/v1\/doctor$/, '/v1/doctor'],
    ['GET', /^\/v1\/agents\/[^/]+\/transcript$/, '/v1/agents/:id/transcript'], ['POST', /^\/v1\/agents\/[^/]+\/runs$/, '/v1/agents/:id/runs'],
    ['GET', /^\/v1\/agents\/[^/]+\/chat$/, '/v1/agents/:id/chat'],
    ['GET', /^\/v1\/agents\/[^/]+\/conversations\/[^/]+\/files(?:\/[^/]+)?$/, '/v1/agents/:id/conversations/:conversationId/files/:fileId'],
    ['GET', /^\/v1\/agents\/[^/]+\/tools$/, '/v1/agents/:id/tools'],
    ['GET', /^\/v1\/agents\/[^/]+\/skills$/, '/v1/agents/:id/skills'],
    ['POST', /^\/v1\/agents\/[^/]+\/tools\/[^/]+$/, '/v1/agents/:id/tools/:toolset'],
    ['GET', /^\/v1\/agents\/[^/]+\/memory$/, '/v1/agents/:id/memory'],
    ['PATCH', /^\/v1\/agents\/[^/]+\/memory$/, '/v1/agents/:id/memory'],
    ['GET', /^\/v1\/agents\/[^/]+\/soul$/, '/v1/agents/:id/soul'],
    ['PUT', /^\/v1\/agents\/[^/]+\/soul$/, '/v1/agents/:id/soul'],
    ['GET', /^\/v1\/agents\/[^/]+\/models$/, '/v1/agents/:id/models'],
    ['PUT', /^\/v1\/agents\/[^/]+\/conversations\/[^/]+\/model$/, '/v1/agents/:id/conversations/:conversationId/model'],
    ['GET', /^\/v1\/agents\/[^/]+\/conversations$/, '/v1/agents/:id/conversations'],
    ['POST', /^\/v1\/agents\/[^/]+\/conversations$/, '/v1/agents/:id/conversations'],
    ['GET', /^\/v1\/agents\/[^/]+\/conversations\/search$/, '/v1/agents/:id/conversations/search'],
    ['GET', /^\/v1\/agents\/[^/]+\/conversations\/[^/]+\/deletion$/, '/v1/agents/:id/conversations/:conversationId/deletion'],
    ['GET', /^\/v1\/agents\/[^/]+\/conversations\/[^/]+$/, '/v1/agents/:id/conversations/:conversationId'],
    ['PATCH', /^\/v1\/agents\/[^/]+\/conversations\/[^/]+$/, '/v1/agents/:id/conversations/:conversationId'],
    ['DELETE', /^\/v1\/agents\/[^/]+\/conversations\/[^/]+$/, '/v1/agents/:id/conversations/:conversationId'],
    ['GET', /^\/v1\/runs\/[^/]+\/events$/, '/v1/runs/:id/events'], ['POST', /^\/v1\/runs\/[^/]+\/stop$/, '/v1/runs/:id/stop'],
    ['GET', /^\/v1\/server\/control$/, '/v1/server/control'],
    ['POST', /^\/v1\/server\/(pause|resume)$/, '/v1/server/:control'],
    ['GET', /^\/v1\/runs\/[^/]+$/, '/v1/runs/:id'],
    ['POST', /^\/v1\/runs\/[^/]+\/steer$/, '/v1/runs/:id/steer'],
    ['POST', /^\/v1\/runs\/[^/]+\/reconnect$/, '/v1/runs/:id/reconnect'],
    ['POST', /^\/v1\/approvals\/[^/]+$/, '/v1/approvals/:id'], ['POST', /^\/v1\/gateway\/(start|stop|restart)$/, '/v1/gateway/:action'],
  ];
  return routes.find(([verb, pattern]) => method === verb && pattern.test(pathname))?.[2] ?? 'unmatched';
}
