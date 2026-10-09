// /v1/remote/*, delegated by server.ts after the key, the limiter and guardAuthorization.
// Order (ADR 0006 «Peticiones remotas»): protocol, then route, then capability.
import type http from 'node:http';
import {
  CHAT_PROTOCOL_HEADER, MIN_APP_PROTOCOL_VERSION, PROTOCOL_VERSION, REMOTE_CAPABILITY_HEADER, REMOTE_CAPABILITY_NAMES,
  REMOTE_ERROR_MESSAGES, REMOTE_ERROR_STATUS, REMOTE_ID_PATTERN,
} from '../../../protocol/protocol.ts';
import type { CapabilityAdvertisement, RemoteCapabilityName, RemoteErrorCode, RemoteStatus, RemoteUnavailableReason, ToolAvailability } from '../../../protocol/protocol.ts';
import { BROWSER_TAB_PATTERN } from '../../../protocol/remoteBrowser.ts';
import type { ChangeRecord } from '../changeLog.ts';
import type { Browsers } from './browsers.ts';
import type { Environments } from './environments.ts';
import type { RemoteTools } from './ports.ts';
import type { Terminals } from './terminals.ts';
import type { WebApps } from './web.ts';

const ROUTE_ERRORS = {
  // Own text: the Conversaciones one would be wrong here, and either side may be the older one.
  protocol_upgrade_required: [426, 'Relay y este Puente no comparten versión de protocolo para las herramientas remotas. Actualiza el más antiguo.'],
  not_found: [404, 'Not found.'],
} as const;

