// One listener per registered app, on loopback, apart from the control API: its Tailscale Service
// points here and nowhere else (docs/research/v3-proxy.md «Diseño probado del listener web»). It serves
// only its app's Service name, authorizes every request and upgrade by session, keeps Relay's cookies
// and Tailscale's identity away from the app and the app away from Relay's names, and forwards to the
// single loopback address and port registered. It never follows a redirect nor picks another target.
// Nothing a client or the app sends can throw out of a handler: the control API shares this process.
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { WEB_ENTRY_PATH, WEB_LIMITS, WEB_PENDING_COOKIE, WEB_RESERVED_PATH_PREFIX, WEB_SESSION_COOKIE } from '../../../protocol/remoteWeb.ts';

/** A live session of this listener's app: each forwarded exchange registers how to cut it. */
export interface WebSession { cuts: Set<() => void> }

export interface WebListenerOptions {
  appId: string;
  target: { address: string; port: number };
  /** The app's public origin, or null while unpublished: then nothing is served. */
  origin: () => string | null;
  session(token: string): WebSession | null;
  /** Spends a ticket: the new session's token and the path it opens, or null. */
  redeem(ticket: string): { token: string; path: string } | null;
  /** External authorization: the access page of a browser without a session. */
  access: {
    /** A new pending request that will open `path`: its secret for the cookie and its public code, or null at the cap. */
    request(path: string): { secret: string; code: string } | null;
    /** What this browser's secret waits on: its code, once granted a new session (single use), or null. */
    pending(secret: string): { code: string } | { token: string; path: string; maxAgeSeconds: number } | null;
  };
  /** The target refused a connection: its sessions end, so it is opened (and checked) again. */
  targetDown(): void;
  log(line: string): void;
}

export interface WebListener { port: number; close(): Promise<void> }

const RESERVED_COOKIE = /^__host-relay/i;
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
};
const page = (text: string) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Relay</title></head><body><p>${text}</p></body></html>`;
const NO_SESSION = page('Vuelve a abrir esta aplicación desde Relay.');
const TARGET_DOWN = page('La aplicación no responde en el Servidor. Cuando vuelva a funcionar, ábrela otra vez desde Relay.');
const TOO_MANY = page('Hay demasiadas solicitudes de acceso pendientes para esta aplicación. Espera unos minutos y recarga.');
// No script: it reloads itself until Relay grants, and the next reload redeems.
const accessPage = (code: string) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="2"><title>Relay</title></head><body><h1>Autorizar en Relay</h1><p>Abre Relay y confirma este código:</p><p><strong>${code}</strong></p><p>La autorización dura una hora. Esta página se actualiza sola.</p></body></html>`;
const COOKIE_ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Strict';

function cookies(header: string | undefined): string[] {
  return (header ?? '').split(';').map((part) => part.trim()).filter(Boolean);
}
function cookie(req: http.IncomingMessage, name: string): string | null {
  const found = cookies(req.headers.cookie).find((item) => item.startsWith(`${name}=`));
  return found === undefined ? null : found.slice(name.length + 1);
}

/** Origin-form only: `//host` and `/\host` are other hosts to a browser, and `*` or absolute forms are not paths. */
function targetPath(url: string | undefined): string | null {
  if (!url || !url.startsWith('/') || url.startsWith('//') || url.startsWith('/\\')) return null;
  return URL.parse(url, 'http://listener.invalid')?.pathname ?? null;
}

const isLoopbackName = (hostname: string) => hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname);

