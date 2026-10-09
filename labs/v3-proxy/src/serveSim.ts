// Stand-in for Tailscale Serve/Services: terminates HTTPS for one or more names and forwards
// plain HTTP to a loopback target, keeping Host and adding X-Forwarded-* plus an identity
// header, like Serve's reverse proxy does for user-owned nodes. It does not authorize anything.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { LabCert } from './certs.ts';

export type ServeSim = { port: number; routes: Map<string, number>; close(): Promise<void> };

export async function startServeSim(cert: LabCert, routes: Map<string, number>): Promise<ServeSim> {
  const target = (req: http.IncomingMessage) => routes.get((req.headers.host ?? '').split(':')[0]);
  const forwarded = (req: http.IncomingMessage) => ({
    ...req.headers,
    'x-forwarded-for': req.socket.remoteAddress ?? '',
    'x-forwarded-host': req.headers.host ?? '',
    'x-forwarded-proto': 'https',
    'tailscale-user-login': 'persona@relay-lab.test',
  });

  const server = https.createServer({ cert: cert.cert, key: cert.key }, (req, res) => {
    const port = target(req);
    if (!port) {
      res.writeHead(404).end();
      return;
    }
    const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: forwarded(req) }, (ures) => {
      res.writeHead(ures.statusCode ?? 502, ures.headers);
      ures.pipe(res);
      // A backend that cuts a stream must cut it for the browser too.
      ures.on('close', () => { if (!ures.complete) res.destroy(); });
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
    res.on('close', () => upstream.destroy());
  });

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const port = target(req);
    if (!port) {
      socket.destroy();
      return;
    }
    const upstream = net.connect(port, '127.0.0.1', () => {
      const headers = forwarded(req);
      const lines = Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}: ${x}`));
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  return {
    port: (server.address() as AddressInfo).port,
    routes,
    close() {
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}
