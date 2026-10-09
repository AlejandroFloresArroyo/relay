// HTTP clients for the lab topology. TLS trust is the lab certificate, per request only.
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import type { Lab } from '../src/lab.ts';

export type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

export type Opts = { method?: string; headers?: Record<string, string>; body?: string };

function collect(res: http.IncomingMessage): Promise<Reply> {
  const { promise, resolve, reject } = Promise.withResolvers<Reply>();
  let body = '';
  res.setEncoding('utf8');
  res.on('data', (c: string) => { body += c; });
  res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
  res.on('error', reject);
  return promise;
}

function webRequest(lab: Lab, origin: string, path: string, opts: Opts) {
  const url = new URL(origin);
  return https.request({
    host: '127.0.0.1',
    port: Number(url.port),
    servername: url.hostname,
    ca: lab.cert.cert,
    method: opts.method ?? 'GET',
    path,
    headers: { host: url.host, ...opts.headers },
    agent: false,
  });
}

export async function web(lab: Lab, origin: string, path: string, opts: Opts = {}): Promise<Reply> {
  const req = webRequest(lab, origin, path, opts);
  const { promise, resolve, reject } = Promise.withResolvers<Reply>();
  req.on('response', (res) => collect(res).then(resolve, reject));
  req.on('error', reject);
  req.end(opts.body);
  return promise;
}

// An open SSE stream: resolves once the first event arrives; `ended` settles when it is cut.
export async function sse(lab: Lab, origin: string, path: string, headers: Record<string, string>) {
  const req = webRequest(lab, origin, path, { headers });
  const opened = Promise.withResolvers<http.IncomingMessage>();
  req.on('response', opened.resolve);
  req.on('error', opened.reject);
  req.end();
  const res = await opened.promise;
  const ended = Promise.withResolvers<string>();
  let events = 0;
  const first = Promise.withResolvers<void>();
  res.on('data', () => { events += 1; first.resolve(); });
  res.on('close', () => ended.resolve(`cortado tras ${events} eventos`));
  res.on('error', () => ended.resolve(`cortado tras ${events} eventos`));
  if (res.statusCode !== 200) return { status: res.statusCode, ended: ended.promise };
  await first.promise;
  return { status: res.statusCode, ended: ended.promise };
}

// A raw WebSocket upgrade through the HTTPS front. Resolves with the status line and, on 101,
// the first data received and a promise that settles when the socket closes.
export async function upgrade(lab: Lab, origin: string, path: string, headers: Record<string, string>) {
  const req = webRequest(lab, origin, path, {
    headers: {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': randomBytes(16).toString('base64'),
      ...headers,
    },
  });
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; first?: string; closed?: Promise<void> }>();
  req.on('upgrade', (res, socket, head: Buffer) => {
    const closed = Promise.withResolvers<void>();
    socket.on('close', () => closed.resolve());
    socket.on('error', () => closed.resolve());
    const first = (buf: Buffer) => resolve({ status: res.statusCode ?? 0, first: buf.subarray(2).toString('utf8'), closed: closed.promise });
    if (head.length) first(head);
    else socket.once('data', first);
  });
  req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode ?? 0 }); });
  req.on('error', reject);
  req.end();
  return promise;
}

// Plain HTTP on loopback, bypassing the HTTPS front (control API, or a listener directly).
export async function loopback(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false });
  const { promise, resolve, reject } = Promise.withResolvers<Reply>();
  req.on('response', (res) => collect(res).then(resolve, reject));
  req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode ?? 0, headers: res.headers, body: '' }); });
  req.on('error', reject);
  req.end();
  return promise;
}

export function control(lab: Lab, method: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return loopback(Number(new URL(lab.origins.control).port), path, headers, method);
}

export function setCookies(reply: Reply): string[] {
  return reply.headers['set-cookie'] ?? [];
}

// name=value pairs from Set-Cookie lines, ready for a Cookie header.
export function cookieValue(reply: Reply, name: string): string | undefined {
  for (const line of setCookies(reply)) {
    const pair = line.split(';')[0];
    if (pair.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  return undefined;
}
