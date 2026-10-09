// The `web` tool on the Puente's side (ADR 0006, docs/research/v3-proxy.md): discovery of the
// account's local services, the registry of the apps a person chose, one listener and one Service
// per app, the in-Relay sessions and the external one-hour authorization.
//
// - Discovery reads the socket table (AppRegistry); it never connects, so nothing is probed. Control
//   services (Hermes API and dashboard, the Puente) and the Puente's own sockets are never offered.
// - An app is a loopback address and port chosen among the current candidates, plus the identity of
//   the program that served it (executable and folder). There are no URLs, names nor DNS.
// - Opening checks that identity again and issues a single-use ticket for the native viewer. A
//   refused connection ends the app's sessions, so it is opened, and checked, again.
// - External access: a browser without a session gets a pending request bound to it by a secret
//   cookie and shown by a public code; a device grants the request whose code the person compared
//   (identity checked again), and that browser redeems it once. The hour runs from the grant on the
//   monotonic and the wall clock, ends on the first of them, is never renewed, and its end cuts the
//   session's open exchanges.
// - Everything here lives in memory and ends with the device (revocation), the app (forgotten), the
//   Puente (restart) or the target refusing a connection. In-Relay sessions also end when Relay
//   closes them (lock) or opens again; external ones when cancelled or at the end of their hour.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { REMOTE_ID_PATTERN, REMOTE_REQUEST_ID_PATTERN } from '../../../protocol/protocol.ts';
import type { ToolAvailability } from '../../../protocol/protocol.ts';
import { WEB_ENTRY_PATH, WEB_LIMITS, WEB_RESERVED_PATH_PREFIX } from '../../../protocol/remoteWeb.ts';
import type {
  RemoteWebAccessList, RemoteWebApp, RemoteWebAppList, RemoteWebAuthorization, RemoteWebCancel, RemoteWebCandidate, RemoteWebCandidateList, RemoteWebClose, RemoteWebOpen,
} from '../../../protocol/remoteWeb.ts';
import { checkStateDirectory, exactObject, isTimestamp, openPrivateFile, syncStateDirectory } from '../changeLog.ts';
import type { ChangeRecord } from '../changeLog.ts';
import type { DeviceStore } from '../deviceStore.ts';
import type { AppRegistry, ListeningSocket, ServicePublisher } from './ports.ts';
import { RemoteError } from './routes.ts';
import { startWebListener } from './webListener.ts';
import type { WebListener, WebSession } from './webListener.ts';

/** The `web` contract this build serves. */
export const WEB_CAPABILITY = { version: 1, minAppVersion: 1 } as const;
/** Hermes API, Hermes dashboard and the Puente's default port: control services, never apps. */
export const CONTROL_PORTS: readonly number[] = [8642, 9119, 8650];
/** How often a grant's timer looks at the wall clock too: the bound on cutting it after a suspension. */
export const WALL_CHECK_MS = 60_000;

