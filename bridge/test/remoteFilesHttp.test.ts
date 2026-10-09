// /v1/remote/files/* through the real Puente HTTP server and the real file service on a temporary
// disk: paths only in bodies, the log line without them, revocation while a request is in flight.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate, setTimeout as sleep } from 'node:timers/promises';
import { REMOTE_LIMITS } from '../../protocol/protocol.ts';
import { REMOTE_FILE_SEARCH_MATCHES_MAX, type RemoteFileSearchEvent } from '../../protocol/remoteFiles.ts';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { createRemoteFileSystem, FILES_CAPABILITY } from '../src/remote/files.ts';
import { RunManager } from '../src/runs.ts';
import { createApp } from '../src/server.ts';
import { FakeHermes } from '../support/fake_hermes.ts';

const KEY = `rly1_${Buffer.alloc(32, 7).toString('base64url')}`;
const NOW = 1_700_000_000_000;
const OK = { Authorization: `Bearer ${KEY}`, 'X-Relay-Protocol': '2', 'X-Relay-Capability': 'files/1', 'Content-Type': 'application/json' };

async function start(t: TestContext) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-files-http-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const relay = path.join(base, 'relay');
  fs.mkdirSync(path.join(home, '.hermes'), { recursive: true });
  fs.mkdirSync(relay, { mode: 0o700 });
  const store = await createDeviceStore({ directory: relay, now: () => NOW });
  await store.mutate((state) => { state.devices.push({ id: '00000000-0000-4000-8000-000000000001', name: 'phone', pairedAt: NOW, revokedAt: null, keyHash: hashDeviceKey(KEY).toString('hex') }); });
  const hermes = new FakeHermes();
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} }, sleep: async () => {} });
  const logs: string[] = [];
  const server = createApp({
    config: { corsOrigins: [] }, store, pairing: createPairing({ store, origin: async () => 'http://arch.example.ts.net:8650', serverName: 'arch' }),
    peerAddress: () => '100.64.0.1', hermes, runs, tailnet: { whois: async () => null }, hostname: 'arch', version: '9.9.9', now: () => NOW,
    log: (line) => logs.push(line),
    remote: { files: { capability: FILES_CAPABILITY, port: createRemoteFileSystem({ home, hermesHome: path.join(home, '.hermes'), stateDirectory: store.directory, changeLog: store.changeLog, now: () => NOW }) } },
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const port = (server.address() as AddressInfo).port;
  t.after(() => { runs.close(); server.closeAllConnections(); server.close(); });
  async function call(method: string, route: string, body?: unknown, headers: Record<string, string> = OK) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers, ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? Uint8Array.from(body) : JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, text, json: text ? JSON.parse(text) : null };
  }
  const revoke = () => store.mutate((state) => { state.devices[0]!.revokedAt = NOW; });
  return { base, home, relay, port, server, call, logs, revoke };
}

test('file routes take paths only in JSON bodies and log method, route and status without them', async (t) => {
  const { home, call, logs } = await start(t);
  const strange = 'secret $(name)\nwith line';
  const created = await call('POST', '/v1/remote/files/create', { directory: home, name: strange, type: 'directory' });
  assert.equal(created.status, 200);
  const listed = await call('POST', '/v1/remote/files/list', {});
  assert.deepEqual([listed.status, listed.json.path, listed.json.entries.map((entry: { name: string }) => entry.name)], [200, home, [strange]]);
  const folder = listed.json.entries[0];
  const moved = await call('POST', '/v1/remote/files/move', { path: path.join(home, strange), version: folder.version, directory: home, name: `${strange}2` });
  assert.equal(moved.status, 200);
  const unconfirmed = await call('POST', '/v1/remote/files/delete', { path: path.join(home, `${strange}2`), version: moved.json.version });
  assert.deepEqual([unconfirmed.status, unconfirmed.json.error.code], [428, 'remote_confirmation_required']);
  const missing = await call('POST', '/v1/remote/files/list', { path: path.join(home, 'nothing', strange) });
  // A fixed text: nothing of the path comes back.
  assert.deepEqual([missing.status, missing.json.error], [404, { code: 'remote_not_found', message: 'No existe en este Servidor.' }]);
  assert.doesNotMatch(missing.text, /secret|home/);
  const deleted = await call('POST', '/v1/remote/files/delete', { path: path.join(home, `${strange}2`), version: moved.json.version, confirm: true });
  assert.deepEqual([deleted.status, deleted.json], [200, { ok: true }]);
  assert.deepEqual(fs.readdirSync(home), ['.hermes']);

  // No path in the URL or the query, no GET with a body.
  const query = await call('POST', `/v1/remote/files/list?path=${encodeURIComponent(home)}`, {});
  assert.deepEqual([query.status, query.json.error.code], [400, 'remote_invalid_request']);
  for (const [method, route] of [['GET', '/v1/remote/files/list'], ['POST', `/v1/remote/files/list${home}`], ['POST', '/v1/remote/files'], ['POST', '/v1/remote/files/write']]) {
    const response = await call(method!, route!, method === 'GET' ? undefined : {});
    assert.deepEqual([response.status, response.json.error.code], [404, 'not_found'], `${method} ${route}`);
  }
  await setImmediate();
  const lines = logs.map((line) => line.replace(/ \d+ms$/, ''));
  assert.deepEqual(lines, [
    'POST /v1/remote/files/create 200', 'POST /v1/remote/files/list 200', 'POST /v1/remote/files/move 200', 'POST /v1/remote/files/delete 428',
    'POST /v1/remote/files/list 404', 'POST /v1/remote/files/delete 200', 'POST /v1/remote/files/list 400',
    'GET unmatched 404', 'POST unmatched 404', 'POST unmatched 404', 'POST unmatched 404',
  ]);
  assert.doesNotMatch(logs.join('\n'), /secret|relay-files-http/);
});

