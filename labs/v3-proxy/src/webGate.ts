// Simulated Puente pieces for V3 web access, as the lab under test:
//  - Authority: pending requests, one-hour grants, sessions, revocation, all in memory.
//  - Web listener: one per registered app, plain HTTP on loopback behind Serve/Services.
//    It authorizes every request and upgrade, keeps Relay's cookies away from the app and
//    the app away from Relay's cookie names, and cuts open streams on expiry or revocation.
//  - Control API: the device-key channel Relay uses to list, grant and revoke. Never cookies.
// Times are milliseconds from the injected Server clock; cookie Max-Age is seconds.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

export const GRANT_MS = 60 * 60 * 1000;
export const PENDING_MS = 5 * 60 * 1000;
export const PENDING_MAX = 20;
export const SESSION_COOKIE = '__Host-RelayWeb';
export const PENDING_COOKIE = '__Host-RelayPend';
const RESERVED = /^__host-relay/i;
const ACCESS_PATH = '/__relay/acceso';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

type Pending = { id: string; code: string; app: string; next: string; createdAt: number; used: boolean; grant?: { deviceId: string; expiresAt: number } };
type Session = { app: string; deviceId: string; expiresAt: number; cuts: Set<() => void> };

export type Grant = { expiresAt: number };
export type Redeemed = { token: string; expiresAt: number; next: string };
export type Authority = {
  deviceFor(authorization: string | undefined): string | null;
  open(app: string, next: string): { secret: string; code: string } | null;
  waiting(app: string, secret: string): { code: string } | null;
  redeem(app: string, secret: string): Redeemed | null;
  session(app: string, token: string): Session | null;
  pendingFor(app: string): { id: string; code: string; createdAt: number }[];
  grant(app: string, id: string, deviceId: string): Grant | null;
  /** Ends the app's sessions and cancels its grants the browser has not redeemed yet. */
  revokeApp(app: string): { revoked: number; cancelled: number };
  revokeDevice(deviceId: string): void;
  sweep(): void;
};
export type WebGate = { port: number; log: string[]; close(): Promise<void> };
export type ControlApi = { port: number; close(): Promise<void> };

const digest = (value: string) => createHash('sha256').update(value).digest();
const key = (value: string) => digest(value).toString('base64url');