type Actor = ChangeRecord['actor'];
interface Identity { exe: string; cwd: string }
interface AppRecord { id: string; name: string; address: string; port: number; identity: Identity; service: string; listenerPort: number; requestId: string; createdAt: number }
interface Ticket { appId: string; deviceId: string; path: string; expiresAt: number }
/** Granted: the hour ends at `expiresAt` on the monotonic clock or an hour after `grantedAt` on the wall clock, whichever comes first. */
interface Grant { deviceId: string; grantedAt: number; expiresAt: number; redeemed: boolean; stop: () => void }
/** A browser's pending request, by the hash of its secret, until it ends; then granted, then redeemed. */
interface Access { id: string; appId: string; code: string; path: string; createdAt: number; pendingUntil: number; grant: Grant | null }
/** `access` is null for in-Relay sessions. */
interface Session extends WebSession { appId: string; deviceId: string; access: Access | null }
/** What a ticket, an access or a session belongs to; an access nobody granted has no device. */
interface Owner { appId: string; deviceId: string | null; access: Access | null }

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export interface WebApps {
  /** In-Relay: discovery and publication are both needed, the viewer reaches the app by its Service. */
  availability(): Promise<ToolAvailability>;
  candidates(): Promise<RemoteWebCandidateList>;
  list(): Promise<RemoteWebAppList>;
  register(actor: Actor, body: unknown, guard: () => void): Promise<RemoteWebApp>;
  unregister(actor: Actor, id: string, guard: () => void): Promise<{ ok: true }>;
  open(deviceId: string, id: string, body: unknown): Promise<RemoteWebOpen>;
  close(deviceId: string, id: string): Promise<RemoteWebClose>;
  /** The app's pending requests and the authorizations this device granted. */
  accessList(deviceId: string, id: string): Promise<RemoteWebAccessList>;
  grant(actor: Actor, deviceId: string, id: string, body: unknown, guard: () => void): Promise<RemoteWebAuthorization>;
  cancel(actor: Actor, deviceId: string, id: string, accessId: string): Promise<RemoteWebCancel>;
  shutdown(): Promise<void>;
}

const hash = (value: string) => createHash('sha256').update(value).digest('base64url');

/** The loopback literal a listening address is reachable at, or null when it is not on loopback. */
function loopback(address: string): string | null {
  if (address === '0.0.0.0') return '127.0.0.1';
  if (address === '::') return '::1';
  return address === '::1' || /^127\.\d+\.\d+\.\d+$/.test(address) ? address : null;
}

function validRecord(value: unknown): value is AppRecord {
  return exactObject(value, ['id', 'name', 'address', 'port', 'identity', 'service', 'listenerPort', 'requestId', 'createdAt'])
    && typeof value.id === 'string' && new RegExp(REMOTE_ID_PATTERN).test(value.id) && value.id.startsWith('app_')
    && validName(value.name) && typeof value.address === 'string' && loopback(value.address) === value.address
    && validPort(value.port) && validPort(value.listenerPort) && exactObject(value.identity, ['exe', 'cwd'])
    && typeof value.identity.exe === 'string' && typeof value.identity.cwd === 'string'
    && typeof value.service === 'string' && /^relay-[a-z0-9]{16}$/.test(value.service)
    && typeof value.requestId === 'string' && new RegExp(REMOTE_REQUEST_ID_PATTERN).test(value.requestId) && isTimestamp(value.createdAt);
}
function validName(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= WEB_LIMITS.nameChars && !/[\x00-\x1f\x7f]/.test(value);
}
function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}
/**
 * A path inside the app the viewer starts at: never another host, never the Puente's own prefix.
 * Printable ASCII only (the viewer encodes with encodeURI): it is sent back as a Location header.
 */
function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= WEB_LIMITS.pathChars && value.startsWith('/') && !value.startsWith('//')
    && !value.includes('\\') && !/[^\x21-\x7e]/.test(value) && URL.parse(value, 'http://app.invalid')?.pathname.startsWith(WEB_RESERVED_PATH_PREFIX) === false;
}

/**
 * The registered apps in `<directory>/web-apps.json`, empty when there is none. Rejects when the file
 * is not this account's private regular file (openPrivateFile) or not valid as a whole: such a
 * registry stops the tool and is left for a person to repair.
 */
