import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { SUPERVISOR_KEY_FILE, SUPERVISOR_LINE_BYTES, SUPERVISOR_PROTOCOL, SUPERVISOR_SOCKET_FILE, type ChannelEvent } from '../../protocol/supervisor.ts';
import { listenSupervisor } from '../src/server.ts';
import { openSupervisor, type Supervisor } from '../src/supervisor.ts';
import { FakeHost } from '../support/fakeHost.ts';
import { auth, connect } from '../support/rawClient.ts';

const DEVICE = '00000000-0000-4000-8000-000000000001';
const ENV = 'env_AAAAAAAAAAAAAAAAAAAAAA';
const SHELLS = fileURLToPath(new URL('./fixtures/shells', import.meta.url));
const TERMINAL = { shell: '/bin/sh', cwd: os.tmpdir() };
const CHANNEL = 'AAAAAAAAAAAAAAAAAAAAAA';

async function setup(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-supervisor-'));
  const runtime = path.join(root, 'run');
  const host = new FakeHost();
  const supervisor = await openSupervisor({ directory: path.join(root, 'state'), host, unitPrefix: 'relay-test', shellsFile: SHELLS, timing: { terminateGraceMs: 10, terminateGiveUpMs: 20, pollMs: 2 }, browser: process.execPath, downloads: path.join(root, 'downloads') });
  const server = await listenSupervisor({ runtimeDirectory: runtime, supervisor, authTimeoutMs: 200 });
  t.after(async () => { await server.close(); await supervisor.close(); await fs.rm(root, { recursive: true, force: true }); });
  const key = await fs.readFile(path.join(runtime, SUPERVISOR_KEY_FILE), 'utf8');
  return { runtime, host, supervisor, key };
}

async function authenticated(runtime: string, key: string) {
  const client = await connect(runtime);
  assert.equal((await client.next())?.type, 'hello');
  client.send(auth(key));
  assert.deepEqual(await client.next(), { type: 'ready', availability: { state: 'available' } });
  return client;
}

test('the channel is private: directory 0700, socket and key 0600', async (t) => {
  const { runtime } = await setup(t);
  assert.equal((await fs.stat(runtime)).mode & 0o777, 0o700);
  assert.equal((await fs.lstat(path.join(runtime, SUPERVISOR_SOCKET_FILE))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(runtime, SUPERVISOR_KEY_FILE))).mode & 0o777, 0o600);
});

test('a connection without the key cannot list, adopt, terminate nor hear about environments', async (t) => {
  const { runtime, host, key, supervisor } = await setup(t);
  const owner = await authenticated(runtime, key);
  owner.send({ id: 1, op: 'register', environment: { id: ENV, deviceId: DEVICE, kind: 'terminal', requestId: 'request-1', createdAt: 1, terminal: TERMINAL } });
  await owner.next();
  owner.send({ id: 2, op: 'launch', environmentId: ENV });
  await owner.next();
  const wrong = `${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`;
  for (const [label, first] of [
    ['no auth', { id: 1, op: 'list' }],
    ['terminate first', { id: 1, op: 'terminate', environmentId: ENV }],
    ['wrong key', auth(wrong)],
    ['short key', auth(key.slice(0, 10))],
    ['empty key', auth('')],
    ['key with extra field', { ...auth(key), deviceId: DEVICE }],
  ] as const) {
    const foreign = await connect(runtime);
    assert.equal((await foreign.next())?.type, 'hello');
    foreign.send(first);
    foreign.send({ id: 2, op: 'terminate', environmentId: ENV });
    foreign.send({ id: 3, op: 'list' });
    assert.deepEqual(await foreign.next(), { type: 'refused', code: 'unauthorized' }, label);
    await foreign.closed;
    assert.deepEqual(foreign.lines, [], label);
  }
  // A silent connection is closed too, having received only the greeting.
  const silent = await connect(runtime);
  await silent.next();
  await silent.closed;
  assert.deepEqual(silent.lines, []);
  assert.deepEqual(host.signals, []);
  assert.equal(supervisor.list()[0]!.state, 'running');
  owner.socket.destroy();
});

test('an incompatible Puente is refused before any operation', async (t) => {
  const { runtime, key } = await setup(t);
  for (const extra of [{ minSupervisorProtocol: SUPERVISOR_PROTOCOL + 1 }, { puenteProtocol: 1 }, { puenteProtocol: '2' }]) {
    const client = await connect(runtime);
    await client.next();
    client.send(auth(key, extra));
    assert.deepEqual(await client.next(), { type: 'refused', code: 'incompatible' }, JSON.stringify(extra));
    await client.closed;
  }
});

