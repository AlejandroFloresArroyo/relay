import assert from 'node:assert/strict';
import test from 'node:test';
import type { RemoteClient } from './remoteClient.ts';
import { folderLabel, readTerminal, shellName, terminalsApi } from './terminals.ts';

const ID = 'env_' + 'a'.repeat(22);
const env = (extra: Record<string, unknown> = {}) => ({
  id: ID, kind: 'terminal', ownership: 'own', createdAt: 5, state: 'running', terminal: { shell: '/usr/bin/zsh', cwd: '/home/ana/relay' }, ...extra,
});

function clients(answer: (method: string, path: string, body?: unknown) => unknown) {
  const calls: { client: string; method: string; path: string; body?: unknown }[] = [];
  const make = (client: string): (() => RemoteClient) => () => ({
    async request(method, path, body) { calls.push({ client, method, path, body }); return answer(method, path, body); },
    stream: async () => {}, chunk: async () => { throw new Error('no transfers here'); },
  });
  return { calls, api: terminalsApi(make('environments'), make('terminal')) };
}

test('only well-formed terminal environments reach the app; anything else is left out', async () => {
  const { api, calls } = clients(() => ({ environments: [
    env(), env({ id: 'env_../../whoami' }), env({ kind: 'browser_dedicated' }), env({ state: 'paused' }),
    env({ terminal: { shell: 'zsh', cwd: '/' } }), env({ terminal: { shell: '/bin/sh', cwd: '/a\0b' } }), env({ ownership: 'theirs' }), 'x',
    env({ id: 'env_' + 'b'.repeat(22), state: 'exited', exitCode: 2, endedAt: 9 }),
  ] }));
  const list = await api.list();
  assert.deepEqual(list.map((t) => [t.id, t.state, t.exitCode]), [[ID, 'running', null], ['env_' + 'b'.repeat(22), 'exited', 2]]);
  assert.deepEqual(calls, [{ client: 'environments', method: 'GET', path: '/v1/remote/environments', body: undefined }]);
});

test('create, terminate and discard go to the environments capability; shells to the terminal one', async () => {
  const { api, calls } = clients((method, path) => path === '/v1/remote/shells'
    ? { shells: ['/bin/bash', '/usr/bin/zsh'], defaultShell: '/usr/bin/zsh', home: '/home/ana' }
    : method === 'DELETE' ? { ok: true } : env(path.endsWith('/terminate') ? { state: 'exited', exitCode: 0 } : {}));
  assert.deepEqual(await api.shells(), { shells: ['/bin/bash', '/usr/bin/zsh'], defaultShell: '/usr/bin/zsh', home: '/home/ana' });
  assert.equal((await api.create('req-12345678', '/usr/bin/zsh', '/home/ana/relay')).id, ID);
  assert.equal((await api.terminate(ID)).state, 'exited');
  await api.discard(ID);
  assert.deepEqual(calls.map((c) => [c.client, c.method, c.path, c.body]), [
    ['terminal', 'GET', '/v1/remote/shells', undefined],
    ['environments', 'POST', '/v1/remote/environments', { requestId: 'req-12345678', kind: 'terminal', shell: '/usr/bin/zsh', cwd: '/home/ana/relay' }],
    ['environments', 'POST', `/v1/remote/environments/${ID}/terminate`, { confirm: true }],
    ['environments', 'DELETE', `/v1/remote/environments/${ID}`, undefined],
  ]);
  // An ID that is not one never becomes part of a path.
  await assert.rejects(api.terminate('env_../../whoami'));
  assert.equal(calls.length, 4);
});

test('a malformed answer is an unexpected answer, never a half-read terminal', async () => {
  const { api } = clients(() => ({ id: ID }));
  await assert.rejects(api.create('req-12345678', '/bin/sh', '/'), { name: 'RemoteFailure', kind: 'unexpected' });
  await assert.rejects(api.shells(), { kind: 'unexpected' });
  assert.equal(readTerminal(null), null);
});

test('names as the person reads them', () => {
  assert.equal(shellName('/usr/bin/zsh'), 'zsh');
  assert.equal(folderLabel('/home/ana', '/home/ana'), '~');
  assert.equal(folderLabel('/home/ana/relay', '/home/ana'), '~/relay');
  assert.equal(folderLabel('/home/anabel', '/home/ana'), '/home/anabel');
  assert.equal(folderLabel('/srv', null), '/srv');
});
