import assert from 'node:assert/strict';
import test from 'node:test';
import { REMOTE_LIMITS } from '../../../protocol/protocol.ts';
import type { RemoteClient } from './remoteClient.ts';
import { RemoteFailure } from './remoteClient.ts';
import { downloadFile, searchFiles, uploadFile } from './remoteTransfers.ts';

const CHUNK = REMOTE_LIMITS.transferChunkBytes;
const OP = 'op_AAAAAAAAAAAAAAAAAAAAAA';
const ENTRY = { name: 'big.bin', type: 'file', size: 5, version: { dev: '1', ino: '2', mtimeNs: '3', ctimeNs: '4' } };
const lost = () => new RemoteFailure('no_response');

type Call = { method: string; path: string; body?: unknown };

/** A Puente behind the transport: `answer` decides each request; streams replay `streams` in turn. */
function puente(answer: (call: Call) => unknown, streams: ((onData: (data: string) => void, lastEventId: number) => Promise<void>)[] = []) {
  const calls: Call[] = [];
  const client = (): RemoteClient => ({
    async request(method, path, body) { const call = { method, path, body }; calls.push(call); return answer(call); },
    async chunk(method, path, body) { const call = { method, path, body }; calls.push(call); return answer(call); },
    async stream(path, lastEventId, onData) { calls.push({ method: 'STREAM', path, body: lastEventId }); return streams.shift()!(onData, lastEventId); },
  });
  return { calls, client };
}

const paths = (calls: Call[]) => calls.map((call) => `${call.method} ${call.path.replace(OP, ':id')}`);

test('an upload of unknown size goes chunk by chunk and is completed only by its commit', async () => {
  const bytes = new Uint8Array(2 * CHUNK + 5).map((_, index) => index & 0xff);
  const { calls, client } = puente((call) => call.path.endsWith('/commit') ? ENTRY : { id: OP, size: null, received: 0 });
  const progress: number[] = [];
  const reads: number[] = [];
  const outcome = await uploadFile(client, { directory: '/home/ana', name: 'big.bin' }, { read: async (offset, length) => { reads.push(offset); return bytes.subarray(offset, offset + length); } },
    { signal: new AbortController().signal, onProgress: ({ done, total }) => { assert.equal(total, null); progress.push(done); } });
  assert.deepEqual(outcome, { state: 'completed', value: ENTRY });
  assert.deepEqual(paths(calls), ['POST /v1/remote/files/uploads', 'PUT /v1/remote/files/uploads/:id/0', `PUT /v1/remote/files/uploads/:id/${CHUNK}`, `PUT /v1/remote/files/uploads/:id/${2 * CHUNK}`, 'POST /v1/remote/files/uploads/:id/commit']);
  assert.deepEqual([reads, progress], [[0, CHUNK, 2 * CHUNK], [CHUNK, 2 * CHUNK, 2 * CHUNK + 5]]);
  assert.deepEqual(calls[0]!.body, { directory: '/home/ana', name: 'big.bin' });
  assert.deepEqual(calls.at(-1)!.body, {});
});

test('an interrupted upload is cancelled on the Servidor and fails, never completes nor resumes', async () => {
  const { calls, client } = puente((call) => {
    if (call.path.endsWith(`/${CHUNK}`)) throw lost();
    if (call.path.endsWith('/cancel')) return { id: OP, state: 'cancelled' };
    return { id: OP, size: 2 * CHUNK, received: 0 };
  });
  const outcome = await uploadFile(client, { directory: '/d', name: 'f', replace: ENTRY.version }, { size: 2 * CHUNK, read: async (_, length) => new Uint8Array(length) },
    { signal: new AbortController().signal });
  assert.equal(outcome.state, 'failed');
  assert.deepEqual(paths(calls), ['POST /v1/remote/files/uploads', 'PUT /v1/remote/files/uploads/:id/0', `PUT /v1/remote/files/uploads/:id/${CHUNK}`, 'POST /v1/remote/operations/:id/cancel']);
  assert.deepEqual(calls[0]!.body, { directory: '/d', name: 'f', size: 2 * CHUNK });
});

test('a commit whose answer is lost reports what the Servidor says happened', async () => {
  for (const [state, expected] of [['completed', 'completed'], ['cancelled', 'failed']] as const) {
    const { client } = puente((call) => {
      if (call.path.endsWith('/commit')) throw lost();
      if (call.path.endsWith('/cancel')) return { id: OP, state };
      return { id: OP, size: 1, received: 0 };
    });
    const outcome = await uploadFile(client, { directory: '/d', name: 'f' }, { size: 1, read: async () => new Uint8Array(1) }, { signal: new AbortController().signal });
    assert.deepEqual(outcome.state === 'completed' ? outcome : outcome.state, expected === 'completed' ? { state: 'completed', value: null } : 'failed', state);
  }
});

test('cancelling an upload stops sending and cancels it on the Servidor', async () => {
  const controller = new AbortController();
  const { calls, client } = puente((call) => call.path.endsWith('/cancel') ? { id: OP, state: 'cancelled' } : { id: OP, size: null, received: 0 });
  const outcome = await uploadFile(client, { directory: '/d', name: 'f' }, { read: async (_, length) => { controller.abort(); return new Uint8Array(length); } }, { signal: controller.signal });
  assert.deepEqual(outcome, { state: 'cancelled' });
  assert.deepEqual(paths(calls), ['POST /v1/remote/files/uploads', 'POST /v1/remote/operations/:id/cancel']);
});

