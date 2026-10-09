// Doubles for the web tool's boundaries (bridge/src/remote/ports.ts): the socket table and Tailscale
// Services. Plus fake local apps on ephemeral loopback ports and raw HTTP helpers that set Host and
// X-Forwarded-Proto like Serve does. No real service of the machine is read or contacted.
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import type { TestContext } from 'node:test';
import type { ToolAvailability } from '../../protocol/protocol.ts';
import type { AppRegistry, ListeningSocket, PublishBlock, ServicePublisher } from '../src/remote/ports.ts';

const AVAILABLE: ToolAvailability = { state: 'available' };
export const TAILNET = 'relay-test.ts.net';

/** The socket table, edited by the test. `reads` counts discoveries. */
export function fakeSockets(sockets: ListeningSocket[] = [], availability: ToolAvailability = AVAILABLE): AppRegistry & { sockets: ListeningSocket[]; reads: number } {
  const registry = {
    sockets, reads: 0,
    availability: async () => availability,
    listening: async () => { registry.reads += 1; return structuredClone(registry.sockets); },
  };
  return registry;
}

/** Services as the #79 simulator: `svc:<name>` → https://<name>.<tailnet>, pointing at a listener port. */
export function simulatedPublisher(availability: ToolAvailability = AVAILABLE): ServicePublisher & { services: Map<string, number>; block: PublishBlock | null } {
  const publisher = {
    services: new Map<string, number>(), block: null as PublishBlock | null,
    availability: async () => availability,
    async publish(service: string, listenerPort: number) {
      if (publisher.block) return { state: 'blocked' as const, reason: publisher.block };
      publisher.services.set(service, listenerPort);
      return { state: 'published' as const, origin: `https://${service}.${TAILNET}` };
    },
    async unpublish(service: string) { publisher.services.delete(service); },
  };
  return publisher;
}

export function socket(address: string, port: number, cwd = '/home/user/dev/app-a', pid: number | null = 4242): ListeningSocket {
  return { address, port, pid, process: { name: 'node', exe: '/usr/bin/node', cwd } };
}

export interface Hit { method: string; url: string; headers: http.IncomingHttpHeaders; bytes: number; sha256: string }
export interface FakeApp { port: number; hits: Hit[]; close(): Promise<void>; streams: Set<Socket> }

/**
 * A user's local app: echoes what it receives at any path, and has an SSE stream, redirects, cookies,
 * a truncated body and a WebSocket-like upgrade that echoes bytes in both directions.
 */