export function createAuthority({ now, devices }: { now: () => number; devices: Record<string, string> }): Authority {
  const deviceDigests = Object.entries(devices).map(([id, k]) => ({ id, digest: digest(k) }));
  const revokedDevices = new Set<string>();
  const pending = new Map<string, Pending>(); // by key(secret)
  const sessions = new Map<string, Session>(); // by key(token)
  const live = (p: Pending) => !p.used && now() - p.createdAt < PENDING_MS;
  const end = (k: string, s: Session) => {
    sessions.delete(k);
    for (const cut of s.cuts) cut();
  };

  return {
    deviceFor(authorization) {
      const m = /^Bearer (.+)$/.exec(authorization ?? '');
      if (!m) return null;
      const presented = digest(m[1]);
      let found: string | null = null;
      for (const d of deviceDigests) if (timingSafeEqual(d.digest, presented) && !revokedDevices.has(d.id)) found = d.id;
      return found;
    },
    open(app, next) {
      if ([...pending.values()].filter((p) => p.app === app && live(p) && !p.grant).length >= PENDING_MAX) return null;
      const secret = randomBytes(32).toString('base64url');
      const chars = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      const code = `${chars.slice(0, 4)}-${chars.slice(4)}`;
      pending.set(key(secret), { id: randomBytes(9).toString('base64url'), code, app, next, createdAt: now(), used: false });
      return { secret, code };
    },
    waiting(app, secret) {
      const p = pending.get(key(secret));
      return p && p.app === app && live(p) ? { code: p.code } : null;
    },
    redeem(app, secret) {
      const p = pending.get(key(secret));
      if (!p || p.app !== app || !live(p) || !p.grant) return null;
      if (revokedDevices.has(p.grant.deviceId) || now() >= p.grant.expiresAt) return null;
      p.used = true;
      const token = randomBytes(32).toString('base64url');
      sessions.set(key(token), { app, deviceId: p.grant.deviceId, expiresAt: p.grant.expiresAt, cuts: new Set() });
      return { token, expiresAt: p.grant.expiresAt, next: p.next };
    },
    session(app, token) {
      const s = sessions.get(key(token));
      return s && s.app === app && now() < s.expiresAt && !revokedDevices.has(s.deviceId) ? s : null;
    },
    pendingFor(app) {
      return [...pending.values()]
        .filter((p) => p.app === app && live(p) && !p.grant)
        .map(({ id, code, createdAt }) => ({ id, code, createdAt }));
    },
    grant(app, id, deviceId) {
      if (revokedDevices.has(deviceId)) return null;
      const p = [...pending.values()].find((x) => x.id === id && x.app === app);
      if (!p || !live(p) || p.grant) return null;
      p.grant = { deviceId, expiresAt: now() + GRANT_MS };
      return { expiresAt: p.grant.expiresAt };
    },
    revokeApp(app) {
      let revoked = 0;
      let cancelled = 0;
      for (const [k, s] of sessions) if (s.app === app) { end(k, s); revoked += 1; }
      for (const p of pending.values()) if (p.app === app && p.grant && live(p)) { p.used = true; cancelled += 1; }
      return { revoked, cancelled };
    },
    revokeDevice(deviceId) {
      revokedDevices.add(deviceId);
      for (const [k, s] of sessions) if (s.deviceId === deviceId) end(k, s);
    },
    sweep() {
      for (const [k, s] of sessions) if (now() >= s.expiresAt) end(k, s);
      for (const [k, p] of pending) if (!live(p)) pending.delete(k);
    },
  };
}

function cookieJar(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar[part.slice(0, i).trim()] ??= part.slice(i + 1).trim();
  }
  return jar;
}

