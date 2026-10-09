// Lab topology: two fake apps, a fake external CDN, the simulated Serve/Services front and,
// depending on the configuration, the Puente's per-app web listeners and its control API.
//
//   servicios-puente   one HTTPS name per app → Puente web listener of that app → app (target design)
//   serve-directo      one HTTPS name per app → app directly (what Serve to the dev server gives)
//   puertos-mismo-host one machine name, one HTTPS port per app → Puente web listener → app
//
// `node src/lab.ts [config]` keeps a lab running for manual browsing and prints how to open it.
import { randomBytes } from 'node:crypto';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { makeCert, type LabCert } from './certs.ts';
import { startFakeApp, type FakeApp } from './fakeApp.ts';
import { startServeSim, type ServeSim } from './serveSim.ts';
import { createAuthority, startControl, startWebGate, type Authority, type ControlApi, type WebGate } from './webGate.ts';

export const CONFIGS = ['servicios-puente', 'serve-directo', 'puertos-mismo-host'] as const;
export type Config = (typeof CONFIGS)[number];

// Desktop lab names reproduce the tailnet shape: `ts.net` is a public suffix, the tailnet name
// is the registrable parent shared by sibling Services. A real browser maps them to loopback.
export type Names = { parent: string; cdn: string };
export const DESKTOP_NAMES: Names = { parent: 'relay-lab.ts.net', cdn: 'cdn.relay-lab.test' };

export type Lab = {
  config: Config;
  cert: LabCert;
  names: Names;
  hosts: { a: string; b: string; server: string; cdn: string };
  origins: { a: string; b: string; cdn: string; control: string };
  apps: { a: FakeApp; b: FakeApp };
  gates?: { a: WebGate; b: WebGate };
  authority?: Authority;
  devices: { movil: string; tablet: string };
  restartPuente(): Promise<void>;
  close(): Promise<void>;
};

export type LabOptions = { now?: () => number; names?: Names; cert?: LabCert };

async function startCdn(cert: LabCert) {
  const server = https.createServer({ cert: cert.cert, key: cert.key }, (req, res) => {
    if (req.url === '/lib.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' });
      res.end("document.documentElement.dataset.cdn = 'ok';");
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Web externa</title><p id="externa">web externa</p>');
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  return { port: (server.address() as AddressInfo).port, server };
}

export async function startLab(config: Config, opts: LabOptions = {}): Promise<Lab> {
  const now = opts.now ?? Date.now;
  const names = opts.names ?? DESKTOP_NAMES;
  const HOSTS = { a: `app-a.${names.parent}`, b: `app-b.${names.parent}`, server: `servidor.${names.parent}`, cdn: names.cdn };
  const cert = opts.cert ?? makeCert([`*.${names.parent}`, names.cdn]);
  const cdn = await startCdn(cert);
  const cdnOrigin = `https://${HOSTS.cdn}:${cdn.port}`;
  const apps = { a: await startFakeApp({ name: 'app-a', cdnOrigin }), b: await startFakeApp({ name: 'app-b', cdnOrigin }) };
  const devices = { movil: randomBytes(32).toString('base64url'), tablet: randomBytes(32).toString('base64url') };

  // Fronts first: public origins must be known before the listeners that check them.
  const fronts: ServeSim[] = config === 'puertos-mismo-host'
    ? [await startServeSim(cert, new Map()), await startServeSim(cert, new Map())]
    : [await startServeSim(cert, new Map())];
  const front = { a: fronts[0], b: fronts.at(-1)! };
  const host = config === 'puertos-mismo-host' ? { a: HOSTS.server, b: HOSTS.server } : { a: HOSTS.a, b: HOSTS.b };
  const origins = {
    a: `https://${host.a}:${front.a.port}`,
    b: `https://${host.b}:${front.b.port}`,
    cdn: cdnOrigin,
    control: '',
  };

  let authority: Authority | undefined;
  let gates: { a: WebGate; b: WebGate } | undefined;
  let controlApi: ControlApi | undefined;
  let sweeper: NodeJS.Timeout | undefined;

  async function startPuente() {
    authority = createAuthority({ now, devices });
    gates = {
      a: await startWebGate({ app: 'app-a', publicOrigin: origins.a, upstreamPort: apps.a.port, authority, now }),
      b: await startWebGate({ app: 'app-b', publicOrigin: origins.b, upstreamPort: apps.b.port, authority, now }),
    };
    front.a.routes.set(host.a, gates.a.port);
    front.b.routes.set(host.b, gates.b.port);
    controlApi = await startControl({ authority, port: controlApi?.port ?? 0 });
    origins.control = `http://${HOSTS.server}:${controlApi.port}`;
    sweeper = setInterval(() => authority?.sweep(), 1000).unref();
  }

  async function stopPuente() {
    clearInterval(sweeper);
    await Promise.all([gates?.a.close(), gates?.b.close(), controlApi?.close()]);
  }

  if (config === 'serve-directo') {
    front.a.routes.set(host.a, apps.a.port);
    front.b.routes.set(host.b, apps.b.port);
  } else {
    await startPuente();
  }

  return {
    config,
    cert,
    names,
    hosts: HOSTS,
    origins,
    apps,
    get gates() { return gates; },
    get authority() { return authority; },
    devices,
    async restartPuente() {
      await stopPuente();
      await startPuente();
    },
    async close() {
      await stopPuente();
      await Promise.all([...fronts.map((f) => f.close()), apps.a.close(), apps.b.close()]);
      cdn.server.closeAllConnections();
      cdn.server.close();
    },
  };
}

if (import.meta.main) {
  const config = (process.argv[2] ?? 'servicios-puente') as Config;
  if (!CONFIGS.includes(config)) throw new Error(`config must be one of ${CONFIGS.join(', ')}`);
  const lab = await startLab(config);
  console.log(`lab ${config}`);
  console.log(`  app A   ${lab.origins.a}/`);
  console.log(`  app B   ${lab.origins.b}/`);
  console.log(`  control ${lab.origins.control || '(none)'}  (Bearer key per device, never shown)`);
  console.log(`  chromium --user-data-dir=$(mktemp -d) --host-resolver-rules="MAP *.${lab.names.parent} 127.0.0.1,MAP ${lab.names.cdn} 127.0.0.1" --ignore-certificate-errors-spki-list=${lab.cert.spki} ${lab.origins.a}/`);
  if (lab.authority) {
    // Grants pending requests by code typed on stdin, standing in for Relay's native screen.
    console.log('Type the code shown in the browser to grant it, or "revocar a|b".');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (line: string) => {
      const input = line.trim().toUpperCase();
      for (const app of ['app-a', 'app-b']) {
        if (input === `REVOCAR ${app.slice(-1).toUpperCase()}`) console.log('revoked', lab.authority!.revokeApp(app));
        const found = lab.authority!.pendingFor(app).find((p) => p.code === input);
        if (found) console.log(`granted ${app} until ${new Date(lab.authority!.grant(app, found.id, 'movil')!.expiresAt).toISOString()}`);
      }
    });
  }
}
