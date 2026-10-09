import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PathLike } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { controlSocketPath, sendControlRequest, startService } from '../src/control.ts';
import { createApp } from '../src/server.ts';
import { RunManager } from '../src/runs.ts';
import { FakeHermes } from '../support/fake_hermes.ts';
import type { DeviceStore } from '../src/deviceStore.ts';
import type { Pairing } from '../src/pairing.ts';
import { eventually } from '../support/channel.ts';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-control-'));
  const directory = path.join(root, 'bridge'); const runtimeDirectory = path.join(root, 'runtime');
  await fs.mkdir(directory, { mode: 0o700 }); await fs.mkdir(runtimeDirectory, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hermes = new FakeHermes(); const runs = new RunManager({ hermes, notifier: { approvalCreated: async () => {} } }); t.after(() => runs.close());
  const options = { directory, runtimeDirectory, host: '127.0.0.1', port: 0, origin: async () => 'http://arch.example.ts.net:8650', serverName: 'arch',
    createHttpApp: (security: { store: DeviceStore; pairing: Pairing }) => createApp({ ...security, config: { corsOrigins: [] }, hermes, runs, tailnet: { whois: async () => ({ device: 'phone', tailnet: 'example.ts.net' }) }, peerAddress: () => '100.64.0.1' }) };
  return { directory, runtimeDirectory, options, hermes };
}

// Sends one request and collects the reply. Only the deadline answers before reading the request,
// so tests not about the deadline keep the default one. When the deadline answers first, closing
// with the request unread makes Linux deliver the reply followed by ECONNRESET instead of FIN.
function exchange(socket: net.Socket, input: string, deadline: boolean) {
  return new Promise<string>((resolve, reject) => {
    let output = ''; socket.on('connect', () => socket.write(input)); socket.on('data', (chunk) => { output += chunk; });
    socket.on('end', () => resolve(output));
    socket.on('error', (error: NodeJS.ErrnoException) => deadline && error.code === 'ECONNRESET' ? resolve(output) : reject(error));
  });
}

test('private control socket uses checkout identity and exchanges pair/list/revoke without hashes', async (t) => {
  const f = await fixture(t); const service = await startService(f.options); t.after(() => service.close());
  const file = await controlSocketPath(f.directory, f.runtimeDirectory);
  const hash = crypto.createHash('sha256').update(await fs.realpath(f.directory)).digest('hex').slice(0, 24);
  assert.equal(file, path.join(f.runtimeDirectory, 'relayd', `${hash}.sock`));
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700); assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const pair = await sendControlRequest({ directory: f.directory, runtimeDirectory: f.runtimeDirectory, request: { command: 'pair' } });
  assert.equal(pair.ok, true); if (!pair.ok || !('payload' in pair.result)) throw new Error('Wrong result');
  const paired = await service.pairing.redeem(pair.result.payload.code, 'phone', '100.64.0.1');
  const devices = await sendControlRequest({ directory: f.directory, runtimeDirectory: f.runtimeDirectory, request: { command: 'devices' } });
  assert.equal(devices.ok, true); assert.ok(!JSON.stringify(devices).includes('keyHash'));
  const revoke = await sendControlRequest({ directory: f.directory, runtimeDirectory: f.runtimeDirectory, request: { command: 'revoke', deviceId: paired.device.id } });
  assert.equal(revoke.ok, true); assert.equal((await service.pairing.devices()).devices[0].revokedAt !== null, true);
  const missing = await sendControlRequest({ directory: f.directory, runtimeDirectory: f.runtimeDirectory, request: { command: 'revoke', deviceId: crypto.randomUUID() } });
  assert.equal(missing.ok, false); if (missing.ok) throw new Error('Wrong result'); assert.equal(missing.error.code, 'device_not_found');
});

test('second service with the same port or the same checkout cannot write state; existing service remains alive', async (t) => {
  const f = await fixture(t); const service = await startService(f.options); t.after(() => service.close());
  const file = path.join(f.directory, 'devices.json'); const before = await fs.readFile(file);
  const stateOpens: unknown[] = [];
  const stateIO = { ...fs, async open(...args: Parameters<typeof fs.open>) { stateOpens.push(args[0]); return fs.open(...args); } };
  await assert.rejects(startService({ ...f.options, stateIO, port: (service.server.address() as AddressInfo).port }));
  await assert.rejects(startService({ ...f.options, stateIO }));
  assert.deepEqual(stateOpens, []);
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal((await sendControlRequest({ directory: f.directory, runtimeDirectory: f.runtimeDirectory, request: { command: 'devices' } })).ok, true);
});

test('startup corruption closes TCP and its socket; absent runtime fails without creating state', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, 'devices.json'), 'invalid-private-fixture', { mode: 0o600 });
  await assert.rejects(startService(f.options));
  await assert.rejects(fs.lstat(await controlSocketPath(f.directory, f.runtimeDirectory)), { code: 'ENOENT' });
  await assert.rejects(startService({ ...f.options, runtimeDirectory: undefined }), /systemd/);
  assert.equal(await fs.readFile(path.join(f.directory, 'devices.json'), 'utf8'), 'invalid-private-fixture');
});

