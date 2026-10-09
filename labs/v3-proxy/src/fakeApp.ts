// A fake "user-built" web application, listening on plain HTTP loopback like a dev server.
// It exercises what the V3 web proxy must carry: deep routes, resources, forms, multipart
// uploads, redirects, login cookies, downloads, SSE and a WebSocket dev channel (HMR).
// Every request it receives is recorded in `hits` so tests can see exactly what reached it.
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

export type Hit = {
  method: string;
  path: string;
  host: string;
  cookie: string;
  origin: string;
  forwardedProto: string;
  identity: string;
  headers: http.IncomingHttpHeaders;
};

export type FakeApp = {
  name: string;
  port: number;
  hits: Hit[];
  server: http.Server;
  /** Drops every connection, upgraded WebSockets included, as a crashing dev server would. */
  cutStreams(): void;
  close(): Promise<void>;
};

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function html(title: string, body: string, head = ''): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
}

function cookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
  return promise;
}

// Smallest multipart reader that finds the first file part.
function firstFile(body: Buffer, contentType: string): { filename: string; data: Buffer } | null {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  if (!boundary) return null;
  const sep = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let start = body.indexOf(sep);
  while (start !== -1) {
    const next = body.indexOf(sep, start + sep.length);
    if (next === -1) break;
    const part = body.subarray(start + sep.length + 2, next - 2);
    const headEnd = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, headEnd).toString('utf8');
    const filename = /filename="([^"]*)"/.exec(head);
    if (filename) return { filename: filename[1], data: part.subarray(headEnd + 4) };
    start = next;
  }
  return null;
}

export function wsFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length > 125) throw new Error('lab frames are short');
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

// Decodes one short frame (client frames are masked). Returns null for a close frame.
export function wsRead(buf: Buffer): string | null {
  if ((buf[0] & 0x0f) === 0x8) return null;
  const masked = (buf[1] & 0x80) !== 0;
  const len = buf[1] & 0x7f;
  const mask = masked ? buf.subarray(2, 6) : null;
  const data = buf.subarray(masked ? 6 : 2, (masked ? 6 : 2) + len);
  return Buffer.from(data.map((b, i) => (mask ? b ^ mask[i % 4] : b))).toString('utf8');
}

export type FakeAppOptions = { name: string; cdnOrigin: string };