test('a browser operation that is not exactly a bounded action closes the connection before reaching the browser', async (t) => {
  const { runtime, key, host } = await setup(t);
  const owner = await authenticated(runtime, key);
  owner.send({ id: 1, op: 'register', environment: { id: ENV, deviceId: DEVICE, kind: 'browser_dedicated', requestId: 'request-1', createdAt: 1 } });
  assert.equal((await owner.reply())?.ok, true);
  owner.send({ id: 2, op: 'launch', environmentId: ENV });
  assert.equal(((await owner.reply())?.environment as { state: string }).state, 'running');
  const browser = host.browsers.get(`relay-test-${ENV}`)!;
  owner.send({ id: 3, op: 'tabs', environmentId: ENV, deviceId: DEVICE });
  const tab = ((await owner.reply())?.tabs as { id: string }[])[0]!.id;
  const target = { environmentId: ENV, deviceId: DEVICE, tab };
  const before = browser.calls.length;
  for (const [label, bad] of [
    ['raw CDP', { id: 4, op: 'act', ...target, action: { type: 'cdp', method: 'Runtime.evaluate', params: { expression: '1' } } }],
    ['extra field', { id: 4, op: 'act', ...target, action: { type: 'reload', method: 'Runtime.evaluate' } }],
    ['file URL', { id: 4, op: 'act', ...target, action: { type: 'navigate', url: 'file:///etc/passwd' } }],
    ['internal page', { id: 4, op: 'openTab', environmentId: ENV, deviceId: DEVICE, url: 'chrome://settings' }],
    ['relative file', { id: 4, op: 'act', ...target, action: { type: 'files', paths: ['etc/passwd'] } }],
  ] as const) {
    const client = await authenticated(runtime, key);
    client.send(bad);
    // Fails at once, not at the suite's timeout, if the connection stays open.
    const closed = await Promise.race([client.closed.then(() => true), sleep(2000, false, { ref: false })]);
    assert.ok(closed, `${label}: the connection stayed open`);
    assert.deepEqual(client.lines, [], label);
  }
  assert.equal(browser.calls.length, before);
});

test('one Puente at a time: a new authenticated connection replaces the previous one and gets the events', async (t) => {
  const { runtime, key } = await setup(t);
  const first = await authenticated(runtime, key);
  first.send({ id: 1, op: 'register', environment: { id: ENV, deviceId: DEVICE, kind: 'terminal', requestId: 'request-1', createdAt: 1, terminal: TERMINAL } });
  assert.equal((await first.next())?.ok, true);
  const second = await authenticated(runtime, key);
  await first.closed;
  second.send({ id: 7, op: 'launch', environmentId: ENV });
  assert.partialDeepStrictEqual(await second.next(), { environment: { state: 'running' } });
  second.send({ id: 8, op: 'terminate', environmentId: ENV });
  const received = [await second.next(), await second.next()];
  assert.deepEqual(received.find((line) => line?.type === 'event'), { type: 'event', action: 'terminated', environmentId: ENV });
  second.socket.destroy();
});

test('an event that happens before ready waits for it, then reaches the new Puente', async (t) => {
  const { runtime, key, host, supervisor } = await setup(t);
  await supervisor.register({ id: ENV, deviceId: DEVICE, kind: 'terminal', requestId: 'request-1', createdAt: 1, terminal: TERMINAL });
  await supervisor.launch(ENV);
  const checked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  host.availability = async () => { checked.resolve(); await release.promise; return { state: 'available' }; };
  const client = await connect(runtime);
  assert.equal((await client.next())?.type, 'hello');
  client.send(auth(key));
  await checked.promise;
  await supervisor.terminate(ENV);
  release.resolve();
  assert.deepEqual(await client.next(), { type: 'ready', availability: { state: 'available' } });
  assert.deepEqual(await client.next(), { type: 'event', action: 'terminated', environmentId: ENV });
  client.socket.destroy();
});

test('a Puente that leaves before ready takes no event with it', { timeout: 2000 }, async (t) => {
  const { runtime, key, host, supervisor } = await setup(t);
  await supervisor.register({ id: ENV, deviceId: DEVICE, kind: 'terminal', requestId: 'request-1', createdAt: 1, terminal: TERMINAL });
  await supervisor.launch(ENV);
  const checked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const available = host.availability.bind(host);
  host.availability = async () => { checked.resolve(); await release.promise; return available(); };
  const gone = await connect(runtime);
  await gone.next();
  gone.send(auth(key));
  await checked.promise;
  gone.socket.destroy();
  await gone.closed;
  await supervisor.terminate(ENV);
  release.resolve();
  const client = await authenticated(runtime, key);
  assert.deepEqual(await client.next(), { type: 'event', action: 'terminated', environmentId: ENV });
  client.socket.destroy();
});

test('malformed requests close the connection; supervisor errors answer by code', async (t) => {
  const { runtime, key } = await setup(t);
  const client = await authenticated(runtime, key);
  client.send({ id: 1, op: 'terminate', environmentId: ENV });
  assert.deepEqual(await client.next(), { type: 'response', id: 1, ok: false, code: 'not_found' });
  client.send({ id: 2, op: 'register', environment: { id: ENV, deviceId: DEVICE, kind: 'terminal', requestId: 'request-1', createdAt: 1, terminal: TERMINAL, ownership: 'shared' } });
  await client.closed;
});