test('control framing rejects oversized, malformed and additional fields without leaking request content', async (t) => {
  const f = await fixture(t); const service = await startService(f.options); t.after(() => service.close());
  const file = await controlSocketPath(f.directory, f.runtimeDirectory);
  for (const input of ['{"command":"pair","private":"fixture"}\n', 'invalid-private-fixture\n', 'x'.repeat(4097), '{"command":"devices"}\n{"command":"pair"}\n', '{"command":"revoke","deviceId":"prefix"}\n']) {
    const reply = await exchange(net.createConnection(file), input, false);
    assert.equal(JSON.parse(reply).error.code, 'invalid_command'); assert.ok(!reply.includes('private'));
  }
  assert.equal(service.store.snapshot().pendingPairing, null);
});

test('control client rejects permissive or foreign-owned sockets without changing them', async (t) => {
  const f = await fixture(t); const service = await startService(f.options); t.after(() => service.close());
  const file = await controlSocketPath(f.directory, f.runtimeDirectory);
  await fs.chmod(file, 0o644);
  await assert.rejects(sendControlRequest({ directory: f.directory, runtimeDirectory: f.runtimeDirectory, request: { command: 'devices' } }));
  assert.equal((await fs.lstat(file)).mode & 0o777, 0o644); await fs.chmod(file, 0o600);
  const original = fs.lstat;
  t.mock.method(fs, 'lstat', async (target: PathLike) => {
    const stat = await original(target);
    if (String(target) === file) Object.assign(stat, { uid: (process.getuid?.() ?? 0) + 1 });
    return stat;
  });
  await assert.rejects(sendControlRequest({ directory: f.directory, runtimeDirectory: f.runtimeDirectory, request: { command: 'devices' } }));
});

test('stale owned socket is removed only after winning TCP; symlinks and permissive runtime are rejected', async (t) => {
  const f = await fixture(t);
  const file = await controlSocketPath(f.directory, f.runtimeDirectory); await fs.mkdir(path.dirname(file), { mode: 0o700 });
  const stale = net.createServer(); await new Promise<void>((resolve) => stale.listen(file, resolve)); await fs.chmod(file, 0o600);
  await fs.link(file, `${file}.copy`); await new Promise<void>((resolve) => stale.close(() => resolve())); await fs.rename(`${file}.copy`, file);
  const service = await startService(f.options); await service.close();
  await fs.symlink(path.join(f.directory, 'devices.json'), file);
  await assert.rejects(startService(f.options)); await fs.unlink(file);
  await fs.chmod(f.runtimeDirectory, 0o777); await assert.rejects(startService(f.options));
});

test('fatal state commit closes listeners and refuses further requests', async (t) => {
  const f = await fixture(t); let fail = false;
  const service = await startService({ ...f.options, stateIO: { ...fs, async rename(...args) { await fs.rename(...args); if (fail) throw new Error('private-fixture'); } } });
  t.after(() => service.close());
  fail = true; await assert.rejects(service.pairing.pair());
  await eventually(() => assert.equal(service.server.listening, false));
  await assert.rejects(sendControlRequest({ directory: f.directory, runtimeDirectory: f.runtimeDirectory, request: { command: 'devices' } }));
});

test('control deadlines bound incomplete requests and clients reject symlinked socket directories', async (t) => {
  const f = await fixture(t); const service = await startService({ ...f.options, controlTimeoutMs: 20 }); t.after(() => service.close());
  const file = await controlSocketPath(f.directory, f.runtimeDirectory);
  const reply = await exchange(net.createConnection(file), '{', true);
  assert.equal(JSON.parse(reply).error.code, 'unavailable');
  const actual = path.join(f.runtimeDirectory, 'relayd-real');
  await fs.rename(path.dirname(file), actual); await fs.symlink(actual, path.dirname(file));
  await assert.rejects(sendControlRequest({ directory: f.directory, runtimeDirectory: f.runtimeDirectory, request: { command: 'devices' } }));
  await fs.unlink(path.dirname(file)); await fs.rename(actual, path.dirname(file));
});

for (const [input, code, controlTimeoutMs] of [['{', 'unavailable', 20], ['x'.repeat(4097), 'invalid_command', undefined]] as const) {
  test(`B3 control releases a half-open ${code} peer that never sends FIN`, async (t) => {
    const f = await fixture(t); const service = await startService({ ...f.options, controlTimeoutMs }); t.after(() => service.close());
    const socket = net.createConnection({ path: await controlSocketPath(f.directory, f.runtimeDirectory), allowHalfOpen: true });
    t.after(() => socket.destroy());
    const reply = await exchange(socket, input, code === 'unavailable');
    assert.equal(JSON.parse(reply).error.code, code); assert.equal(socket.writableEnded, false);
    await eventually(async () => {
      const connections = await new Promise<number>((resolve, reject) => service.control.getConnections((error, count) => error ? reject(error) : resolve(count)));
      assert.equal(connections, 0);
    }, 200);
  });
}