export async function startFakeApp({ name, cdnOrigin }: FakeAppOptions): Promise<FakeApp> {
  const hits: Hit[] = [];
  const logins = new Set<string>();
  const upgraded = new Set<Duplex>();
  let port = 0;
  const csp = `default-src 'self'; script-src 'self' ${cdnOrigin}; img-src 'self' ${cdnOrigin}; style-src 'self'; connect-src 'self'`;

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://app.invalid');
    const host = req.headers.host ?? '';
    hits.push({
      method: req.method ?? '',
      path: url.pathname,
      host,
      cookie: req.headers.cookie ?? '',
      origin: req.headers.origin ?? '',
      forwardedProto: String(req.headers['x-forwarded-proto'] ?? ''),
      identity: String(req.headers['tailscale-user-login'] ?? ''),
      headers: req.headers,
    });
    const jar = cookies(req.headers.cookie);
    const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { 'content-type': type, ...headers });
      res.end(body);
    };
    const page = (title: string, body: string, head = '') =>
      send(200, 'text/html; charset=utf-8', html(title, body, head), { 'content-security-policy': csp });
    const p = url.pathname;

    if (p === '/') {
      return page(`Aplicación ${name}`,
        `<h1 id="app">Aplicación ${name}</h1>
<img id="logo" src="/static/logo.svg" alt="logo">
<a id="deep" href="/deep/a/b/c?x=1">ruta profunda</a>
<a id="ventanas" href="/ventanas">ventanas</a>`,
        `<link rel="stylesheet" href="/static/app.css"><script src="${cdnOrigin}/lib.js"></script><script src="/static/app.js"></script>`);
    }
    if (p === '/static/app.css') return send(200, 'text/css', 'h1 { color: rgb(1, 2, 3); }');
    if (p === '/static/logo.svg') {
      return send(200, 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    }
    if (p === '/static/app.js') {
      // The dev channel derives its URL from the page location: the compatible pattern.
      return send(200, 'text/javascript', `
document.documentElement.dataset.js = 'ok';
const sse = new EventSource('/events');
let n = 0;
sse.onmessage = () => { document.body.dataset.sse = String(++n); };
sse.onerror = () => { document.body.dataset.sseError = '1'; sse.close(); };
const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/hmr');
ws.onmessage = (e) => {
  document.body.dataset.hmr = e.data;
  if (e.data.startsWith('hmr:hello')) ws.send('ping');
  if (e.data.startsWith('hmr:ack')) document.body.dataset.hmrAck = e.data;
};
ws.onclose = () => { document.body.dataset.hmrClosed = '1'; };`);
    }
    if (p.startsWith('/deep/')) return page('Ruta profunda', `<p id="deep-path">${p}${url.search}</p>`);
    if (p === '/formulario' && req.method === 'POST') {
      const body = new URLSearchParams((await readBody(req)).toString('utf8'));
      return page('Formulario', `<p id="nota">${body.get('nota') ?? ''}</p>`);
    }
    if (p === '/formulario') {
      return page('Formulario', `
<form id="f" method="post" action="/formulario"><input name="nota" value="hola ñandú"><button>Enviar</button></form>
<form id="u" method="post" action="/subida" enctype="multipart/form-data"><input type="file" name="archivo"><button>Subir</button></form>`);
    }
    if (p === '/subida' && req.method === 'POST') {
      const file = firstFile(await readBody(req), req.headers['content-type'] ?? '');
      if (!file) return send(400, 'text/plain', 'sin archivo');
      const digest = createHash('sha256').update(file.data).digest('hex');
      return page('Subida', `<p id="upload" data-name="${file.filename}" data-size="${file.data.length}" data-sha="${digest}">ok</p>`);
    }
    if (p === '/descarga') {
      return send(200, 'text/plain; charset=utf-8', `informe de ${name}\n`, {
        'content-disposition': `attachment; filename="informe-${name}.txt"`,
      });
    }
    if (p === '/redirect/relative') return send(302, 'text/plain', '', { location: '/deep/redirigida?via=relativa' });
    if (p === '/redirect/host') {
      const proto = String(req.headers['x-forwarded-proto'] ?? 'http');
      return send(302, 'text/plain', '', { location: `${proto}://${host}/deep/redirigida?via=host` });
    }
    // An app that builds absolute URLs from its own bind address (a common dev-server habit).
    if (p === '/redirect/upstream') {
      return send(302, 'text/plain', '', { location: `http://127.0.0.1:${port}/deep/redirigida?via=upstream` });
    }
    if (p === '/redirect/protocolo') {
      return send(302, 'text/plain', '', { location: `//127.0.0.1:${port}/deep/redirigida?via=protocolo` });
    }
    // A broken app: a Location no URL parser accepts.
    if (p === '/redirect/invalida') return send(302, 'text/plain', '', { location: 'http://' });
    if (p === '/login' && req.method === 'POST') {
      const sid = `${name}-${randomBytes(8).toString('hex')}`;
      logins.add(sid);
      return send(303, 'text/plain', '', {
        location: '/cuenta',
        'set-cookie': [`__Host-app_session=${sid}; Path=/; Secure; HttpOnly; SameSite=Lax`, 'tema=oscuro; Path=/; Secure'],
      });
    }
    if (p === '/login') {
      return page('Entrar', '<form id="login" method="post" action="/login"><input name="usuario" value="ale"><button>Entrar</button></form>');
    }
    if (p === '/cuenta') {
      const ok = logins.has(jar['__Host-app_session'] ?? '');
      return page('Cuenta', `<p id="cuenta">${ok ? `dentro de ${name}` : 'fuera'}</p>`);
    }
    if (p === '/whoami') {
      return send(200, 'application/json', JSON.stringify({ app: name, cookies: jar, host, proto: req.headers['x-forwarded-proto'] ?? null }));
    }
    if (p === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      let i = 0;
      const timer = setInterval(() => res.write(`data: ${name} ${++i}\n\n`), 100);
      res.on('close', () => clearInterval(timer));
      return;
    }
    if (p === '/ventanas') {
      return page('Ventanas', `
<a id="blank" target="_blank" href="/deep/nueva">nueva ventana</a>
<a id="externa" target="_blank" href="${cdnOrigin}/pagina">web externa</a>
<button id="abrir" type="button">window.open</button><script src="/static/ventanas.js"></script>`);
    }
    if (p === '/static/ventanas.js') {
      return send(200, 'text/javascript', `document.getElementById('abrir').onclick = () => window.open('/deep/popup');`);
    }
    // Hostile sibling behaviour: parent-domain cookies and attempts on Relay's reserved names.
    if (p === '/cookies-padre') {
      const parent = host.split(':')[0].split('.').slice(1).join('.');
      return send(200, 'text/html; charset=utf-8', html('Cookies', `<p id="padre" data-parent="${parent}">ok</p><script src="/static/cookies.js"></script>`), {
        'set-cookie': [
          `padre_http=de-${name}; Domain=${parent}; Path=/; Secure`,
          `padre_espacio=de-${name}; Domain =${parent}; Path=/; Secure`,
          `padre_tab=de-${name}; Path=/; Domain\t=${parent}; Secure`,
          `padre_mayus=de-${name}; DOMAIN = .${parent}; Path=/; Secure`,
          `__Host-RelayWeb=falsa-${name}; Path=/; Secure; HttpOnly`,
          `__Host-RelayPend=falsa-${name}; Path=/; Secure; HttpOnly`,
          `=__Host-RelayWeb=sin-nombre-${name}; Path=/; Secure`,
        ],
      });
    }
    if (p === '/static/cookies.js') {
      return send(200, 'text/javascript', `
const parent = document.getElementById('padre').dataset.parent;
document.cookie = 'padre_js=de-${name}; Domain=' + parent + '; Path=/; Secure; SameSite=Lax';
document.cookie = '__Host-RelayWeb=falsa-js; Domain=' + parent + '; Path=/; Secure';
document.cookie = '__Host-RelayWeb=falsa-js; Path=/; Secure';
document.body.dataset.visible = document.cookie;
document.body.dataset.done = '1';`);
    }
    // Hostile sibling: cross-origin requests to another app (target passed in the query).
    if (p === '/cruzado') {
      return send(200, 'text/html; charset=utf-8', html('Cruzado', '<p id="cruzado">…</p><script src="/static/cruzado.js"></script>'));
    }
    if (p === '/static/cruzado.js') {
      return send(200, 'text/javascript', `
const target = new URLSearchParams(location.search).get('target');
const out = {};
(async () => {
  try { const r = await fetch(target + '/whoami', { credentials: 'include' }); out.fetch = r.status + ':' + (await r.text()); }
  catch { out.fetch = 'bloqueado'; }
  try { await fetch(target + '/formulario', { method: 'POST', mode: 'no-cors', credentials: 'include', body: new URLSearchParams({ nota: 'cruzada' }) }); out.post = 'enviado'; }
  catch { out.post = 'bloqueado'; }
  out.ws = await new Promise((resolve) => {
    const ws = new WebSocket(target.replace('https:', 'wss:') + '/hmr');
    ws.onmessage = (e) => { resolve('abierto:' + e.data); ws.close(); };
    ws.onerror = () => resolve('bloqueado');
  });
  document.getElementById('cruzado').dataset.out = JSON.stringify(out);
})();`);
    }
    // An incompatible page: hard-coded loopback URLs for its dev channel and an image.
    if (p === '/incompatible') {
      return send(200, 'text/html; charset=utf-8', html('Incompatible', `
<img id="img" src="http://127.0.0.1:${port}/static/logo.svg"><script src="/static/incompatible.js"></script>`));
    }
    if (p === '/static/incompatible.js') {
      return send(200, 'text/javascript', `new WebSocket('ws://127.0.0.1:${port}/hmr');`);
    }
    return send(404, 'text/plain', `no existe en ${name}`);
  };
  // A client that aborts mid-body (an upload cut short) rejects readBody; drop that response only.
  const server = http.createServer((req, res) => void handle(req, res).catch(() => res.destroy()));

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex) => {
    hits.push({
      method: 'UPGRADE',
      path: new URL(req.url ?? '/', 'http://app.invalid').pathname,
      host: req.headers.host ?? '',
      cookie: req.headers.cookie ?? '',
      origin: req.headers.origin ?? '',
      forwardedProto: String(req.headers['x-forwarded-proto'] ?? ''),
      identity: String(req.headers['tailscale-user-login'] ?? ''),
      headers: req.headers,
    });
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}${WS_GUID}`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(wsFrame(`hmr:hello:${name}`));
    let i = 0;
    const timer = setInterval(() => socket.write(wsFrame(`hmr:tick:${name}:${++i}`)), 100);
    socket.on('data', (buf: Buffer) => {
      const text = wsRead(buf);
      if (text === null) socket.end();
      else socket.write(wsFrame(`hmr:ack:${text}`));
    });
    upgraded.add(socket);
    socket.on('close', () => { clearInterval(timer); upgraded.delete(socket); });
    socket.on('error', () => clearInterval(timer));
  });

  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  port = (server.address() as AddressInfo).port;
  const cutStreams = () => {
    server.closeAllConnections();
    for (const socket of upgraded) socket.destroy();
  };
  return {
    name,
    port,
    hits,
    server,
    cutStreams,
    close() {
      const closed = Promise.withResolvers<void>();
      cutStreams();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}