test('file routes need the files capability', async (t) => {
  const { home, call } = await start(t);
  for (const capability of ['environments/1', 'files/2', 'terminal/1']) {
    const response = await call('POST', '/v1/remote/files/create', { directory: home, name: 'x', type: 'file' }, { ...OK, 'X-Relay-Capability': capability });
    assert.deepEqual([response.status, response.json.error.code], [426, 'remote_upgrade_required'], capability);
  }
  assert.deepEqual(fs.readdirSync(home), ['.hermes']);
});

test('a device revoked while its request is in flight changes nothing on disk', async (t) => {
  const { home, port, call, revoke, server } = await start(t);
  const answer = Promise.withResolvers<{ status: number; body: string }>();
  const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/remote/files/create', headers: OK }, (response) => {
    let body = '';
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => answer.resolve({ status: response.statusCode!, body }));
  });
  const payload = JSON.stringify({ directory: home, name: 'late', type: 'file' });
  // In flight: past the key, the limiter and the protocol and capability checks, the route is reading
  // the rest of the body when the device is revoked.
  const arrived = once(server, 'request');
  request.write(payload.slice(0, 10));
  const [incoming] = await arrived as [http.IncomingMessage];
  while (incoming.listenerCount('data') === 0) await setImmediate();
  await revoke();
  request.end(payload.slice(10));
  const { status, body } = await answer.promise;
  assert.deepEqual([status, JSON.parse(body).error.code], [403, 'device_revoked']);
  assert.equal(fs.existsSync(path.join(home, 'late')), false);
  const after = await call('POST', '/v1/remote/files/create', { directory: home, name: 'late', type: 'file' });
  assert.equal(after.status, 403);
  assert.deepEqual(fs.readdirSync(home), ['.hermes']);
});

