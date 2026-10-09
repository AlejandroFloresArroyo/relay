import assert from 'node:assert/strict';
import test from 'node:test';
import { REMOTE_LIMITS } from '../../../protocol/protocol.ts';
import type { RemoteClient } from './remoteClient.ts';
import { RemoteFailure } from './remoteClient.ts';
import { childPath, filesApi, nameProblem, parentPath, permissions } from './remoteFiles.ts';

const CHUNK = REMOTE_LIMITS.transferChunkBytes;
const OP = 'op_BBBBBBBBBBBBBBBBBBBBBB';
const VERSION = { dev: '1', ino: '2', mtimeNs: '1700000000000000000', ctimeNs: '1700000000000000001' };
const CONTENT = { dev: '1', ino: '2', size: 3, mtimeNs: '1700000000000000000', sha256: 'a'.repeat(64) };
const ENTRY = { name: 'notas.txt', nameUtf8: true, type: 'file', size: 3, mode: 0o644, uid: 1000, gid: 1000, mtime: 1_700_000_000_000, version: VERSION };
const FORMAT = { encoding: 'utf-8', bom: false } as const;

type Call = { method: string; path: string; body?: unknown };
function puente(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const client = (): RemoteClient => ({
    async request(method, path, body) { const call = { method, path, body }; calls.push(call); return answer(call); },
    async chunk(method, path, body) { const call = { method, path, body }; calls.push(call); return answer(call); },
    async stream() { throw new Error('no stream here'); },
  });
  return { calls, api: filesApi(client) };
}
const paths = (calls: Call[]) => calls.map((call) => `${call.method} ${call.path.replace(OP, ':id')}`);
const unexpected = (error: unknown) => error instanceof RemoteFailure && error.kind === 'unexpected';

test('listing asks for the home folder without a path, then for a folder, and says where Relay protects writes', async () => {
  const { calls, api } = puente((call) => ({ path: '/home/ana', realPath: '/home/ana', entries: [ENTRY], truncated: false,
    protection: (call.body as { path?: string }).path ? 'profile' : null }));
  const home = await api.list(null, false);
  assert.deepEqual([home.path, home.protection, home.entries.map((entry) => entry.name)], ['/home/ana', null, ['notas.txt']]);
  assert.equal((await api.list('/home/ana/.hermes', true)).protection, 'profile');
  assert.deepEqual(calls.map((call) => call.body), [{ hidden: false }, { path: '/home/ana/.hermes', hidden: true }]);
});

test('a listing with a malformed entry is refused whole, never shown with entries missing', async () => {
  for (const broken of [{ ...ENTRY, type: 'door' }, { ...ENTRY, version: { ...VERSION, ino: 2 } }, { ...ENTRY, type: 'symlink', link: { target: 7 } }]) {
    const { api } = puente(() => ({ path: '/d', realPath: '/d', entries: [ENTRY, broken], truncated: false, protection: null }));
    await assert.rejects(api.list('/d', false), unexpected);
  }
});

test('reading gives the exact bytes on disk; bytes that do not match the version are refused', async () => {
  const bytes = Buffer.from([0x63, 0x0d, 0x0a]);
  const read = puente(() => ({ path: '/f', realPath: '/real/f', version: CONTENT, bytes: bytes.toString('base64'), protection: 'profile' }));
  const opened = await read.api.read('/f');
  assert.deepEqual([[...opened.bytes], opened.realPath, opened.protection, opened.version], [[0x63, 0x0d, 0x0a], '/real/f', 'profile', CONTENT]);
  const short = puente(() => ({ path: '/f', realPath: '/f', version: CONTENT, bytes: Buffer.from('ab').toString('base64'), protection: null }));
  await assert.rejects(short.api.read('/f'), unexpected);
});