async function listen(server: http.Server, port = 0) {
  const listening = Promise.withResolvers<void>();
  server.listen(port, '127.0.0.1', listening.resolve);
  await listening.promise;
  return {
    port: (server.address() as AddressInfo).port,
    close() {
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}

function accessPage(code: string) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="2"><title>Relay · acceso ${code}</title></head>
<body><h1>Autorizar en Relay</h1><p>Abre Relay y confirma este código:</p><p><strong id="codigo">${code}</strong></p>
<p>Esta página se actualiza sola.</p></body></html>`;
}

const ACCESS_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

export async function startWebGate(opts: { app: string; publicOrigin: string; upstreamPort: number; authority: Authority; now: () => number }): Promise<WebGate> {
  const { app, publicOrigin, upstreamPort, authority, now } = opts;
  const publicHost = new URL(publicOrigin).host;
  const log: string[] = [];
  const cookieAttrs = 'Path=/; Secure; HttpOnly; SameSite=Strict';

  // Behind Serve the Host is the Service name and the scheme was HTTPS; anything else is misrouted.
  const misrouted = (req: http.IncomingMessage) => req.headers.host !== publicHost || req.headers['x-forwarded-proto'] !== 'https';

  // Unsafe methods and upgrades need the exact own Origin. Siblings under the tailnet name are
  // same-site, so SameSite cookies do not stop them; Fetch Metadata refuses their reads too.
  function allowed(req: http.IncomingMessage, upgrade: boolean) {
    if (upgrade || !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '')) return req.headers.origin === publicOrigin;
    const site = req.headers['sec-fetch-site'];
    return !site || site === 'same-origin' || site === 'none' || req.headers['sec-fetch-mode'] === 'navigate';
  }

  function upstreamHeaders(req: http.IncomingMessage, upgrade: boolean) {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (name.startsWith('tailscale-') || name === 'cookie') continue;
      if (!upgrade && HOP_BY_HOP.includes(name)) continue;
      headers[name] = value;
    }
    const kept = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).filter((c) => c && !RESERVED.test(c.split('=')[0]));
    if (kept.length) headers.cookie = kept.join('; ');
    headers['x-forwarded-proto'] = 'https';
    headers['x-forwarded-host'] = publicHost;
    return headers;
  }

  function downstreamHeaders(headers: http.IncomingHttpHeaders, upgrade: boolean) {
    const out: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headers)) {
      if (!upgrade && HOP_BY_HOP.includes(name)) continue;
      out[name] = value;
    }
    if (headers['set-cookie']) {
      // Host-only cookies, and Relay's namespace is not the app's to write. Browsers trim
      // around names and attribute names, so `Domain =x` is a Domain too; nameless is refused.
      out['set-cookie'] = headers['set-cookie'].flatMap((line) => {
        const [pair, ...attrs] = line.split(';');
        const name = pair.includes('=') ? pair.slice(0, pair.indexOf('=')).trim() : '';
        if (!name || RESERVED.test(name)) return [];
        return [[pair, ...attrs.filter((a) => a.split('=')[0].trim().toLowerCase() !== 'domain')].join(';')];
      });
    }
    if (headers.location) {
      // Resolved as the browser will, against the public origin: protocol-relative and
      // `http:/host` forms reach loopback too. Unparseable is dropped, never thrown.
      const u = URL.parse(headers.location, publicOrigin);
      if (!u) delete out.location;
      else if (['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && u.port === String(upstreamPort)) {
        out.location = `${publicOrigin}${u.pathname}${u.search}${u.hash}`;
      }
    }
    return out;
  }

  function access(req: http.IncomingMessage, res: http.ServerResponse, next: string) {
    const secret = cookieJar(req.headers.cookie)[PENDING_COOKIE];
    const redeemed = secret ? authority.redeem(app, secret) : null;
    if (redeemed) {
      res.writeHead(303, {
        location: redeemed.next,
        'cache-control': 'no-store',
        'set-cookie': [
          `${SESSION_COOKIE}=${redeemed.token}; ${cookieAttrs}; Max-Age=${Math.floor((redeemed.expiresAt - now()) / 1000)}`,
          `${PENDING_COOKIE}=; ${cookieAttrs}; Max-Age=0`,
        ],
      });
      res.end();
      return;
    }
    const waiting = secret ? authority.waiting(app, secret) : null;
    if (waiting) {
      res.writeHead(200, ACCESS_HEADERS).end(accessPage(waiting.code));
      return;
    }
    const safeNext = /^\/(?![/\\])/.test(next) && !next.startsWith('/__relay/') ? next : '/';
    const opened = authority.open(app, safeNext);
    if (!opened) {
      res.writeHead(429, ACCESS_HEADERS).end('<!doctype html><meta charset="utf-8"><p>Demasiadas solicitudes de acceso pendientes. Espera unos minutos.</p>');
      return;
    }
    res.writeHead(200, {
      ...ACCESS_HEADERS,
      'set-cookie': `${PENDING_COOKIE}=${opened.secret}; ${cookieAttrs}; Max-Age=${PENDING_MS / 1000}`,
    });
    res.end(accessPage(opened.code));
  }

  const server = http.createServer((req, res) => {
    const path = URL.parse(req.url ?? '/', 'http://gate.invalid')?.pathname;
    res.on('close', () => log.push(`${req.method} ${path ?? '-'} ${res.statusCode}`));
    if (!path) {
      res.writeHead(400).end();
      return;
    }
    if (misrouted(req)) {
      res.writeHead(421).end();
      return;
    }
    const token = cookieJar(req.headers.cookie)[SESSION_COOKIE];
    const session = token ? authority.session(app, token) : null;
    if (path.startsWith('/__relay/')) {
      if (path !== ACCESS_PATH) res.writeHead(404).end();
      else if (session) res.writeHead(303, { location: '/', 'cache-control': 'no-store' }).end();
      else access(req, res, '/');
      return;
    }
    if (!session) {
      const mode = req.headers['sec-fetch-mode'];
      const navigation = ['GET', 'HEAD'].includes(req.method ?? '') && (mode ? mode === 'navigate' : /text\/html/.test(req.headers.accept ?? ''));
      if (navigation) access(req, res, req.url ?? '/');
      else res.writeHead(401, { 'cache-control': 'no-store' }).end();
      return;
    }
    if (!allowed(req, false)) {
      res.writeHead(403).end();
      return;
    }
    const up = http.request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers: upstreamHeaders(req, false) }, (ures) => {
      res.writeHead(ures.statusCode ?? 502, downstreamHeaders(ures.headers, false));
      ures.pipe(res);
    });
    const cut = () => { up.destroy(); req.socket.destroy(); };
    session.cuts.add(cut);
    res.on('close', () => { session.cuts.delete(cut); up.destroy(); });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = URL.parse(req.url ?? '/', 'http://gate.invalid')?.pathname;
    const refuse = (status: number, text: string) => {
      log.push(`${req.method} ${path ?? '-'} ${status}`);
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (!path) return refuse(400, 'Bad Request');
    if (misrouted(req)) return refuse(421, 'Misdirected Request');
    const token = cookieJar(req.headers.cookie)[SESSION_COOKIE];
    const session = token ? authority.session(app, token) : null;
    if (!session) return refuse(401, 'Unauthorized');
    if (!allowed(req, true)) return refuse(403, 'Forbidden');
    const up = http.request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers: upstreamHeaders(req, true) });
    up.on('upgrade', (ures, usocket, uhead) => {
      log.push(`${req.method} ${path} ${ures.statusCode}`);
      const lines = [`HTTP/1.1 ${ures.statusCode} ${ures.statusMessage}`];
      for (const [name, value] of Object.entries(downstreamHeaders(ures.headers, true))) {
        for (const v of [value].flat()) lines.push(`${name}: ${v}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (uhead.length) socket.write(uhead);
      if (head.length) usocket.write(head);
      usocket.pipe(socket);
      socket.pipe(usocket);
      const cut = () => { usocket.destroy(); socket.destroy(); };
      session.cuts.add(cut);
      const done = () => { session.cuts.delete(cut); cut(); };
      usocket.on('close', done);
      socket.on('close', done);
      usocket.on('error', done);
      socket.on('error', done);
    });
    up.on('response', (ures) => { ures.resume(); refuse(ures.statusCode ?? 502, 'Upstream Refused'); });
    up.on('error', () => refuse(502, 'Bad Gateway'));
    up.end();
  });

  return { ...(await listen(server)), log };
}

export async function startControl({ authority, port }: { authority: Authority; port?: number }): Promise<ControlApi> {
  const server = http.createServer((req, res) => {
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    // The device key is the only credential; cookies are never read here.
    const deviceId = authority.deviceFor(req.headers.authorization);
    if (!deviceId) return json(401, { error: 'unauthorized' });
    const path = new URL(req.url ?? '/', 'http://control.invalid').pathname;
    let m = /^\/v1\/web\/apps\/([\w-]+)\/requests$/.exec(path);
    if (m && req.method === 'GET') return json(200, authority.pendingFor(m[1]));
    m = /^\/v1\/web\/apps\/([\w-]+)\/requests\/([\w-]+)\/grant$/.exec(path);
    if (m && req.method === 'POST') {
      const granted = authority.grant(m[1], m[2], deviceId);
      return granted ? json(200, granted) : json(404, { error: 'not_found' });
    }
    m = /^\/v1\/web\/apps\/([\w-]+)\/revoke$/.exec(path);
    if (m && req.method === 'POST') return json(200, authority.revokeApp(m[1]));
    return json(404, { error: 'not_found' });
  });
  return listen(server, port);
}
