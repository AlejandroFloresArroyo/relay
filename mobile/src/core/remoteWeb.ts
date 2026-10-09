// The `web` tool on the app's side (#89, #90, ADR 0006): the services the Puente discovered, the apps
// a person chose, the in-Relay viewer's single-use entry, and the external one-hour authorization that
// Relay grants once the person compared the code the browser shows. Answers are read defensively:
// anything this app cannot read is an unexpected answer, never an app, an entry or an authorization.
// Times are the Server's; show them with `serverNow`.
import { REMOTE_ID_PATTERN } from '../../../protocol/protocol.ts';
import { WEB_ACCESS_CODE_PATTERN, WEB_ENTRY_PATH, WEB_LIMITS, WEB_RESERVED_PATH_PREFIX } from '../../../protocol/remoteWeb.ts';
import type {
  RemoteWebAccessList, RemoteWebAccessRequest, RemoteWebApp, RemoteWebAuthorization, RemoteWebCandidate,
} from '../../../protocol/remoteWeb.ts';
import { RemoteFailure } from './remoteClient.ts';
import type { RemoteClient } from './remoteClient.ts';

const ACCESS_ID = new RegExp(REMOTE_ID_PATTERN);
const CODE = new RegExp(WEB_ACCESS_CODE_PATTERN);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
/** An access ID and its public code, as the Puente issues them. */
function access(value: Record<string, unknown>): boolean {
  return typeof value.id === 'string' && ACCESS_ID.test(value.id) && value.id.startsWith('acc_') && typeof value.code === 'string' && CODE.test(value.code);
}
function request(value: unknown): value is RemoteWebAccessRequest {
  return record(value) && access(value) && time(value.createdAt) && time(value.expiresAt);
}
function authorization(value: unknown): value is RemoteWebAuthorization {
  return record(value) && access(value) && time(value.grantedAt) && time(value.expiresAt) && typeof value.redeemed === 'boolean';
}
const unreadable = () => new RemoteFailure('unexpected', { status: 200 });

/** The app's pending requests (any device may grant them) and what this device granted. */
export async function listWebAccess(client: RemoteClient, appId: string): Promise<RemoteWebAccessList> {
  const body = await client.request('GET', `/v1/remote/web/apps/${appId}/authorizations`);
  if (!record(body) || !time(body.serverNow) || !Array.isArray(body.requests) || !body.requests.every(request)
    || !Array.isArray(body.authorizations) || !body.authorizations.every(authorization)) throw unreadable();
  return { serverNow: body.serverNow, requests: body.requests, authorizations: body.authorizations };
}

/** Grants the request whose code the person compared; the Puente refuses it with any other code. */
export async function grantWebAccess(client: RemoteClient, appId: string, pending: Pick<RemoteWebAccessRequest, 'id' | 'code'>): Promise<RemoteWebAuthorization> {
  const body = await client.request('POST', `/v1/remote/web/apps/${appId}/authorizations`, { request: pending.id, code: pending.code });
  if (!authorization(body) || body.id !== pending.id || body.code !== pending.code) throw unreadable();
  return body;
}

/** Ends one of this device's authorizations and cuts what its browser has open. */
export async function cancelWebAccess(client: RemoteClient, appId: string, accessId: string): Promise<void> {
  const body = await client.request('POST', `/v1/remote/web/apps/${appId}/authorizations/${accessId}/cancel`);
  if (!record(body) || body.ok !== true) throw unreadable();
}

const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1)$/;
const TICKET = /^[A-Za-z0-9_-]{43}$/;
const port = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
/** An HTTPS origin and nothing more: no path, no query, no credentials. */
const httpsOrigin = (value: unknown): value is string => typeof value === 'string' && value.startsWith('https://') && URL.parse(value)?.origin === value;

function candidate(value: unknown): value is RemoteWebCandidate {
  return record(value) && typeof value.address === 'string' && LOOPBACK.test(value.address) && port(value.port)
    && record(value.process) && typeof value.process.name === 'string' && typeof value.process.directory === 'string';
}
function app(value: unknown): value is RemoteWebApp {
  return record(value) && typeof value.id === 'string' && ACCESS_ID.test(value.id) && value.id.startsWith('app_') && typeof value.name === 'string'
    && typeof value.address === 'string' && LOOPBACK.test(value.address) && port(value.port) && (value.origin === null || httpsOrigin(value.origin)) && time(value.createdAt);
}
function required<T>(value: unknown, read: (value: unknown) => value is T): T {
  if (!read(value)) throw unreadable();
  return value;
}

/** What the native viewer loads: a form POST of the ticket to the app's own origin, never a URL with it. */
export interface WebEntry { origin: string; uri: string; body: string }