export async function readWebRegistry(directory: string): Promise<AppRecord[]> {
  let value: unknown;
  try {
    const { handle } = await openPrivateFile(path.join(directory, 'web-apps.json'), constants.O_RDONLY, false);
    try { value = JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (!exactObject(value, ['schemaVersion', 'apps']) || value.schemaVersion !== 1 || !Array.isArray(value.apps) || !value.apps.every(validRecord)
    || new Set(value.apps.map((app) => app.id)).size !== value.apps.length) throw new Error('invalid web registry');
  return value.apps;
}

export function createWebApps(options: {
  registry: AppRegistry; publisher: ServicePublisher; store: DeviceStore; now: () => number; monotonic: () => number;
  log: (line: string) => void; excludedPorts?: number[];
  /** Runs `run` after `ms` on the monotonic clock; returns its cancel. setTimeout unless a test drives the clock. */
  timer?: (ms: number, run: () => void) => () => void;
}): WebApps {
  const { registry, publisher, store, now, monotonic, log } = options;
  const timer = options.timer ?? ((ms, run) => { const handle = setTimeout(run, ms); handle.unref(); return () => clearTimeout(handle); });
  const file = path.join(store.directory, 'web-apps.json');
  const apps = new Map<string, AppRecord>();
  const listeners = new Map<string, WebListener>();
  const origins = new Map<string, string>();
  const tickets = new Map<string, Ticket>(); // by hash
  const sessions = new Map<string, Session>(); // by hash
  const accesses = new Map<string, Access>(); // by hash of the browser's pending secret
  let queue: Promise<unknown> = Promise.resolve();

  function cutSessions(match: (owner: Owner) => boolean): number {
    let ended = 0;
    for (const [key, session] of sessions) {
      if (!match(session)) continue;
      sessions.delete(key);
      for (const cut of session.cuts) cut();
      ended += 1;
    }
    return ended;
  }
  /** Sessions with their open streams, the tickets not used yet, and pending or granted access. */
  function end(match: (owner: Owner) => boolean): number {
    for (const [key, ticket] of tickets) if (match({ ...ticket, access: null })) tickets.delete(key);
    for (const [key, access] of accesses) {
      if (!match({ appId: access.appId, deviceId: access.grant?.deviceId ?? null, access })) continue;
      accesses.delete(key);
      access.grant?.stop();
    }
    return cutSessions(match);
  }
  /** A request nobody granted in five minutes, or a grant its browser did not redeem by then, is void. */
  function prune(): void {
    const at = monotonic();
    for (const [key, access] of accesses) {
      if (access.grant?.redeemed || at < access.pendingUntil) continue;
      accesses.delete(key);
      access.grant?.stop();
    }
  }
  /**
   * What is left of a grant's hour, for every check in lockstep: the monotonic clock does not run while
   * the machine sleeps and the wall clock can be set back, so the first of the two to run out ends it.
   */
  function left(grant: Grant): number {
    return Math.min(grant.expiresAt - monotonic(), grant.grantedAt + WEB_LIMITS.grantMs - now());
  }
  /** Checks a grant's hour at least every WALL_CHECK_MS: its timer runs on the monotonic clock only. */
  function expire(access: Access): void {
    const grant = access.grant!;
    const rest = left(grant);
    if (rest > 0) { grant.stop = timer(Math.min(rest, WALL_CHECK_MS), () => expire(access)); return; }
    end((owner) => owner.access === access);
    record({ kind: 'server' }, 'expired', access.appId).catch(() => log('Web change could not be recorded.'));
  }
  // A revoked or removed device keeps nothing open here: streams, sessions, tickets and grants end at once.
  const unsubscribe = store.subscribe(() => {
    const active = new Set(store.snapshot().devices.filter((device) => device.revokedAt === null).map((device) => device.id));
    end((owner) => owner.deviceId !== null && !active.has(owner.deviceId));
  });

  async function save(next: AppRecord[]): Promise<void> {
    await checkStateDirectory(store.directory);
    const existing = await openPrivateFile(file, constants.O_RDONLY, false).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    await existing?.handle.close();
    const temporary = path.join(store.directory, `.web-apps.${randomBytes(16).toString('hex')}.tmp`);
    try {
      const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, apps: next })}\n`); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, file);
      await syncStateDirectory(store.directory);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }

  async function listen(app: AppRecord, port: number): Promise<WebListener> {
    return startWebListener({
      appId: app.id, target: { address: app.address, port: app.port }, origin: () => origins.get(app.id) ?? null,
      session: (token) => {
        const session = sessions.get(hash(token));
        // Checked on every exchange too: the timer cuts what is open, this refuses what comes after.
        if (!session || session.appId !== app.id || (session.access && left(session.access.grant!) <= 0)) return null;
        return session;
      },
      redeem: (value) => {
        const key = hash(value);
        const ticket = tickets.get(key);
        if (!ticket || ticket.appId !== app.id) return null;
        tickets.delete(key);
        if (monotonic() >= ticket.expiresAt) return null;
        // One in-Relay session per device and app: entering again replaces the previous one.
        cutSessions((owner) => owner.access === null && owner.appId === app.id && owner.deviceId === ticket.deviceId);
        const token = randomBytes(32).toString('base64url');
        sessions.set(hash(token), { appId: app.id, deviceId: ticket.deviceId, access: null, cuts: new Set() });
        return { token, path: ticket.path };
      },
      access: {
        request: (next) => {
          prune();
          // Anyone who reaches the Service can ask; the cap bounds that to a few minutes of noise.
          if ([...accesses.values()].filter((access) => access.appId === app.id && !access.grant).length >= WEB_LIMITS.pendingPerApp) return null;
          const secret = randomBytes(32).toString('base64url');
          const chars = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
          const code = `${chars.slice(0, 4)}-${chars.slice(4)}`;
          accesses.set(hash(secret), {
            id: `acc_${randomBytes(16).toString('base64url')}`, appId: app.id, code, path: next,
            createdAt: now(), pendingUntil: monotonic() + WEB_LIMITS.pendingMs, grant: null,
          });
          return { secret, code };
        },
        pending: (secret) => {
          prune();
          const access = accesses.get(hash(secret));
          if (!access || access.appId !== app.id || access.grant?.redeemed) return null;
          if (!access.grant) return { code: access.code };
          // Single use: the secret is spent and the browser gets a new identifier, never the secret.
          access.grant.redeemed = true;
          const token = randomBytes(32).toString('base64url');
          sessions.set(hash(token), { appId: app.id, deviceId: access.grant.deviceId, access, cuts: new Set() });
          return { token, path: access.path, maxAgeSeconds: Math.floor(left(access.grant) / 1000) };
        },
      },
      // Whatever listens on that port now is unknown until checked again by a new open or grant.
      // ponytail: an app restart ends external authorizations too; re-check the identity on the next exchange if that hurts.
      targetDown: () => end((owner) => owner.appId === app.id && owner.deviceId !== null),
      log,
    }, port);
  }

  async function publish(app: AppRecord): Promise<void> {
    const publication = await publisher.publish(app.service, app.listenerPort).catch(() => null);
    if (publication?.state === 'published') origins.set(app.id, publication.origin);
    else origins.delete(app.id);
  }

  /** The current candidates: the account's own programs listening on loopback, minus control services. */
  async function current(): Promise<{ socket: ListeningSocket; address: string; process: NonNullable<ListeningSocket['process']> }[]> {
    const excluded = new Set([...CONTROL_PORTS, ...(options.excludedPorts ?? []), ...[...apps.values()].map((app) => app.listenerPort)]);
    const seen = new Set<string>();
    const found = [];
    for (const socket of await registry.listening()) {
      const address = loopback(socket.address);
      const key = `${address} ${socket.port}`;
      if (!address || !socket.process || socket.pid === process.pid || excluded.has(socket.port) || seen.has(key)) continue;
      seen.add(key);
      found.push({ socket, address, process: socket.process });
    }
    return found;
  }

  const ready = (async () => {
    const value = await readWebRegistry(store.directory);
    let moved = false;
    for (const app of value) {
      apps.set(app.id, app);
      let listener = await listen(app, app.listenerPort).catch(() => null);
      if (!listener) { listener = await listen(app, 0); app.listenerPort = listener.port; moved = true; }
      listeners.set(app.id, listener);
      await publish(app);
    }
    if (moved) await save([...apps.values()]);
  })();
  ready.catch(() => {});

  async function loaded(): Promise<void> {
    try { await ready; } catch { throw new RemoteError('remote_unavailable'); }
  }
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }
  function found(id: string): AppRecord {
    const app = apps.get(id);
    if (!app) throw new RemoteError('remote_not_found');
    return app;
  }
  const publicApp = (app: AppRecord): RemoteWebApp => ({ id: app.id, name: app.name, address: app.address, port: app.port, origin: origins.get(app.id) ?? null, createdAt: app.createdAt });
  const record = (actor: Actor, action: 'registered' | 'unregistered' | 'authorized' | 'cancelled' | 'expired', id: string) => store.changeLog.appendChange({ actor, action: `remote.web.${action}`, target: { kind: 'app', id } });
  /** The same program in the same folder (a restart has another PID), or nothing is served. */
  async function verify(app: AppRecord): Promise<void> {
    const serving = (await current()).find((entry) => entry.address === app.address && entry.socket.port === app.port);
    if (!serving) throw new RemoteError('remote_ended');
    if (serving.process.exe !== app.identity.exe || serving.process.cwd !== app.identity.cwd) throw new RemoteError('remote_conflict');
  }
  const publicAuthorization = ({ id, code, grant }: Access): RemoteWebAuthorization => (
    { id, code, grantedAt: grant!.grantedAt, expiresAt: grant!.grantedAt + WEB_LIMITS.grantMs, redeemed: grant!.redeemed });

  return {
    async availability() {
      const discovery = await registry.availability();
      if (discovery.state !== 'available') return discovery;
      return publisher.availability();
    },
    async candidates() {
      await loaded();
      const candidates: RemoteWebCandidate[] = (await current()).map(({ socket, address, process: owner }) => ({ address, port: socket.port, process: { name: owner.name, directory: owner.cwd } }));
      return { candidates };
    },
    async list() {
      await loaded();
      return { apps: [...apps.values()].map(publicApp) };
    },
    register(actor, body, guard) {
      return serial(async () => {
        await loaded();
        if (!exactObject(body, ['requestId', 'name', 'address', 'port']) || typeof body.requestId !== 'string'
          || !new RegExp(REMOTE_REQUEST_ID_PATTERN).test(body.requestId) || !validName(body.name)
          || typeof body.address !== 'string' || !validPort(body.port)) throw new RemoteError('remote_invalid_request');
        const { requestId, name, address, port } = body;
        const retried = [...apps.values()].find((app) => app.requestId === requestId);
        if (retried) {
          if (retried.name !== name || retried.address !== address || retried.port !== port) throw new RemoteError('remote_conflict');
          return publicApp(retried);
        }
        if ([...apps.values()].some((app) => app.address === address && app.port === port)) throw new RemoteError('remote_conflict');
        if (apps.size >= WEB_LIMITS.apps) throw new RemoteError('remote_limit_reached');
        // Only what discovery offers now, by its exact loopback address: never a URL, a name or DNS.
        const candidate = (await current()).find((entry) => entry.address === address && entry.socket.port === port);
        if (!candidate) throw new RemoteError('remote_not_found');
        guard();
        const app: AppRecord = {
          id: `app_${randomBytes(16).toString('base64url')}`, name, address, port,
          identity: { exe: candidate.process.exe, cwd: candidate.process.cwd },
          // Neutral and never reused: an origin keeps caches and service workers of the app it served.
          service: `relay-${randomBytes(10).toString('hex').slice(0, 16)}`, listenerPort: 0, requestId, createdAt: now(),
        };
        const listener = await listen(app, 0);
        app.listenerPort = listener.port;
        try { await save([...apps.values(), app]); } catch {
          await listener.close();
          throw new RemoteError('remote_unavailable');
        }
        apps.set(app.id, app);
        listeners.set(app.id, listener);
        await publish(app);
        await record(actor, 'registered', app.id);
        return publicApp(app);
      });
    },
    unregister(actor, id, guard) {
      return serial(async () => {
        await loaded();
        const app = found(id);
        guard();
        try { await save([...apps.values()].filter((other) => other.id !== id)); } catch { throw new RemoteError('remote_unavailable'); }
        apps.delete(id);
        origins.delete(id);
        end((owner) => owner.appId === id);
        await listeners.get(id)?.close();
        listeners.delete(id);
        await publisher.unpublish(app.service).catch(() => {});
        await record(actor, 'unregistered', id);
        return { ok: true };
      });
    },
    async open(deviceId, id, body) {
      await loaded();
      const app = found(id);
      if (!exactObject(body, ['path']) || !validPath(body.path)) throw new RemoteError('remote_invalid_request');
      await verify(app);
      if (!origins.has(id)) await publish(app);
      const origin = origins.get(id);
      if (!origin || apps.get(id) !== app) throw new RemoteError('remote_unavailable');
      // A device revoked meanwhile never receives it: the response checks the device before sending.
      for (const [key, ticket] of tickets) if (ticket.appId === id && ticket.deviceId === deviceId) tickets.delete(key);
      const ticket = randomBytes(32).toString('base64url');
      tickets.set(hash(ticket), { appId: id, deviceId, path: body.path, expiresAt: monotonic() + WEB_LIMITS.ticketMs });
      return { origin, entryPath: WEB_ENTRY_PATH, ticket, expiresAt: now() + WEB_LIMITS.ticketMs };
    },
    async close(deviceId, id) {
      await loaded();
      found(id);
      return { closed: end((owner) => owner.access === null && owner.appId === id && owner.deviceId === deviceId) };
    },
    async accessList(deviceId, id) {
      await loaded();
      found(id);
      prune();
      const own = [...accesses.values()].filter((access) => access.appId === id);
      return {
        serverNow: now(),
        requests: own.filter((access) => !access.grant).map(({ id: request, code, createdAt }) => ({ id: request, code, createdAt, expiresAt: createdAt + WEB_LIMITS.pendingMs })),
        authorizations: own.filter((access) => access.grant?.deviceId === deviceId).map(publicAuthorization),
      };
    },
    async grant(actor, deviceId, id, body, guard) {
      await loaded();
      const app = found(id);
      if (!exactObject(body, ['request', 'code']) || typeof body.request !== 'string' || !new RegExp(REMOTE_ID_PATTERN).test(body.request)
        || !body.request.startsWith('acc_') || typeof body.code !== 'string' || body.code.length === 0 || body.code.length > 16) throw new RemoteError('remote_invalid_request');
      // The browser will be served whatever listens there now: the same check as opening in Relay.
      await verify(app);
      if (!origins.has(id) || apps.get(id) !== app) throw new RemoteError('remote_unavailable');
      prune();
      // The ID alone is not enough: the code is what the person compared with the browser's page.
      const access = [...accesses.values()].find((entry) => entry.id === body.request && entry.appId === id && !entry.grant);
      if (!access || access.code !== body.code) throw new RemoteError('remote_not_found');
      // The same synchronous step as the grant: a revocation that landed during the checks wins.
      guard();
      const grant: Grant = { deviceId, grantedAt: now(), expiresAt: monotonic() + WEB_LIMITS.grantMs, redeemed: false, stop: () => {} };
      access.grant = grant;
      expire(access); // nothing ends yet: it arms the timer that checks the hour
      await record(actor, 'authorized', id);
      return publicAuthorization(access);
    },
    async cancel(actor, deviceId, id, accessId) {
      await loaded();
      found(id);
      prune();
      const access = [...accesses.values()].find((entry) => entry.id === accessId && entry.appId === id && entry.grant?.deviceId === deviceId);
      if (!access) throw new RemoteError('remote_not_found');
      end((owner) => owner.access === access);
      await record(actor, 'cancelled', id);
      return { ok: true };
    },
    async shutdown() {
      await ready.catch(() => {});
      unsubscribe();
      end(() => true);
      await Promise.all([...listeners.values()].map((listener) => listener.close()));
      listeners.clear();
    },
  };
}
