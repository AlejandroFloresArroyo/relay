import assert from 'node:assert/strict';
import test from 'node:test';
import { freeName, uploadPhoneFile } from './browserFiles.ts';
import type { RemoteClient } from './remoteClient.ts';

const VERSION = { dev: '1', ino: '2', mtimeNs: '3', ctimeNs: '4' };
const entry = (name: string) => ({ name, nameUtf8: true, type: 'file', size: 3, mode: 0o644, uid: 1, gid: 1, mtime: 1, version: VERSION });
const OP = 'op_' + 'u'.repeat(22);

function client(entries: string[]) {
  const calls: unknown[][] = [];
  let uploaded = '';
  const make = (): RemoteClient => ({
    async request(method, path, body) {
      calls.push([method, path, body]);
      if (path === '/v1/remote/files/list') return { path: '/home/ana', realPath: '/home/ana', entries: entries.map(entry), truncated: false };
      if (path === '/v1/remote/files/uploads') {
        uploaded = typeof body === 'object' && body !== null && 'name' in body ? String(body.name) : '';
        return { id: OP, size: 3, received: 0 };
      }
      if (path.endsWith('/commit')) return entry(uploaded);
      throw new Error(`unexpected ${path}`);
    },
    async stream() {},
    async chunk(method, path, bytes) { calls.push([method, path, bytes?.length]); return { id: OP, size: 3, received: 3 }; },
  });
  return { calls, make };
}
const source = (name: string) => ({ name, size: 3, read: async (offset: number) => new Uint8Array([1, 2, 3]).slice(offset) });

test('a phone file goes into the home folder under a name nothing there has, like the browser\'s own downloads', async () => {
  assert.equal(freeName('informe.pdf', new Set(['otro.txt'])), 'informe.pdf');
  assert.equal(freeName('informe.pdf', new Set(['informe.pdf', 'informe (2).pdf'])), 'informe (3).pdf');
  assert.equal(freeName('LEEME', new Set(['LEEME'])), 'LEEME (2)');
  assert.equal(freeName('.env', new Set(['.env'])), '.env (2)');

  const { calls, make } = client(['informe.pdf']);
  const outcome = await uploadPhoneFile(make, source('informe.pdf'), { signal: new AbortController().signal });
  assert.deepEqual(outcome, { state: 'completed', value: '/home/ana/informe (2).pdf' });
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [
    ['POST', '/v1/remote/files/list'], ['POST', '/v1/remote/files/uploads'], ['PUT', `/v1/remote/files/uploads/${OP}/0`], ['POST', `/v1/remote/files/uploads/${OP}/commit`],
  ]);
  // Never a replace: the name was free.
  assert.deepEqual(calls.at(-1)![2], {});
  assert.deepEqual(calls[1]![2], { directory: '/home/ana', name: 'informe (2).pdf', size: 3 });
});

test('a home folder the Puente does not describe, or an upload that did not complete, gives no path', async () => {
  const broken: RemoteClient = { request: async () => ({ path: 'relative', entries: [] }), stream: async () => {}, chunk: async () => ({}) };
  assert.equal((await uploadPhoneFile(() => broken, source('a.txt'), { signal: new AbortController().signal })).state, 'failed');
  const controller = new AbortController();
  controller.abort();
  const { make } = client([]);
  assert.equal((await uploadPhoneFile(make, source('a.txt'), { signal: controller.signal })).state, 'cancelled');
});