test('the editor reads, sends raw chunks and commits over HTTP; the log and changes.jsonl carry no path nor content', async (t) => {
  const { home, relay, call, logs } = await start(t);
  const secret = path.join(home, 'secret notes.txt');
  fs.writeFileSync(secret, 'contenido secreto');
  const read = await call('POST', '/v1/remote/files/read', { path: secret });
  assert.deepEqual([read.status, Buffer.from(read.json.bytes, 'base64').toString()], [200, 'contenido secreto']);
  const draft = Buffer.concat([Buffer.alloc(REMOTE_LIMITS.transferChunkBytes, 0x61), Buffer.from(' borrador secreto')]);
  const started = await call('POST', '/v1/remote/files/saves', { size: draft.length });
  assert.equal(started.status, 200);
  const id: string = started.json.id;
  const raw = { ...OK, 'Content-Type': 'application/octet-stream' };
  // A chunk over transferChunkBytes is refused while it arrives; JSON is not a chunk.
  const big = await call('PUT', `/v1/remote/files/saves/${id}/0`, Buffer.alloc(REMOTE_LIMITS.transferChunkBytes + 1), raw);
  assert.deepEqual([big.status, big.json.error.code], [413, 'remote_too_large']);
  const json = await call('PUT', `/v1/remote/files/saves/${id}/0`, Buffer.from('a'));
  assert.deepEqual([json.status, json.json.error.code], [400, 'remote_invalid_request']);
  for (const [offset, bytes] of [[0, draft.subarray(0, REMOTE_LIMITS.transferChunkBytes)], [REMOTE_LIMITS.transferChunkBytes, draft.subarray(REMOTE_LIMITS.transferChunkBytes)]] as const) {
    const chunk = await call('PUT', `/v1/remote/files/saves/${id}/${offset}`, Buffer.from(bytes), raw);
    assert.equal(chunk.status, 200);
  }
  const committed = await call('POST', `/v1/remote/files/saves/${id}/commit`, { path: secret, version: read.json.version, format: { encoding: 'utf-8', bom: false } });
  assert.deepEqual([committed.status, fs.readFileSync(secret).equals(draft)], [200, true]);
  const stale = await call('POST', `/v1/remote/files/saves/${id}/commit`, { path: secret, version: read.json.version, format: { encoding: 'utf-8', bom: false } });
  assert.deepEqual([stale.status, stale.json.error.code], [410, 'remote_ended']);
  const cancelled = await call('POST', `/v1/remote/operations/${id}/cancel`);
  assert.deepEqual([cancelled.status, cancelled.json], [200, { id, state: 'completed' }]);

  await setImmediate();
  const lines = logs.map((line) => line.replace(/ \d+ms$/, ''));
  assert.deepEqual(lines, [
    'POST /v1/remote/files/read 200', 'POST /v1/remote/files/saves 200',
    'PUT /v1/remote/files/saves/:id/:offset 413', 'PUT /v1/remote/files/saves/:id/:offset 400',
    'PUT /v1/remote/files/saves/:id/:offset 200', 'PUT /v1/remote/files/saves/:id/:offset 200',
    'POST /v1/remote/files/saves/:id/commit 200', 'POST /v1/remote/files/saves/:id/commit 410', 'POST /v1/remote/operations/:id/cancel 200',
  ]);
  const changes = fs.readFileSync(path.join(relay, 'changes.jsonl'), 'utf8');
  assert.deepEqual(changes.trim().split('\n').map((line) => JSON.parse(line).action), ['remote.file.write']);
  assert.doesNotMatch(`${logs.join('\n')}\n${changes}`, /secret|secreto|borrador|op_/);
});