test('an answer too long for a line fails alone and keeps the channel; an event that long is never sent', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-supervisor-'));
  const core = await openSupervisor({ directory: path.join(root, 'state'), host: new FakeHost(), unitPrefix: 'relay-test', shellsFile: SHELLS });
  const huge = [{ id: 'T1', url: 'u'.repeat(SUPERVISOR_LINE_BYTES), title: '', limitation: 'internal_page' as const, createdByRelay: false, dialog: null, fileChooser: null }];
  let emit: (event: ChannelEvent) => void = () => {};
  // Whatever unbounded data a future operation could produce: the server is the last guard.
  const supervisor: Supervisor = {
    ...core, tabs: () => huge,
    onChannel: (listener) => { emit = listener; },
    attach: (_target, channel) => { emit({ channel, type: 'tabs', tabs: huge }); emit({ channel, type: 'opened', inputSeq: 0 }); },
  };
  const runtime = path.join(root, 'run');
  const server = await listenSupervisor({ runtimeDirectory: runtime, supervisor });
  t.after(async () => { await server.close(); await core.close(); await fs.rm(root, { recursive: true, force: true }); });
  const client = await authenticated(runtime, await fs.readFile(path.join(runtime, SUPERVISOR_KEY_FILE), 'utf8'));
  client.send({ id: 1, op: 'tabs', environmentId: ENV, deviceId: DEVICE });
  assert.deepEqual(await client.next(), { type: 'response', id: 1, ok: false, code: 'unavailable' });
  client.send({ id: 2, op: 'list' });
  assert.deepEqual(await client.next(), { type: 'response', id: 2, ok: true, environments: [] });
  client.send({ id: 3, op: 'attach', environmentId: ENV, deviceId: DEVICE, channel: CHANNEL, after: 0 });
  assert.deepEqual(await client.next(), { channel: CHANNEL, type: 'opened', inputSeq: 0 });
  assert.deepEqual(await client.next(), { type: 'response', id: 3, ok: true });
});

test('a terminal speaks only to the authenticated Puente: frames, then nothing once it is gone', async (t) => {
  const { runtime, key, host } = await setup(t);
  const first = await authenticated(runtime, key);
  first.send({ id: 1, op: 'register', environment: { id: ENV, deviceId: DEVICE, kind: 'terminal', requestId: 'request-1', createdAt: 1, terminal: TERMINAL } });
  await first.next();
  first.send({ id: 2, op: 'launch', environmentId: ENV });
  await first.next();
  const pty = host.ptys.get(`relay-test-${ENV}`)!;
  first.send({ id: 3, op: 'attach', environmentId: ENV, deviceId: DEVICE, channel: CHANNEL, after: 0 });
  assert.deepEqual(await first.next(), { channel: CHANNEL, type: 'opened', inputSeq: 0 });
  assert.deepEqual(await first.next(), { type: 'response', id: 3, ok: true });
  pty.output(Buffer.from([0xc3]));
  assert.deepEqual(await first.next(), { channel: CHANNEL, type: 'output', seq: 1, data: Buffer.from([0xc3]).toString('base64') });
  first.send({ id: 4, op: 'input', environmentId: ENV, deviceId: DEVICE, seq: 1, data: Buffer.from('ñ').toString('base64') });
  assert.deepEqual(await first.next(), { type: 'response', id: 4, ok: true, inputSeq: 1 });
  first.send({ id: 5, op: 'input', environmentId: ENV, deviceId: DEVICE, seq: 2, data: Buffer.alloc(32_769).toString('base64') });
  assert.deepEqual(await first.next(), { type: 'response', id: 5, ok: false, code: 'invalid' }, 'an input frame over the limit');

  // Another Puente takes over: the old channel is detached and its frames go nowhere.
  const second = await authenticated(runtime, key);
  await first.closed;
  pty.output(Buffer.from('after'));
  second.send({ id: 1, op: 'list' });
  assert.equal((await second.next())?.type, 'response', 'no frame of the old channel reaches the new Puente');
  assert.deepEqual(pty.written.map(String), ['ñ']);
  second.socket.destroy();
});

test('a request line split inside a UTF-8 character arrives whole', async (t) => {
  const { runtime, key, supervisor } = await setup(t);
  const client = await authenticated(runtime, key);
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-Música-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const line = Buffer.from(`${JSON.stringify({ id: 1, op: 'register', environment: { id: ENV, deviceId: DEVICE, kind: 'terminal', requestId: 'request-1', createdAt: 1, terminal: { shell: '/bin/sh', cwd: folder } } })}\n`);
  const cut = line.indexOf(Buffer.from('ú')) + 1;
  client.socket.write(line.subarray(0, cut));
  await new Promise((resolve) => setTimeout(resolve, 20));
  client.socket.write(line.subarray(cut));
  assert.equal((await client.next())?.ok, true);
  assert.equal(supervisor.list()[0]!.terminal!.cwd, folder);
  client.socket.destroy();
});