test('a download completes only once every byte reached the sink; a short chunk is a failure', async () => {
  const size = CHUNK + 3;
  for (const short of [false, true]) {
    const { calls, client } = puente((call) => {
      if (call.method === 'GET') return new Uint8Array(call.path.endsWith('/0') ? CHUNK : short ? 2 : 3);
      if (call.path.endsWith('/cancel')) return { id: OP, state: 'cancelled' };
      return { id: OP, path: '/f', realPath: '/f', size, version: ENTRY.version };
    });
    const written: number[] = [];
    const outcome = await downloadFile(client, '/f', async (bytes, offset) => { written.push(offset, bytes.length); }, { signal: new AbortController().signal });
    if (short) {
      assert.equal(outcome.state, 'failed');
      assert.deepEqual(written, [0, CHUNK]);
      assert.equal(paths(calls).at(-1), 'POST /v1/remote/operations/:id/cancel');
    } else {
      assert.equal(outcome.state, 'completed');
      assert.deepEqual(written, [0, CHUNK, CHUNK, 3]);
      assert.deepEqual(paths(calls), ['POST /v1/remote/files/downloads', 'GET /v1/remote/files/downloads/:id/0', `GET /v1/remote/files/downloads/:id/${CHUNK}`]);
    }
  }
});

const frame = (event: Record<string, unknown>) => JSON.stringify({ folders: 1, files: 2, unreadable: 0, ...event });

test('a search delivers and acks each frame, and reconnects from the last one it holds', async () => {
  const match = { path: '/home/ana/a.txt', entry: ENTRY };
  const { calls, client } = puente((call) => call.path.endsWith('/search') ? { id: OP, state: 'running' } : { ok: true }, [
    async (onData) => { onData(frame({ type: 'results', seq: 1, matches: [match] })); onData(frame({ type: 'results', seq: 2, matches: [] })); throw lost(); },
    async (onData, lastEventId) => { assert.equal(lastEventId, 2); onData(frame({ type: 'results', seq: 3, matches: [match] })); onData(frame({ type: 'end', seq: 4, state: 'completed', truncated: true })); },
  ]);
  const found: string[] = [];
  const waits: number[] = [];
  const outcome = await searchFiles(client, { path: '/home/ana', query: 'a' }, {
    signal: new AbortController().signal, onResults: (matches) => found.push(...matches.map((item) => item.path)), wait: async (ms) => { waits.push(ms); },
  });
  assert.deepEqual(outcome, { state: 'completed', value: { folders: 1, files: 2, unreadable: 0, truncated: true } });
  assert.deepEqual(found, [match.path, match.path]);
  // Frames arrived before the loss, so it reconnects at once.
  assert.deepEqual(waits, []);
  assert.deepEqual(calls.filter((call) => call.path.endsWith('/ack')).map((call) => call.body), [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }]);
  assert.deepEqual(calls.filter((call) => call.method === 'STREAM').map((call) => call.body), [0, 2]);
});

test('a search that cannot reconnect, or skips a frame, fails and is cancelled on the Servidor', async () => {
  const gone = puente((call) => call.path.endsWith('/search') ? { id: OP, state: 'running' } : { id: OP, state: 'cancelled' },
    Array.from({ length: 6 }, () => async () => { throw lost(); }));
  const waits: number[] = [];
  const failed = await searchFiles(gone.client, { path: '/d', query: 'a' }, { signal: new AbortController().signal, onResults: () => {}, wait: async (ms) => { waits.push(ms); } });
  assert.equal(failed.state, 'failed');
  assert.deepEqual(waits, [1000, 2000, 5000, 10_000]);
  assert.equal(paths(gone.calls).at(-1), 'POST /v1/remote/operations/:id/cancel');

  const skipping = puente((call) => call.path.endsWith('/search') ? { id: OP, state: 'running' } : { ok: true },
    [async (onData) => { onData(frame({ type: 'results', seq: 2, matches: [] })); }]);
  let delivered = 0;
  assert.equal((await searchFiles(skipping.client, { path: '/d', query: 'a' }, { signal: new AbortController().signal, onResults: () => { delivered++; } })).state, 'failed');
  assert.equal(delivered, 0, 'a frame after a gap is never delivered');
});

test('a search the Servidor ended as failed is reported failed, never completed', async () => {
  const { client } = puente((call) => call.path.endsWith('/search') ? { id: OP, state: 'running' } : { ok: true },
    [async (onData) => { onData(frame({ type: 'end', seq: 1, state: 'failed', truncated: false })); }]);
  const outcome = await searchFiles(client, { path: '/d', query: 'a' }, { signal: new AbortController().signal, onResults: () => {} });
  assert.equal(outcome.state, 'failed');
});

test('cancelling a search cancels it on the Servidor', async () => {
  const controller = new AbortController();
  const { calls, client } = puente((call) => call.path.endsWith('/search') ? { id: OP, state: 'running' } : { id: OP, state: 'cancelled' },
    [async (onData) => { onData(frame({ type: 'results', seq: 1, matches: [] })); controller.abort(); }]);
  const outcome = await searchFiles(client, { path: '/d', query: 'a' }, { signal: controller.signal, onResults: () => {} });
  assert.deepEqual(outcome, { state: 'cancelled' });
  assert.equal(paths(calls).at(-1), 'POST /v1/remote/operations/:id/cancel');
});
