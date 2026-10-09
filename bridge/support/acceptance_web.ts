// A user's local web app for the acceptance of scenario 4 (test/acceptance/web.test.ts), run as its own
// process: discovery reads the real socket table and never offers the Puente's own sockets, so the
// app cannot live in the test process. Pages, a form, a multipart upload, a download, a redirect to
// its own loopback port, an SSE dev channel and a WebSocket-like HMR upgrade. It echoes what it
// received (headers included) so the test sees what crossed the listener, and prints `hit` for each
// exchange and `closed sse` / `closed ws` when a stream ends at its side.
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const name = process.argv[2] ?? 'app';
/** Deterministic, so the test knows its hash: 512 KiB of `informe-`. */
const DOWNLOAD = Buffer.alloc(512 * 1024, 'informe-');

const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

const server = http.createServer((req, res) => {
  console.log('hit');
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, 'http://app.invalid');
    const echo = { app: name, method: req.method, url: req.url, headers: req.headers, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'app_sesion=propia; Path=/; HttpOnly' }).end(html(name,
        `<h1>${name}</h1><a href="/docs/guia">Guía</a><form method="post" action="/form"><input name="nota"></form>`
        + '<form method="post" action="/upload" enctype="multipart/form-data"><input type="file" name="archivo"></form><a href="/download">Informe</a>'));
      return;
    }
    if (url.pathname === '/docs/guia') { res.writeHead(200, { 'content-type': 'text/html' }).end(html('Guía', `<h1>Guía ${url.search}</h1>`)); return; }
    if (url.pathname === '/volver') { res.writeHead(302, { location: `http://127.0.0.1:${(server.address() as AddressInfo).port}/docs/guia` }).end(); return; }
    if (url.pathname === '/form' && req.method === 'POST') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...echo, form: body.toString('utf8') })); return; }
    if (url.pathname === '/download') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="informe.bin"', 'content-length': DOWNLOAD.length }).end(DOWNLOAD);
      return;
    }
    if (url.pathname === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(`data: ${name}-conectado\n\n`);
      res.on('close', () => console.log('closed sse'));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(echo));
  });
});
server.on('upgrade', (req, socket) => {
  console.log('hit');
  socket.on('error', () => {});
  socket.on('close', () => console.log('closed ws'));
  // As a WebSocket server does: the peer's end is answered with its own (http sockets allow half-open).
  socket.on('end', () => socket.end());
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  // Answers only when spoken to: bytes written right after the 101 could land in the client's `head`.
  socket.on('data', (data: Buffer) => socket.write(data.toString() === 'cookie?' ? `cookie:${req.headers.cookie ?? ''}` : `eco:${data}`));
});
server.listen(0, '127.0.0.1', () => console.log(`listening ${(server.address() as AddressInfo).port}`));