export async function startWebListener(options: WebListenerOptions, port = 0): Promise<WebListener> {
  const { appId, target } = options;
  const log = (method: string | undefined, status: number) => options.log(`web ${appId} ${method} ${status}`);

  // Behind Serve, Host is the Service name and the scheme was HTTPS. Defence against misrouting only:
  // any local process can send both headers; the session is the authorization.
  function publicOrigin(req: http.IncomingMessage): string | null {
    const origin = options.origin();
    return origin && req.headers.host === new URL(origin).host && req.headers['x-forwarded-proto'] === 'https' ? origin : null;
  }

  function sessionOf(req: http.IncomingMessage): WebSession | null {
    const token = cookie(req, WEB_SESSION_COOKIE);
    return token === null ? null : options.session(token);
  }

  /**
   * A navigation without a session: the browser's pending request (bound by the secret cookie, shown
   * by its code), its single-use redemption once Relay granted it, or a new one.
   */
  function access(req: http.IncomingMessage, res: http.ServerResponse): void {
    const secret = cookie(req, WEB_PENDING_COOKIE);
    const found = secret ? options.access.pending(secret) : null;
    if (found && 'token' in found) {
      res.writeHead(303, {
        location: found.path, 'cache-control': 'no-store',
        // Max-Age is seconds; the Puente still enforces the hour on its own clock.
        'set-cookie': [`${WEB_SESSION_COOKIE}=${found.token}; ${COOKIE_ATTRIBUTES}; Max-Age=${found.maxAgeSeconds}`, `${WEB_PENDING_COOKIE}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`],
      }).end();
      return;
    }
    if (found) { res.writeHead(401, PAGE_HEADERS).end(accessPage(found.code)); return; }
    // It comes back in Location: printable ASCII only, else the app's root.
    const next = req.url!.length <= WEB_LIMITS.pathChars && !/[^\x21-\x7e]/.test(req.url!) ? req.url! : '/';
    const opened = options.access.request(next);
    if (!opened) { res.writeHead(429, PAGE_HEADERS).end(TOO_MANY); return; }
    res.writeHead(401, { ...PAGE_HEADERS, 'set-cookie': `${WEB_PENDING_COOKIE}=${opened.secret}; ${COOKIE_ATTRIBUTES}; Max-Age=${WEB_LIMITS.pendingMs / 1000}` })
      .end(accessPage(opened.code));
  }

  // Unsafe methods and upgrades need the exact own Origin. Sibling Services are the same site, so
  // SameSite does not stop them; Fetch Metadata refuses their reads too.
  function allowed(req: http.IncomingMessage, origin: string, upgrade: boolean): boolean {
    if (upgrade || !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '')) return req.headers.origin === origin;
    const site = req.headers['sec-fetch-site'];
    return !site || site === 'same-origin' || site === 'none' || req.headers['sec-fetch-mode'] === 'navigate';
  }

  function upstreamHeaders(req: http.IncomingMessage, origin: string, upgrade: boolean): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (name.startsWith('tailscale-') || name === 'cookie' || (!upgrade && HOP_BY_HOP.includes(name))) continue;
      headers[name] = value;
    }
    const kept = cookies(req.headers.cookie).filter((cookie) => !RESERVED_COOKIE.test(cookie.split('=')[0]!.trim()));
    if (kept.length) headers.cookie = kept.join('; ');
    headers['x-forwarded-proto'] = 'https';
    headers['x-forwarded-host'] = new URL(origin).host;
    return headers;
  }

  function downstreamHeaders(headers: http.IncomingHttpHeaders, origin: string, upgrade: boolean): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(headers)) if (upgrade || !HOP_BY_HOP.includes(name)) out[name] = value;
    if (headers['set-cookie']) {
      // Host-only cookies, and Relay's namespace is not the app's. Browsers trim around names and
      // attribute names, so `Domain =x` is a Domain too; a nameless cookie is refused.
      out['set-cookie'] = headers['set-cookie'].flatMap((line) => {
        const [pair, ...attributes] = line.split(';');
        const name = pair!.includes('=') ? pair!.slice(0, pair!.indexOf('=')).trim() : '';
        if (!name || RESERVED_COOKIE.test(name)) return [];
        return [[pair, ...attributes.filter((attribute) => attribute.split('=')[0]!.trim().toLowerCase() !== 'domain')].join(';')];
      });
    }
    if (headers.location !== undefined) {
      // Resolved as the browser will, against the public origin: protocol-relative and `http:/host`
      // forms reach loopback too. Only the app's own port is rewritten; unparseable is dropped.
      const url = URL.parse(headers.location, origin);
      const port = url && Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      if (!url) delete out.location;
      else if (['http:', 'https:'].includes(url.protocol) && port === target.port
        && (isLoopbackName(url.hostname) || url.hostname === target.address || url.hostname === `[${target.address}]`)) {
        out.location = `${origin}${url.pathname}${url.search}${url.hash}`;
      }
    }
    return out;
  }

  function entry(req: http.IncomingMessage, res: http.ServerResponse, origin: string): void {
    // The ticket is the authority here; a page of another origin cannot post one.
    if (req.headers.origin !== undefined && req.headers.origin !== 'null' && req.headers.origin !== origin) { res.writeHead(403).end(); return; }
    if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { res.writeHead(400).end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Answered at once; the rest is drained and dropped, and the connection closes after it.
      if (size > WEB_LIMITS.entryBodyBytes && !res.headersSent) res.writeHead(413, { connection: 'close' }).end();
      if (!res.headersSent) chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.headersSent) return;
      const ticket = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('ticket');
      const redeemed = ticket ? options.redeem(ticket) : null;
      if (!redeemed) { res.writeHead(401, PAGE_HEADERS).end(NO_SESSION); return; }
      try {
        res.writeHead(303, {
          location: redeemed.path, 'cache-control': 'no-store',
          // No Max-Age: the Puente is the authority and ends the session; the browser only carries it.
          'set-cookie': `${WEB_SESSION_COOKIE}=${redeemed.token}; Path=/; Secure; HttpOnly; SameSite=Strict`,
        }).end();
      } catch {
        // A path no header can carry; `open` refuses those, this keeps the process up regardless.
        res.writeHead(401, PAGE_HEADERS).end(NO_SESSION);
      }
    });
  }

  function forward(req: http.IncomingMessage, res: http.ServerResponse, origin: string, session: WebSession): void {
    const navigation = req.headers['sec-fetch-mode'] === 'navigate' || /text\/html/.test(req.headers.accept ?? '');
    const up = http.request({ host: target.address, port: target.port, method: req.method, path: req.url, headers: upstreamHeaders(req, origin, false) });
    // Per exchange, never the client socket: Serve multiplexes other sessions' requests over it.
    const cut = () => { up.destroy(); res.destroy(); };
    session.cuts.add(cut);
    res.on('close', () => { session.cuts.delete(cut); if (!res.writableFinished) up.destroy(); });
    up.on('response', (ures) => {
      // Node reads any three-digit status from the app but cannot answer one below 100.
      if (ures.statusCode! < 100) { up.destroy(new Error('invalid upstream status')); return; }
      res.writeHead(ures.statusCode!, downstreamHeaders(ures.headers, origin, false));
      ures.pipe(res);
      // A body cut short upstream is never presented as complete.
      ures.on('close', () => { if (!ures.complete) res.destroy(); });
    });
    up.on('error', (error: NodeJS.ErrnoException) => {
      // This exchange answers first; the app's other sessions end with the target.
      session.cuts.delete(cut);
      if (error.code === 'ECONNREFUSED') options.targetDown();
      if (res.headersSent) { res.destroy(); return; }
      if (navigation) res.writeHead(502, PAGE_HEADERS).end(TARGET_DOWN);
      else res.writeHead(502, { 'cache-control': 'no-store' }).end();
    });
    req.pipe(up);
  }

  const server = http.createServer((req, res) => {
    res.on('close', () => log(req.method, res.statusCode));
    const path = targetPath(req.url);
    if (path === null) { res.writeHead(400).end(); return; }
    const origin = publicOrigin(req);
    if (!origin) { res.writeHead(421).end(); return; }
    if (path.startsWith(WEB_RESERVED_PATH_PREFIX)) {
      if (path === WEB_ENTRY_PATH && req.method === 'POST' && !req.url!.includes('?')) entry(req, res, origin);
      else res.writeHead(404, { 'cache-control': 'no-store' }).end();
      return;
    }
    const session = sessionOf(req);
    if (!session) {
      const navigation = ['GET', 'HEAD'].includes(req.method ?? '') && (req.headers['sec-fetch-mode'] ? req.headers['sec-fetch-mode'] === 'navigate' : /text\/html/.test(req.headers.accept ?? ''));
      if (navigation) access(req, res);
      else res.writeHead(401, { 'cache-control': 'no-store' }).end();
      return;
    }
    if (!allowed(req, origin, false)) { res.writeHead(403).end(); return; }
    forward(req, res, origin, session);
  });

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const refuse = (status: number, text: string) => {
      log(req.method, status);
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const path = targetPath(req.url);
    if (path === null) return refuse(400, 'Bad Request');
    const origin = publicOrigin(req);
    if (!origin) return refuse(421, 'Misdirected Request');
    if (path.startsWith(WEB_RESERVED_PATH_PREFIX)) return refuse(404, 'Not Found');
    const session = sessionOf(req);
    if (!session) return refuse(401, 'Unauthorized');
    if (!allowed(req, origin, true)) return refuse(403, 'Forbidden');
    let upstream: Socket | null = null;
    const up = http.request({ host: target.address, port: target.port, method: req.method, path: req.url, headers: upstreamHeaders(req, origin, true) });
    // Both ends, from the start: a cut during the handshake closes it too.
    const cut = () => { up.destroy(); upstream?.destroy(); socket.destroy(); };
    session.cuts.add(cut);
    socket.on('close', () => { session.cuts.delete(cut); cut(); });
    up.on('upgrade', (ures, usocket: Socket, uhead) => {
      upstream = usocket;
      if (socket.destroyed) { usocket.destroy(); return; }
      log(req.method, ures.statusCode ?? 101);
      const lines = [`HTTP/1.1 ${ures.statusCode} ${ures.statusMessage}`];
      for (const [name, value] of Object.entries(downstreamHeaders(ures.headers, origin, true))) {
        for (const item of [value].flat()) lines.push(`${name}: ${item}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (uhead.length) socket.write(uhead);
      if (head.length) usocket.write(head);
      usocket.on('error', cut);
      usocket.on('close', cut);
      usocket.pipe(socket);
      socket.pipe(usocket);
    });
    up.on('response', (ures) => { ures.resume(); refuse(ures.statusCode ?? 502, 'Upstream Refused'); });
    up.on('error', (error: NodeJS.ErrnoException) => {
      session.cuts.delete(cut);
      if (error.code === 'ECONNREFUSED') options.targetDown();
      if (!socket.destroyed) refuse(502, 'Bad Gateway');
    });
    up.end();
  });

  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(port, '127.0.0.1', () => listening.resolve());
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