export class RemoteError extends Error {
  status: number;
  code: RemoteErrorCode | keyof typeof ROUTE_ERRORS;
  constructor(code: RemoteErrorCode | keyof typeof ROUTE_ERRORS) {
    const [status, message] = Object.hasOwn(ROUTE_ERRORS, code)
      ? ROUTE_ERRORS[code as keyof typeof ROUTE_ERRORS]
      : [REMOTE_ERROR_STATUS[code as RemoteErrorCode], REMOTE_ERROR_MESSAGES[code as RemoteErrorCode]];
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * An SSE response the server opens once the route returns it. `start` gets the writer and the end of
 * the response and answers how to stop: called on every ending (client gone, revocation, supervisor).
 */
export class RemoteStream<Event = unknown> {
  start: (send: (event: Event, id?: number) => void, end: () => void) => () => void;
  constructor(start: RemoteStream<Event>['start']) { this.start = start; }
}

/** Exactly what this build implements. terminal and browser need environments to mean anything. */
export function advertise(tools: RemoteTools): Partial<Record<RemoteCapabilityName, CapabilityAdvertisement>> {
  const advertised: Partial<Record<RemoteCapabilityName, CapabilityAdvertisement>> = {};
  for (const name of REMOTE_CAPABILITY_NAMES) {
    const tool = tools[name];
    if (!tool || ((name === 'terminal' || name === 'browser') && !tools.environments)) continue;
    advertised[name] = { version: tool.capability.version, minAppVersion: tool.capability.minAppVersion };
  }
  return advertised;
}

const DECIMAL = '(0|[1-9][0-9]*)';

export interface RemoteContext {
  now: () => number;
  /** Present whenever `environments` is wired. */
  environments: Environments | null;
  /** Present whenever `terminal` is wired. */
  terminals: Terminals | null;
  /** Present whenever `web` is wired. */
  web: WebApps | null;
  /** Present whenever `browser` is wired: both modes. */
  browsers: Browsers | null;
  deviceId: string;
  actor: () => ChangeRecord['actor'];
  guard: () => void;
  /** The JSON body, at most REMOTE_LIMITS.controlBodyBytes, guarded again once read. */
  body: () => Promise<unknown>;
  /** A raw body, at most REMOTE_LIMITS.transferChunkBytes, guarded again once read. */
  bytes: () => Promise<Buffer>;
  /** The Last-Event-ID header: where an output stream resumes. */
  lastEventId: unknown;
}

interface Route { capability: RemoteCapabilityName | null; run: (tools: RemoteTools, context: RemoteContext) => Promise<unknown> }

/** IDs are checked before use: anything else is answered like a foreign or missing one. */
function remoteId(value: string | undefined, prefix: 'env_' | 'app_' | 'acc_'): string {
  if (!value || !new RegExp(REMOTE_ID_PATTERN).test(value) || !value.startsWith(prefix)) throw new RemoteError('remote_not_found');
  return value;
}

const writer = (c: RemoteContext) => ({ guard: c.guard, actor: c.actor(), deviceId: c.deviceId });

function resolve(method: string, parts: string[]): Route | null {
  const [, , resource, id, action] = parts;
  // GET /v1/remote/status serves every tool, so any advertised capability opens it.
  if (resource === 'status') return parts.length === 3 && method === 'GET' ? { capability: null, run: (tools, c) => remoteStatus(tools, c.now) } : null;
  if (resource === 'shells') return parts.length === 3 && method === 'GET' ? { capability: 'terminal', run: (_, c) => c.terminals!.shells() } : null;
  if (resource === 'web') return resolveWeb(method, parts);
  if (resource === 'files') {
    const capability = 'files';
    // Chunks go raw, by offset; an operation's ID and an offset are no path and may travel in the URL.
    if (id === 'saves' || id === 'uploads') {
      const [operation, step] = parts.slice(4);
      const [start, chunk, commit] = id === 'saves' ? ['startSave', 'saveChunk', 'commitSave'] as const : ['startUpload', 'uploadChunk', 'commitUpload'] as const;
      if (parts.length === 4 && method === 'POST') return { capability, run: async (tools, c) => tools.files!.port[start](await c.body(), writer(c)) };
      if (parts.length === 6 && method === 'POST' && step === 'commit') return { capability, run: async (tools, c) => tools.files!.port[commit](operation!, await c.body(), writer(c)) };
      if (parts.length === 6 && method === 'PUT') return { capability, run: async (tools, c) => tools.files!.port[chunk](operation!, step!, await c.bytes(), writer(c)) };
      return null;
    }
    if (id === 'downloads') {
      if (parts.length === 4 && method === 'POST') return { capability, run: async (tools, c) => tools.files!.port.startDownload(await c.body(), writer(c)) };
      if (parts.length === 6 && method === 'GET') return { capability, run: async (tools, c) => tools.files!.port.downloadChunk(parts[4]!, parts[5]!, writer(c)) };
      return null;
    }
    // Paths travel only in the body: every other operation is a POST, listing and reading too.
    if (parts.length !== 4 || method !== 'POST') return null;
    if (id === 'list' || id === 'read') return { capability, run: async (tools, c) => tools.files!.port[id](await c.body()) };
    if (id === 'create' || id === 'move' || id === 'delete') return { capability, run: async (tools, c) => tools.files!.port[id](await c.body(), writer(c)) };
    if (id === 'search') return { capability, run: async (tools, c) => tools.files!.port.startSearch(await c.body(), writer(c)) };
    return null;
  }
  // Long operations: today all of them belong to `files` (saves, transfers, searches).
  if (resource === 'operations') {
    if (parts.length !== 5) return null;
    if (action === 'events' && method === 'GET') return { capability: 'files', run: async (tools, c) => tools.files!.port.events(id!, c.lastEventId, writer(c)) };
    if (method !== 'POST') return null;
    if (action === 'cancel') return { capability: 'files', run: async (tools, c) => tools.files!.port.cancel(id!, writer(c)) };
    if (action === 'ack') return { capability: 'files', run: async (tools, c) => tools.files!.port.ack(id!, await c.body(), writer(c)) };
    return null;
  }
  if (resource === 'terminals') {
    if (parts.length !== 5) return null;
    const capability = 'terminal';
    if (action === 'output' && method === 'GET') return { capability, run: (_, c) => c.terminals!.open(c.deviceId, remoteId(id, 'env_'), c.lastEventId, c.guard) };
    if (method !== 'POST') return null;
    if (action === 'ack') return { capability, run: async (_, c) => c.terminals!.ack(c.deviceId, remoteId(id, 'env_'), await c.body()) };
    if (action === 'input') return { capability, run: async (_, c) => c.terminals!.input(c.deviceId, remoteId(id, 'env_'), await c.body()) };
    if (action === 'resize') return { capability, run: async (_, c) => c.terminals!.resize(c.deviceId, remoteId(id, 'env_'), await c.body()) };
    return null;
  }
  if (resource === 'browsers') return resolveBrowser(method, parts);
  if (resource !== 'environments') return null;
  const capability = 'environments';
  if (parts.length === 3 && method === 'GET') return { capability, run: (_, c) => c.environments!.list(c.deviceId) };
  if (parts.length === 3 && method === 'POST') return { capability, run: async (_, c) => c.environments!.create(c.deviceId, c.actor(), await c.body(), c.guard) };
  if (parts.length === 5 && action === 'terminate' && method === 'POST') {
    return { capability, run: async (_, c) => c.environments!.terminate(c.deviceId, c.actor(), remoteId(id, 'env_'), await c.body(), c.guard) };
  }
  if (parts.length === 4 && method === 'DELETE') return { capability, run: (_, c) => c.environments!.discard(c.deviceId, c.actor(), remoteId(id, 'env_'), c.guard) };
  return null;
}

/** /v1/remote/browsers/:id/…: a browser is addressed by its environment ID, a tab by the browser's own ID. */
function resolveBrowser(method: string, parts: string[]): Route | null {
  // Tab IDs are checked before use: anything else is answered like a missing tab.
  const browserTab = (value: string | undefined) => {
    if (!value || !new RegExp(BROWSER_TAB_PATTERN).test(value)) throw new RemoteError('remote_not_found');
    return value;
  };
  const [, , , id, collection, tab, action] = parts;
  const capability = 'browser';
  if (parts.length === 5 && collection === 'tabs' && method === 'GET') return { capability, run: (_, c) => c.browsers!.tabs(c.deviceId, remoteId(id, 'env_')) };
  if (parts.length === 5 && collection === 'tabs' && method === 'POST') return { capability, run: async (_, c) => c.browsers!.open(c.deviceId, remoteId(id, 'env_'), await c.body()) };
  if (parts.length === 5 && collection === 'frames' && method === 'GET') return { capability, run: (_, c) => c.browsers!.frames(c.deviceId, remoteId(id, 'env_'), c.guard) };
  if (parts.length === 5 && (collection === 'view' || collection === 'ack') && method === 'POST') {
    return { capability, run: async (_, c) => c.browsers![collection](c.deviceId, remoteId(id, 'env_'), await c.body()) };
  }
  if (collection !== 'tabs') return null;
  if (parts.length === 6 && method === 'DELETE') return { capability, run: (_, c) => c.browsers!.close(c.deviceId, remoteId(id, 'env_'), browserTab(tab)) };
  if (parts.length === 7 && action === 'action' && method === 'POST') {
    return { capability, run: async (_, c) => c.browsers!.act(c.deviceId, remoteId(id, 'env_'), browserTab(tab), await c.body()) };
  }
  return null;
}

/** /v1/remote/web/…: apps are the Server's; sessions, tickets and authorizations are the device's. */
function resolveWeb(method: string, parts: string[]): Route | null {
  const [, , , collection, id, action, accessId, verb] = parts;
  const capability = 'web';
  if (collection === 'candidates' && parts.length === 4 && method === 'GET') return { capability, run: (_, c) => c.web!.candidates() };
  if (collection !== 'apps') return null;
  if (parts.length === 4 && method === 'GET') return { capability, run: (_, c) => c.web!.list() };
  if (parts.length === 4 && method === 'POST') return { capability, run: async (_, c) => c.web!.register(c.actor(), await c.body(), c.guard) };
  if (parts.length === 5 && method === 'DELETE') return { capability, run: (_, c) => c.web!.unregister(c.actor(), remoteId(id, 'app_'), c.guard) };
  if (parts.length === 6 && method === 'POST' && action === 'open') return { capability, run: async (_, c) => c.web!.open(c.deviceId, remoteId(id, 'app_'), await c.body()) };
  if (parts.length === 6 && method === 'POST' && action === 'close') return { capability, run: (_, c) => c.web!.close(c.deviceId, remoteId(id, 'app_')) };
  if (action !== 'authorizations') return null;
  if (parts.length === 6 && method === 'GET') return { capability, run: (_, c) => c.web!.accessList(c.deviceId, remoteId(id, 'app_')) };
  if (parts.length === 6 && method === 'POST') return { capability, run: async (_, c) => c.web!.grant(c.actor(), c.deviceId, remoteId(id, 'app_'), await c.body(), c.guard) };
  if (parts.length === 8 && method === 'POST' && verb === 'cancel') {
    return { capability, run: (_, c) => c.web!.cancel(c.actor(), c.deviceId, remoteId(id, 'app_'), remoteId(accessId, 'acc_')) };
  }
  return null;
}

export async function remoteRoute(req: http.IncomingMessage, parts: string[], url: URL, tools: RemoteTools, context: RemoteContext): Promise<unknown> {
  // A range, unlike requireChatProtocol's equality. Canonical decimal only; a repeated header arrives
  // joined with ", " and fails too.
  const protocol = req.headers[CHAT_PROTOCOL_HEADER.toLowerCase()];
  const version = typeof protocol === 'string' && new RegExp(`^${DECIMAL}$`).test(protocol) ? Number(protocol) : NaN;
  if (!Number.isSafeInteger(version) || version < MIN_APP_PROTOCOL_VERSION || version > PROTOCOL_VERSION) throw new RemoteError('protocol_upgrade_required');

  const route = resolve(req.method ?? 'GET', parts);
  if (!route) throw new RemoteError('not_found');

  const advertised = advertise(tools);
  const header = req.headers[REMOTE_CAPABILITY_HEADER.toLowerCase()];
  const match = typeof header === 'string' ? new RegExp(`^([a-z]+)/${DECIMAL}$`).exec(header) : null;
  const offer = match && Object.hasOwn(advertised, match[1]!) && (route.capability === null || match[1] === route.capability)
    ? advertised[match[1] as RemoteCapabilityName] : undefined;
  const requested = Number(match?.[2]);
  if (!offer || !Number.isSafeInteger(requested) || requested < offer.minAppVersion || requested > offer.version) throw new RemoteError('remote_upgrade_required');

  if (url.search) throw new RemoteError('remote_invalid_request');
  return route.run(tools, context);
}

/**
 * A port that throws (a supervisor socket that went down, say) is unavailable, never a 500: what lives
 * in the supervisor is `helper_stopped`, what the Puente checks itself is `dependency_missing`.
 */
async function ask(availability: Promise<ToolAvailability>, failed: RemoteUnavailableReason): Promise<ToolAvailability> {
  try { return await availability; } catch { return { state: 'unavailable', reason: failed }; }
}

async function remoteStatus(tools: RemoteTools, now: () => number): Promise<RemoteStatus> {
  const status: Omit<RemoteStatus, 'serverNow'> = {};
  // Terminals and browsers run as environments: without a usable supervisor, its reason is theirs.
  const supervisor = tools.environments ? await ask(tools.environments.port.availability(), 'helper_stopped') : null;
  if (supervisor && tools.terminal) status.terminal = supervisor.state === 'available' ? await ask(tools.terminal.port.availability(), 'helper_stopped') : supervisor;
  if (tools.files) status.files = await ask(tools.files.port.availability(), 'dependency_missing');
  if (tools.web) {
    // The in-Relay viewer reaches the app by its Service name too: it needs discovery and publication.
    const apps = await ask(tools.web.port.apps.availability(), 'dependency_missing');
    const external = await ask(tools.web.port.publisher.availability(), 'dependency_missing');
    status.web = { inRelay: apps.state === 'available' ? external : apps, external };
  }
  if (supervisor && tools.browser) {
    status.browser = supervisor.state === 'available'
      ? {
        dedicated: await ask(tools.browser.port.dedicated.availability(), 'helper_stopped'),
        habitual: tools.browser.port.habitual ? await ask(tools.browser.port.habitual.availability(), 'helper_stopped') : { state: 'unavailable', reason: 'not_configured' },
      }
      : { dedicated: supervisor, habitual: supervisor };
  }
  return { serverNow: now(), ...status };
}