export interface WebApi {
  candidates(): Promise<RemoteWebCandidate[]>;
  apps(): Promise<RemoteWebApp[]>;
  /** Only a current candidate, by its exact loopback address; the same requestId answers the same app. */
  register(requestId: string, name: string, chosen: Pick<RemoteWebCandidate, 'address' | 'port'>): Promise<RemoteWebApp>;
  /** Forgets the app: the Puente cuts its sessions and authorizations. */
  forget(appId: string): Promise<void>;
  open(chosen: RemoteWebApp, path: string): Promise<WebEntry>;
  /** Ends this device's in-Relay session of the app; external authorizations are untouched. */
  close(appId: string): Promise<void>;
  access(appId: string): Promise<RemoteWebAccessList>;
  grant(appId: string, pending: Pick<RemoteWebAccessRequest, 'id' | 'code'>): Promise<RemoteWebAuthorization>;
  cancel(appId: string, accessId: string): Promise<void>;
}

/** `web` gives a client of the web capability, built right before each call. */
export function webApi(web: () => RemoteClient): WebApi {
  const id = (appId: string) => {
    if (!ACCESS_ID.test(appId) || !appId.startsWith('app_')) throw new Error('Not an app ID.');
    return appId;
  };
  const at = (appId: string) => `/v1/remote/web/apps/${id(appId)}`;
  return {
    async candidates() {
      const body = await web().request('GET', '/v1/remote/web/candidates');
      return required(record(body) ? body.candidates : null, (v): v is RemoteWebCandidate[] => Array.isArray(v) && v.every(candidate));
    },
    async apps() {
      const body = await web().request('GET', '/v1/remote/web/apps');
      return required(record(body) ? body.apps : null, (v): v is RemoteWebApp[] => Array.isArray(v) && v.every(app));
    },
    register: async (requestId, name, chosen) => required(await web().request('POST', '/v1/remote/web/apps', { requestId, name, address: chosen.address, port: chosen.port }), app),
    async forget(appId) {
      const body = await web().request('DELETE', at(appId));
      if (!record(body) || body.ok !== true) throw unreadable();
    },
    async open(chosen, path) {
      const body = await web().request('POST', `${at(chosen.id)}/open`, { path });
      // An entry for any other origin than the app's own would hand the ticket to another site.
      if (!record(body) || !httpsOrigin(body.origin) || (chosen.origin !== null && body.origin !== chosen.origin) || body.entryPath !== WEB_ENTRY_PATH
        || typeof body.ticket !== 'string' || !TICKET.test(body.ticket) || !time(body.expiresAt)) throw unreadable();
      return { origin: body.origin, uri: `${body.origin}${WEB_ENTRY_PATH}`, body: `ticket=${body.ticket}` };
    },
    async close(appId) {
      const body = await web().request('POST', `${at(appId)}/close`);
      if (!record(body) || !time(body.closed)) throw unreadable();
    },
    access: (appId) => listWebAccess(web(), id(appId)),
    grant: (appId, pending) => grantWebAccess(web(), id(appId), pending),
    cancel: (appId, accessId) => cancelWebAccess(web(), id(appId), accessId),
  };
}

/**
 * Where a navigation of the viewer goes. The app's own origin stays in Relay; any other web opens in the
 * phone's browser and grants nothing; a loopback address there is the phone itself, never the Servidor,
 * so it marks an app that does not follow the proxy contract; any other scheme (intent:, tel:, file:,
 * javascript:) is refused. The authority stays with the Puente: this decides only what the viewer shows.
 */
export type WebNavigation = 'inside' | 'external' | 'local' | 'refused';
export function webNavigation(url: string, origin: string): WebNavigation {
  if (url === 'about:blank' || url === 'about:srcdoc') return 'inside';
  const parsed = URL.parse(url);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return 'refused';
  if (parsed.origin === origin) return 'inside';
  const host = parsed.hostname;
  return host === 'localhost' || host === '[::1]' || host === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(host) ? 'local' : 'external';
}

/** A path the Puente accepts to open: inside the app, printable ASCII, never its reserved prefix. */
function insidePath(path: string): string | null {
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') && /^[\x21-\x7e]+$/.test(path) && path.length <= WEB_LIMITS.pathChars
    && URL.parse(path, 'https://app.invalid')?.pathname.startsWith(WEB_RESERVED_PATH_PREFIX) === false ? path : null;
}

/** Where the viewer is in the app, to come back to it; null outside it. */
export function webPathOf(url: string, origin: string): string | null {
  const parsed = URL.parse(url);
  return parsed?.origin === origin ? insidePath(`${parsed.pathname}${parsed.search}${parsed.hash}`) : null;
}

/** What the person typed as a path inside the app, encoded; null if it names another site or the Puente's prefix. */
export function webPathInput(text: string): string | null {
  const typed = text.trim();
  if (!typed || /^[a-z][a-z0-9+.-]*:/i.test(typed)) return null;
  const path = typed.startsWith('/') ? typed : `/${typed}`;
  return insidePath(/^[\x21-\x7e]+$/.test(path) ? path : encodeURI(path));
}

/** «127.0.0.1:3000», «[::1]:5173»: the loopback address a service listens on, as a person reads it. */
export const webAddress = ({ address, port }: { address: string; port: number }) => address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`;
