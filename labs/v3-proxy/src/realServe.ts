// Real Tailscale Serve check. The tailnet has no HTTPS certificates, so this uses one HTTP Serve
// port on the machine name, pointed at a fake app, and checks what Serve really forwards:
// headers, SSE flushing, WebSocket upgrades, uploads, redirects, cookies and backend cuts.
// It also records what Serve answers for HTTPS and for a Service. Every change is removed at
// the end and the Serve configuration is compared with the one found at the start.
//
// Needs the `tailscale` lock. Run: node src/realServe.ts [httpPort]
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { startFakeApp, wsRead } from './fakeApp.ts';

const HTTP_PORT = Number(process.argv[2] ?? 18080);
const HTTPS_PORT = 18443;
const SERVICE = 'svc:relay-lab-a';

function tailscale(args: string[], timeout = 15000): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync('tailscale', args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message };
  }
}

const serveConfig = () => JSON.parse(tailscale(['serve', 'status', '--json']).out || '{}');
const report = (label: string, value: unknown) => console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);

const before = serveConfig();
const self = JSON.parse(tailscale(['status', '--self', '--json']).out).Self;
const host = String(self.DNSName).replace(/\.$/, '');
const app = await startFakeApp({ name: 'app-real', cdnOrigin: 'https://cdn.invalid' });
const base = `http://${host}:${HTTP_PORT}`;
report('tailscale', tailscale(['version']).out.split('\n')[0]);

try {
  const added = tailscale(['serve', '--bg', `--http=${HTTP_PORT}`, `http://127.0.0.1:${app.port}`]);
  report('serve --http', added.ok ? 'añadido' : added.out);
  if (!added.ok) throw new Error('serve --http failed');

  const who = await fetch(`${base}/whoami`, { headers: { cookie: 'tema=claro', origin: base } });
  const hit = app.hits.at(-1)!;
  report('GET /whoami', who.status);
  report('Host recibido', hit.headers.host);
  for (const name of ['x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for', 'origin', 'cookie']) report(`  ${name}`, hit.headers[name] ?? '(ausente)');
  // Identity values are personal; only their presence is reported.
  report('  cabeceras tailscale-*', Object.keys(hit.headers).filter((h) => h.startsWith('tailscale-')).map((h) => `${h}=${hit.headers[h] ? 'presente' : 'vacía'}`));

  const started = Date.now();
  const sse = await fetch(`${base}/events`);
  const reader = sse.body!.getReader();
  await reader.read();
  report('SSE primer evento (ms)', Date.now() - started);
  let events = 1;
  const until = Date.now() + 1000;
  while (Date.now() < until) { await reader.read(); events += 1; }
  report('SSE eventos en ~1 s (servidor emite cada 100 ms)', events);
  const cutAt = Date.now();
  app.cutStreams();
  const cut = await Promise.race([
    (async () => { try { while (!(await reader.read()).done); return 'fin limpio'; } catch (e) { return `error ${(e as Error).message}`; } })(),
    new Promise((resolve) => setTimeout(() => resolve('sigue abierto tras 5 s'), 5000)),
  ]);
  report('SSE tras cortar el backend', `${cut} (${Date.now() - cutAt} ms)`);

  const ws = await new Promise<{ status: number; frames: string[]; closedMs?: number }>((resolve) => {
    const req = http.request(`${base}/hmr`, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'), origin: base } });
    req.on('response', (res) => resolve({ status: res.statusCode ?? 0, frames: [] }));
    req.on('upgrade', (res, socket, head) => {
      const frames: string[] = head.length ? [wsRead(head) ?? 'close'] : [];
      const mask = randomBytes(4);
      const text = Buffer.from('ping');
      socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | text.length]), mask, text.map((b, i) => b ^ mask[i % 4])]));
      socket.on('data', (buf: Buffer) => frames.push(wsRead(buf) ?? 'close'));
      setTimeout(() => {
        const cutAt = Date.now();
        socket.on('close', () => resolve({ status: res.statusCode ?? 0, frames, closedMs: Date.now() - cutAt }));
        app.cutStreams();
        setTimeout(() => resolve({ status: res.statusCode ?? 0, frames }), 5000);
      }, 500);
    });
    req.end();
  });
  report('WebSocket estado', ws.status);
  report('WebSocket marcos', [ws.frames[0], ws.frames.find((f) => f.startsWith('hmr:ack')) ?? '(sin ack)']);
  report('WebSocket tras cortar el backend', ws.closedMs === undefined ? 'sigue abierto tras 5 s' : `cerrado en ${ws.closedMs} ms`);

  const file = randomBytes(3 * 1024 * 1024);
  const form = new FormData();
  form.append('archivo', new Blob([file]), 'datos.bin');
  const up = await (await fetch(`${base}/subida`, { method: 'POST', body: form })).text();
  report('Subida 3 MiB sha256 coincide', up.includes(createHash('sha256').update(file).digest('hex')));

  const redirect = await fetch(`${base}/redirect/upstream`, { redirect: 'manual' });
  report('Location de redirect absoluto a loopback', redirect.headers.get('location')?.replace(String(app.port), '<puerto-app>'));
  const cookies = await fetch(`${base}/cookies-padre`, { redirect: 'manual' });
  report('Set-Cookie reenviadas sin cambios', cookies.headers.getSetCookie().map((c) => c.split(';').slice(0, 2).join(';')));

  const https = tailscale(['serve', '--bg', `--https=${HTTPS_PORT}`, `http://127.0.0.1:${app.port}`], 10000);
  report('serve --https', https.ok ? 'aceptado' : https.out.split('\n').slice(0, 4).join(' / '));
  const service = tailscale(['serve', `--service=${SERVICE}`, '--https=443', `http://127.0.0.1:${app.port}`], 10000);
  report(`serve --service=${SERVICE}`, service.ok ? 'aceptado' : service.out.split('\n').slice(0, 4).join(' / '));
} finally {
  tailscale(['serve', `--http=${HTTP_PORT}`, 'off']);
  tailscale(['serve', `--https=${HTTPS_PORT}`, 'off']);
  const now = serveConfig();
  if (now.Services?.[SERVICE]) tailscale(['serve', 'clear', SERVICE]);
  await app.close();
  report('configuración de Serve restaurada idéntica', isDeepStrictEqual(before, serveConfig()));
}
