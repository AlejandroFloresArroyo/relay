import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Exec } from '../src/exec.ts';
import { createManualPublisher, servePlan, webPublicationReport } from '../src/remote/tailscaleServices.ts';
import { serve } from '../src/main.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';

const SERVICE = 'relay-abcdefgh01234567';
const OTHER = 'relay-zzzzzzzz99999999';
const LISTENER = 41234;
const APP_PORT = 5173;
const SUFFIX = 'tail1234.ts.net';
// Fields `tailscale status --json` carries that must never reach output: identifiers and the tailnet.
const SECRETS = ['nodekey:synthetic-secret-node-key', 'nSynthetic123CNTRL', 'synthetic-tailnet-name', 'synthetic-login@example.com', 'mkey:synthetic-machine'];
const RUNNING = {
  BackendState: 'Running', MagicDNSSuffix: `${SUFFIX}.`, CertDomains: [`arch.${SUFFIX}`],
  CurrentTailnet: { Name: SECRETS[2], MagicDNSSuffix: SUFFIX },
  Self: { ID: SECRETS[1], PublicKey: SECRETS[0], DNSName: `arch.${SUFFIX}.`, Tags: ['tag:relay'], UserID: 1 },
  User: { 1: { LoginName: SECRETS[3] } }, MachineKey: SECRETS[4],
};
const served = (service: string, port: number) => ({
  TCP: { 443: { HTTPS: true } },
  Web: { [`${service}.${SUFFIX}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } },
});

type Reply = { code: number; stdout: string } | Error;
/** Scripted `tailscale status --json` and `tailscale serve status --json`; anything else fails the test. */
function fakeExec(status: Reply | object, serveStatus: Reply | object = { Services: { [`svc:${SERVICE}`]: served(SERVICE, LISTENER) } }) {
  const calls: string[][] = [];
  const reply = (value: Reply | object) => {
    if (value instanceof Error) throw value;
    return 'code' in value && 'stdout' in value ? { ...value, stderr: 'synthetic-secret-stderr' } : { code: 0, stdout: JSON.stringify(value), stderr: '' };
  };
  const exec: Exec = async (file, args, options) => {
    calls.push([file, ...args]);
    assert.equal(file, 'tailscale'); assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 5000);
    if (args.join(' ') === 'status --json') return reply(status);
    if (args.join(' ') === 'serve status --json') return reply(serveStatus);
    throw new Error(`unexpected tailscale ${args.join(' ')}`);
  };
  return { exec, calls };
}
const missing = Object.assign(new Error('could not run tailscale: ENOENT'), { code: 'ENOENT' });

test('availability classifies Tailscale without throwing', async () => {
  const cases: [Reply | object, unknown][] = [
    [missing, { state: 'unavailable', reason: 'dependency_missing' }],
    [{ code: 1, stdout: '' }, { state: 'unavailable', reason: 'helper_stopped' }],
    [{ ...RUNNING, BackendState: 'Stopped' }, { state: 'unavailable', reason: 'helper_stopped' }],
    [{ code: 0, stdout: '{synthetic' }, { state: 'unavailable', reason: 'helper_stopped' }],
    [{ ...RUNNING, CertDomains: undefined }, { state: 'unavailable', reason: 'not_configured' }],
    [{ ...RUNNING, CertDomains: [] }, { state: 'unavailable', reason: 'not_configured' }],
    [RUNNING, { state: 'available' }],
  ];
  for (const [status, expected] of cases) assert.deepEqual(await createManualPublisher({ exec: fakeExec(status).exec }).availability(), expected);
});

test('publish only verifies, in order, and reports the Service origin when it points at the listener', async () => {
  const blocked = (reason: string) => ({ state: 'blocked', reason });
  const cases: [Reply | object, Reply | object | undefined, unknown][] = [
    [missing, undefined, blocked('tailscale_unavailable')],
    [{ code: 1, stdout: '' }, undefined, blocked('tailscale_unavailable')],
    [{ ...RUNNING, BackendState: 'NeedsLogin' }, undefined, blocked('tailscale_unavailable')],
    [{ code: 0, stdout: 'not json' }, undefined, blocked('tailscale_unavailable')],
    [{ ...RUNNING, MagicDNSSuffix: 'evil.example.com' }, undefined, blocked('tailscale_unavailable')],
    [{ ...RUNNING, CertDomains: undefined, Self: { ...RUNNING.Self, Tags: undefined } }, undefined, blocked('serve_disabled')],
    [{ ...RUNNING, Self: { ...RUNNING.Self, Tags: [] } }, undefined, blocked('host_not_tagged')],
    [{ ...RUNNING, Self: { ...RUNNING.Self, Tags: undefined } }, undefined, blocked('host_not_tagged')],
    [RUNNING, { code: 1, stdout: '' }, blocked('tailscale_unavailable')],
    [RUNNING, { code: 0, stdout: '{x' }, blocked('tailscale_unavailable')],
    [RUNNING, { code: 0, stdout: '' }, blocked('service_undefined')],
    [RUNNING, {}, blocked('service_undefined')],
    [RUNNING, { Services: { [`svc:${OTHER}`]: served(OTHER, LISTENER) } }, blocked('service_undefined')],
    [RUNNING, { Services: { [`svc:${SERVICE}`]: served(SERVICE, LISTENER + 1) } }, blocked('service_undefined')],
    [RUNNING, { Services: { [`svc:${SERVICE}`]: served(SERVICE, APP_PORT) } }, blocked('service_undefined')],
    [RUNNING, { Services: { [`svc:${SERVICE}`]: { ...served(SERVICE, LISTENER), TCP: { 443: { HTTPS: false } } } } }, blocked('service_undefined')],
    // Anything the Service forwards besides `/` towards the listener: another path, port, host name, or the whole host.
    [RUNNING, { Services: { [`svc:${SERVICE}`]: { ...served(SERVICE, LISTENER), Web: { [`${SERVICE}.${SUFFIX}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${LISTENER}` }, '/dev': { Proxy: `http://127.0.0.1:${APP_PORT}` } } } } } } }, blocked('service_undefined')],
    [RUNNING, { Services: { [`svc:${SERVICE}`]: { ...served(SERVICE, LISTENER), TCP: { 443: { HTTPS: true }, 8443: { TCPForward: `127.0.0.1:${APP_PORT}` } } } } }, blocked('service_undefined')],
    [RUNNING, { Services: { [`svc:${SERVICE}`]: { ...served(SERVICE, LISTENER), Web: { ...served(SERVICE, LISTENER).Web, [`${SERVICE}.${SUFFIX}:8443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${APP_PORT}` } } } } } } }, blocked('service_undefined')],
    [RUNNING, { Services: { [`svc:${SERVICE}`]: { ...served(SERVICE, LISTENER), Tun: true } } }, blocked('service_undefined')],
    [RUNNING, undefined, { state: 'published', origin: `https://${SERVICE}.${SUFFIX}` }],
  ];
  for (const [status, serveStatus, expected] of cases) {
    const { exec, calls } = fakeExec(status, serveStatus);
    const publisher = createManualPublisher({ exec });
    assert.deepEqual(await publisher.publish(SERVICE, LISTENER), expected, JSON.stringify([status, serveStatus]));
    await publisher.unpublish(SERVICE);
    // Read-only: never `serve` with set/clear arguments, only the two status reads.
    for (const call of calls) assert.ok(['tailscale status --json', 'tailscale serve status --json'].includes(call.join(' ')), call.join(' '));
  }
});