export async function startFakeApp(t: TestContext, host = '127.0.0.1', port = 0): Promise<FakeApp> {
  const hits: Hit[] = [];
  const streams = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const hash = createHash('sha256');
    let bytes = 0;
    req.on('data', (chunk: Buffer) => { bytes += chunk.length; hash.update(chunk); });
    req.on('end', () => {
      const hit = { method: req.method!, url: req.url!, headers: req.headers, bytes, sha256: hash.digest('hex') };
      hits.push(hit);
      const url = new URL(req.url!, 'http://app.invalid');
      if (url.pathname === '/sse') {
        streams.add(res.socket!);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        res.write('data: uno\n\n');
        return;
      }
      if (url.pathname === '/redirect') { res.writeHead(302, { location: url.searchParams.get('to')! }).end(); return; }
      if (url.pathname === '/cookies') {
        res.writeHead(200, { 'set-cookie': [
          'ok=1; Path=/', 'padre=1; Domain=relay-test.ts.net; Path=/', 'padre_espacio=1; Domain =relay-test.ts.net',
          'padre_tab=1; Domain\t=relay-test.ts.net', 'padre_mayus=1; DOMAIN = .relay-test.ts.net',
          '__Host-RelayWeb=falsa; Path=/; Secure', '__host-relaypend=falsa', '=sin-nombre', 'sin-igual',
        ] }).end('ok');
        return;
      }
      if (url.pathname === '/policy') {
        res.writeHead(200, { 'content-security-policy': "default-src 'self'", 'access-control-allow-origin': '*' }).end('ok');
        return;
      }
      if (url.pathname === '/truncated') {
        res.writeHead(200, { 'content-length': '100' });
        res.write('partial', () => res.socket?.destroy());
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(hit));
    });
  });
  server.on('upgrade', (req: http.IncomingMessage, sock: Socket) => {
    hits.push({ method: req.method!, url: req.url!, headers: req.headers, bytes: 0, sha256: '' });
    streams.add(sock);
    sock.on('error', () => {});
    const cookies = req.url === '/cookies' ? 'Set-Cookie: __Host-RelayWeb=falsa; Path=/\r\nSet-Cookie: padre=1; Domain=relay-test.ts.net\r\n' : '';
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${cookies}\r\n`);
    sock.on('data', (data: Buffer) => sock.write(Buffer.concat([Buffer.from('eco:'), data])));
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(port, host, listening.resolve);
  await listening.promise;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const s of streams) s.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  t.after(close);
  return { port: (server.address() as AddressInfo).port, hits, close, streams };
}

export interface WebResponse { status: number; headers: http.IncomingHttpHeaders; body: Buffer; text: string }

const forwarded = (origin: string) => ({ host: new URL(origin).host, 'x-forwarded-proto': 'https' });

/** One request to a listener as Serve would forward it: Host is the Service name, the scheme was HTTPS. */
export function web(port: number, origin: string, method: string, path: string, headers: Record<string, string> = {}, body?: Buffer | string): Promise<WebResponse> {
  const { promise, resolve, reject } = Promise.withResolvers<WebResponse>();
  const length = body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) };
  const req = http.request({ host: '127.0.0.1', port, method, path, agent: false, headers: { ...forwarded(origin), ...length, ...headers } }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('error', reject);
    res.on('end', () => { const all = Buffer.concat(chunks); resolve({ status: res.statusCode!, headers: res.headers, body: all, text: all.toString() }); });
  });
  req.on('error', reject);
  req.end(body);
  return promise;
}

export interface OpenStream { status: number; headers: http.IncomingHttpHeaders; first: Promise<string>; ended: Promise<void>; close(): void }

/** An open response whose end (or cut) the test observes. */
export function stream(port: number, origin: string, path: string, headers: Record<string, string>): Promise<OpenStream> {
  const { promise, resolve, reject } = Promise.withResolvers<OpenStream>();
  const req = http.request({ host: '127.0.0.1', port, path, agent: false, headers: { ...forwarded(origin), ...headers } }, (res) => {
    const first = Promise.withResolvers<string>();
    const ended = Promise.withResolvers<void>();
    res.once('data', (chunk: Buffer) => first.resolve(chunk.toString()));
    res.on('close', ended.resolve);
    res.on('error', () => ended.resolve());
    resolve({ status: res.statusCode!, headers: res.headers, first: first.promise, ended: ended.promise, close: () => req.destroy() });
  });
  req.on('error', reject);
  req.end();
  return promise;
}

/** An upgrade through the listener: the 101 and the raw socket, or the refusal status. */
export function upgrade(port: number, origin: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; socket?: Socket }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; headers: http.IncomingHttpHeaders; socket?: Socket }>();
  const req = http.request({ host: '127.0.0.1', port, path, agent: false,
    headers: { ...forwarded(origin), connection: 'Upgrade', upgrade: 'websocket', ...headers } });
  req.on('upgrade', (res, sock) => resolve({ status: res.statusCode!, headers: res.headers, socket: sock }));
  req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode!, headers: res.headers }); });
  req.on('error', reject);
  req.end();
  return promise;
}

/** The next bytes a socket receives, or null if it closes first. */
export function nextData(sock: Socket): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const data = (chunk: Buffer) => { sock.off('close', close); resolve(chunk.toString()); };
  const close = () => { sock.off('data', data); resolve(null); };
  sock.once('data', data);
  sock.once('close', close);
  return promise;
}

/** Raw bytes on a fresh connection, for request targets http.request refuses to send. */
export function raw(port: number, text: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let out = '';
  const sock = net.connect(port, '127.0.0.1', () => sock.end(text));
  sock.on('data', (chunk) => { out += chunk.toString(); });
  sock.on('close', () => resolve(out));
  sock.on('error', reject);
  return promise;
}