test('saving sends the bytes in chunks and commits them with the version read and the format', async () => {
  const bytes = new Uint8Array(CHUNK + 2).fill(0x61);
  const saved = { path: '/f', realPath: '/f', version: { ...CONTENT, size: bytes.length } };
  const { calls, api } = puente((call) => call.path.endsWith('/commit') ? saved : { id: OP, size: bytes.length, received: 0 });
  assert.deepEqual(await api.save('/f', CONTENT, bytes, FORMAT), saved);
  assert.deepEqual(paths(calls), ['POST /v1/remote/files/saves', 'PUT /v1/remote/files/saves/:id/0', `PUT /v1/remote/files/saves/:id/${CHUNK}`, 'POST /v1/remote/files/saves/:id/commit']);
  assert.deepEqual([calls[0]!.body, (calls[2]!.body as Uint8Array).length, calls[3]!.body], [{ size: CHUNK + 2 }, 2, { path: '/f', version: CONTENT, format: FORMAT }]);
});

test('a refused commit cancels the save on the Servidor and says why; a lost answer reports what happened', async () => {
  const conflict = new RemoteFailure('remote', { code: 'remote_conflict' });
  const refused = puente((call) => {
    if (call.path.endsWith('/commit')) throw conflict;
    return call.path.endsWith('/cancel') ? { id: OP, state: 'cancelled' } : { id: OP, size: 0, received: 0 };
  });
  await assert.rejects(refused.api.save('/f', CONTENT, new Uint8Array(0), FORMAT), (error) => error === conflict);
  // An empty text has no chunk to send.
  assert.deepEqual(paths(refused.calls), ['POST /v1/remote/files/saves', 'POST /v1/remote/files/saves/:id/commit', 'POST /v1/remote/operations/:id/cancel']);

  for (const [state, expected] of [['completed', null], ['cancelled', 'thrown']] as const) {
    const lost = puente((call) => {
      if (call.path.endsWith('/commit')) throw new RemoteFailure('no_response');
      return call.path.endsWith('/cancel') ? { id: OP, state } : { id: OP, size: 1, received: 0 };
    });
    const result = await lost.api.save('/f', CONTENT, new Uint8Array(1), FORMAT).catch(() => 'thrown');
    assert.equal(result, expected, state);
  }
});

test('create, move and delete send exactly what the person chose; delete only ever with its confirmation', async () => {
  const { calls, api } = puente((call) => call.path.endsWith('/delete') ? { ok: true } : ENTRY);
  await api.create('/home/ana', 'nueva', 'directory');
  await api.move('/home/ana/notas.txt', VERSION, '/home/ana/docs', 'notas.txt');
  await api.remove('/home/ana/notas.txt', VERSION);
  assert.deepEqual(calls.map((call) => [call.path, call.body]), [
    ['/v1/remote/files/create', { directory: '/home/ana', name: 'nueva', type: 'directory' }],
    ['/v1/remote/files/move', { path: '/home/ana/notas.txt', version: VERSION, directory: '/home/ana/docs', name: 'notas.txt' }],
    ['/v1/remote/files/delete', { path: '/home/ana/notas.txt', version: VERSION, confirm: true }],
  ]);
});

test('paths join and climb at the root, and names are one valid component', () => {
  assert.deepEqual([childPath('/', 'etc'), childPath('/home/ana', 'a b'), parentPath('/etc'), parentPath('/home/ana/x'), parentPath('/')], ['/etc', '/home/ana/a b', '/', '/home/ana', null]);
  for (const bad of ['', '.', '..', 'a/b', 'a\0b', 'ñ'.repeat(128)]) assert.ok(nameProblem(bad), JSON.stringify(bad));
  for (const good of ['.env', 'notas 2.txt', 'ñ'.repeat(127)]) assert.equal(nameProblem(good), null, good);
});

test('permissions read like ls, special bits included', () => {
  assert.deepEqual([permissions(0o755, 'directory'), permissions(0o644, 'file'), permissions(0o4755, 'file'), permissions(0o1777, 'directory'), permissions(0o777, 'symlink')],
    ['drwxr-xr-x', '-rw-r--r--', '-rwsr-xr-x', 'drwxrwxrwt', 'lrwxrwxrwx']);
});