test('servePlan gives the manual argv for one Service and refuses anything else', () => {
  assert.deepEqual(servePlan(SERVICE, LISTENER), {
    publish: ['tailscale', 'serve', `--service=svc:${SERVICE}`, '--https=443', `http://127.0.0.1:${LISTENER}`],
    clear: ['tailscale', 'serve', 'clear', `svc:${SERVICE}`],
  });
  for (const [service, port] of [['relay-ABCDEFGH01234567', 1], ['relay-abc', 1], [`${SERVICE};rm`, 1], ['other', 1], [SERVICE, 0], [SERVICE, 65536], [SERVICE, 1.5]] as const) {
    assert.throws(() => servePlan(service, port));
  }
});

async function stateDirectory(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-services-'));
  await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
const record = (service: string, listenerPort: number, name: string) => ({
  id: `app_${service.slice(6)}${'a'.repeat(10)}`, name, address: '127.0.0.1', port: APP_PORT, identity: { exe: '/usr/bin/node', cwd: '/home/user/app' },
  service, listenerPort, requestId: 'request-0001', createdAt: 1_700_000_000_000,
});
async function registry(directory: string, apps: unknown[], mode = 0o600): Promise<void> {
  await fs.writeFile(path.join(directory, 'web-apps.json'), JSON.stringify({ schemaVersion: 1, apps }), { mode });
  await fs.chmod(path.join(directory, 'web-apps.json'), mode);
}
const noLeak = (text: string) => { for (const secret of [...SECRETS, 'synthetic-secret-stderr']) assert.ok(!text.includes(secret), secret); };

test('the report lists each app with its state and the exact command, and stale Services with theirs', async (t) => {
  const directory = await stateDirectory(t);
  const third = 'relay-cccccccc33333333';
  await registry(directory, [record(SERVICE, LISTENER, 'Panel'), record(OTHER, 41235, 'Notas')]);
  const { exec, calls } = fakeExec(RUNNING, { Services: { [`svc:${SERVICE}`]: served(SERVICE, LISTENER), [`svc:${third}`]: served(third, 40000), 'svc:unrelated': served('unrelated', 1) } });
  const text = await webPublicationReport({ exec, stateDirectory: directory });
  noLeak(text);
  for (const call of calls) assert.ok(['tailscale status --json', 'tailscale serve status --json'].includes(call.join(' ')));
  assert.match(text, /Panel/); assert.match(text, new RegExp(`svc:${SERVICE}`)); assert.match(text, new RegExp(`127\\.0\\.0\\.1:${LISTENER}`));
  assert.match(text, new RegExp(`publicada en https://${SERVICE}\\.${SUFFIX.replace(/\./g, '\\.')}`));
  assert.ok(!text.includes(`--service=svc:${SERVICE}`), 'a published app needs no command');
  assert.match(text, /Notas/);
  assert.ok(text.includes(`tailscale serve --service=svc:${OTHER} --https=443 http://127.0.0.1:41235`));
  assert.match(text, /obsoletos/);
  assert.ok(text.includes(`tailscale serve clear svc:${third}`));
  assert.ok(!text.includes('svc:unrelated'));
  assert.ok(!text.includes(`clear svc:${SERVICE}`) && !text.includes(`clear svc:${OTHER}`));
});

test('an app whose Service also forwards elsewhere is not published, and the report says to clear it before publishing', async (t) => {
  const directory = await stateDirectory(t);
  await registry(directory, [record(SERVICE, LISTENER, 'Panel')]);
  const extra = { ...served(SERVICE, LISTENER), TCP: { 443: { HTTPS: true }, 8443: { TCPForward: `127.0.0.1:${APP_PORT}` } } };
  const text = await webPublicationReport({ exec: fakeExec(RUNNING, { Services: { [`svc:${SERVICE}`]: extra } }).exec, stateDirectory: directory });
  assert.match(text, /sin publicar/); assert.doesNotMatch(text, /publicada en/);
  const clear = text.indexOf(`tailscale serve clear svc:${SERVICE}`), publish = text.indexOf(`tailscale serve --service=svc:${SERVICE} --https=443 http://127.0.0.1:${LISTENER}`);
  assert.ok(clear >= 0 && publish > clear, text);
});

test('the report explains blocks without the tailnet and refuses unreadable registries without echoing them', async (t) => {
  const directory = await stateDirectory(t);
  assert.match(await webPublicationReport({ exec: fakeExec(RUNNING, {}).exec, stateDirectory: directory }), /No hay aplicaciones registradas\./);

  await registry(directory, [record(OTHER, 41235, 'Notas')]);
  const untagged = await webPublicationReport({ exec: fakeExec({ ...RUNNING, Self: { ...RUNNING.Self, Tags: [] } }).exec, stateDirectory: directory });
  noLeak(untagged); assert.ok(!untagged.includes(SUFFIX)); assert.match(untagged, /etiqueta/);
  assert.ok(untagged.includes(`tailscale serve --service=svc:${OTHER} --https=443 http://127.0.0.1:41235`));
  const down = await webPublicationReport({ exec: fakeExec(missing).exec, stateDirectory: directory });
  noLeak(down); assert.match(down, /Tailscale/);

  const file = path.join(directory, 'web-apps.json');
  for (const write of [
    () => fs.writeFile(file, '{"synthetic-secret-content": ', { mode: 0o600 }),
    () => registry(directory, [{ ...record(OTHER, 41235, 'Notas'), extra: 'synthetic-secret-content' }]),
    () => registry(directory, [record(OTHER, 41235, 'synthetic-secret-content')], 0o644),
    async () => { await fs.writeFile(path.join(directory, 'elsewhere.json'), JSON.stringify({ schemaVersion: 1, apps: [record(OTHER, 1, 'synthetic-secret-content')] }), { mode: 0o600 }); await fs.symlink('elsewhere.json', file); },
  ]) {
    await fs.rm(file, { force: true }); await write();
    const text = await webPublicationReport({ exec: fakeExec(RUNNING).exec, stateDirectory: directory });
    assert.equal(text.trim().split('\n').length, 1, text); assert.ok(!text.includes('synthetic-secret-content'), text); assert.match(text, /web-apps\.json/);
  }
});

test('serve() wires and advertises web only with RELAY_REMOTE_WEB=1', async (t) => {
  const directory = await stateDirectory(t);
  const exec: Exec = async (_file, args) => ({ code: 0, stderr: '', stdout: args[0] === 'status'
    ? JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'arch.example.ts.net.' } }) : '100.64.0.1\n' });
  const advertised = async (env: Record<string, string>) => {
    let server: http.Server | undefined;
    await serve({ env: { RELAY_HOST: '100.64.0.1', HERMES_HOME: directory, ...env }, exec, start: async (options) => {
      const store = await createDeviceStore({ directory });
      server = await options.createHttpApp({ store, pairing: createPairing({ store, origin: async () => 'http://arch.example.ts.net:8650', serverName: 'arch' }), changeLog: store.changeLog });
      return { server, close: async () => {} } as never;
    } });
    server!.listen(0, '127.0.0.1'); await once(server!, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/health`);
      return (await response.json()).capabilities;
    } finally { server!.close(); await once(server!, 'close'); }
  };
  assert.equal((await advertised({})).web, undefined);
  assert.deepEqual((await advertised({ RELAY_REMOTE_WEB: '1' })).web, { version: 1, minAppVersion: 1 });
});