/** An operation's event stream over HTTP: the frames as they arrive, and whether the Puente closed it. */
async function frames(port: number, id: string, lastEventId?: string) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/remote/operations/${id}/events`, { headers: { ...OK, ...(lastEventId === undefined ? {} : { 'Last-Event-ID': lastEventId }) } });
  const received: RemoteFileSearchEvent[] = [];
  let closed = false;
  void (async () => {
    const reader = response.body!.getReader();
    let text = '';
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        text += Buffer.from(chunk.value).toString('utf8');
        for (let end = text.indexOf('\n\n'); end >= 0; end = text.indexOf('\n\n')) {
          const data = text.slice(0, end).split('\n').find((line) => line.startsWith('data: '));
          if (data) received.push(JSON.parse(data.slice(6)) as RemoteFileSearchEvent);
          text = text.slice(end + 2);
        }
      }
    } catch {}
    closed = true;
  })();
  return { status: response.status, received, closed: () => closed };
}

async function until(done: () => boolean, label: string): Promise<void> {
  for (const started = Date.now(); !done();) {
    if (Date.now() - started > 15_000) throw new Error(`timed out: ${label}`);
    await sleep(5);
  }
}

test('uploads, downloads and searches over HTTP: raw chunks, an SSE stream with acks, and logs and changes.jsonl without paths, content or IDs', async (t) => {
  const { home, port, relay, call, logs } = await start(t);
  const raw = { ...OK, 'Content-Type': 'application/octet-stream' };
  const secret = Buffer.concat([Buffer.alloc(REMOTE_LIMITS.transferChunkBytes, 0x73), Buffer.from('contenido secreto')]);
  const upload = await call('POST', '/v1/remote/files/uploads', { directory: home, name: 'secret notes.bin' });
  assert.deepEqual([upload.status, upload.json.size, upload.json.received], [200, null, 0]);
  for (const offset of [0, REMOTE_LIMITS.transferChunkBytes]) {
    const chunk = await call('PUT', `/v1/remote/files/uploads/${upload.json.id}/${offset}`, secret.subarray(offset, offset + REMOTE_LIMITS.transferChunkBytes), raw);
    assert.equal(chunk.status, 200);
  }
  const committed = await call('POST', `/v1/remote/files/uploads/${upload.json.id}/commit`, {});
  assert.deepEqual([committed.status, committed.json.name, fs.readFileSync(path.join(home, 'secret notes.bin')).equals(secret)], [200, 'secret notes.bin', true]);

  const download = await call('POST', '/v1/remote/files/downloads', { path: path.join(home, 'secret notes.bin') });
  assert.deepEqual([download.status, download.json.size], [200, secret.length]);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < secret.length; offset += REMOTE_LIMITS.transferChunkBytes) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/remote/files/downloads/${download.json.id}/${offset}`, { headers: OK });
    assert.deepEqual([response.status, response.headers.get('content-type')], [200, 'application/octet-stream']);
    chunks.push(Buffer.from(await response.arrayBuffer()));
  }
  assert.ok(Buffer.concat(chunks).equals(secret));

  const search = await call('POST', '/v1/remote/files/search', { path: home, query: 'contenido secreto', content: true });
  assert.deepEqual([search.status, search.json.state], [200, 'running']);
  const stream = await frames(port, search.json.id);
  await until(() => stream.received.some((event) => event.type === 'end'), 'search end');
  assert.deepEqual(stream.received.flatMap((event) => event.type === 'results' ? event.matches.map((match) => match.path) : []), [path.join(home, 'secret notes.bin')]);
  const last = stream.received.at(-1)!;
  assert.equal((await call('POST', `/v1/remote/operations/${search.json.id}/ack`, { seq: last.seq })).status, 200);
  await until(stream.closed, 'stream closed after its end');

  await setImmediate();
  const lines = logs.map((line) => line.replace(/ \d+ms$/, ''));
  assert.deepEqual(lines, [
    'POST /v1/remote/files/uploads 200', 'PUT /v1/remote/files/uploads/:id/:offset 200', 'PUT /v1/remote/files/uploads/:id/:offset 200',
    'POST /v1/remote/files/uploads/:id/commit 200', 'POST /v1/remote/files/downloads 200',
    'GET /v1/remote/files/downloads/:id/:offset 200', 'GET /v1/remote/files/downloads/:id/:offset 200',
    'POST /v1/remote/files/search 200', 'GET /v1/remote/operations/:id/events 200', 'POST /v1/remote/operations/:id/ack 200',
  ].filter((line) => lines.includes(line)).length === 10 ? lines : []);
  assert.equal(lines.length, 10);
  const changes = fs.readFileSync(path.join(relay, 'changes.jsonl'), 'utf8');
  assert.deepEqual(changes.trim().split('\n').map((line) => JSON.parse(line).action), ['remote.file.create']);
  assert.doesNotMatch(`${logs.join('\n')}\n${changes}`, /secret|secreto|contenido|op_|relay-files-http/);
});

test('revoking a device ends its open search stream and transfers, and removes its temporary file', async (t) => {
  const { home, port, call, revoke } = await start(t);
  const raw = { ...OK, 'Content-Type': 'application/octet-stream' };
  const many = path.join(home, 'many');
  fs.mkdirSync(many);
  for (let index = 0; index <= REMOTE_FILE_SEARCH_MATCHES_MAX; index++) fs.writeFileSync(path.join(many, `match-${index}`), '');
  const upload = await call('POST', '/v1/remote/files/uploads', { directory: home, name: 'partial.bin' });
  assert.equal((await call('PUT', `/v1/remote/files/uploads/${upload.json.id}/0`, Buffer.from('mitad'), raw)).status, 200);
  const download = await call('POST', '/v1/remote/files/downloads', { path: path.join(many, 'match-1') });
  const search = await call('POST', '/v1/remote/files/search', { path: many, query: 'match' });
  const stream = await frames(port, search.json.id);
  // Paused at its window: the stream stays open, waiting for acks.
  await until(() => stream.received.length > 3, 'first frames');
  assert.equal(fs.readdirSync(home).filter((name) => name.startsWith('.relay-upload-')).length, 1);

  await revoke();
  await until(stream.closed, 'the stream of a revoked device is closed');
  assert.equal(stream.received.some((event) => event.type === 'end'), false);
  assert.deepEqual(fs.readdirSync(home).filter((name) => name !== '.hermes' && name !== 'many'), []);
  for (const [method, route] of [['PUT', `/v1/remote/files/uploads/${upload.json.id}/5`], ['GET', `/v1/remote/files/downloads/${download.json.id}/0`], ['GET', `/v1/remote/operations/${search.json.id}/events`]] as const) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: method === 'PUT' ? raw : OK, ...(method === 'PUT' ? { body: 'x' } : {}) });
    assert.equal(response.status, 403, `${method} ${route}`);
  }
});
