import assert from 'node:assert/strict';
import test from 'node:test';
import type { RemoteClient } from './remoteClient.ts';
import { browserPort, browsersApi, readBrowser } from './browsers.ts';

const ID = 'env_' + 'a'.repeat(22);
const env = (extra: Record<string, unknown> = {}) => ({ id: ID, kind: 'browser_dedicated', ownership: 'own', createdAt: 5, state: 'running', ...extra });

function clients(answer: (method: string, path: string, body?: unknown) => unknown) {
  const calls: { client: string; method: string; path: string; body?: unknown }[] = [];
  const make = (client: string): (() => RemoteClient) => () => ({
    async request(method, path, body) { calls.push({ client, method, path, body }); return answer(method, path, body); },
    async stream(path) { calls.push({ client, method: 'STREAM', path }); },
    chunk: async () => { throw new Error('no transfers here'); },
  });
  return { calls, api: browsersApi(make('environments')), port: (id: string) => browserPort(make('browser'), id) };
}

test('a browser is listed only with the ownership of its mode: the dedicated one is own, the habitual one shared', async () => {
  const { api } = clients(() => ({ environments: [
    env(), env({ id: 'env_' + 'b'.repeat(22), kind: 'browser_habitual', ownership: 'shared' }),
    // A habitual browser said to be own would be ended by «Terminar»; a dedicated one said shared would be kept on revoke.
    env({ id: 'env_' + 'c'.repeat(22), kind: 'browser_habitual', ownership: 'own' }), env({ id: 'env_' + 'd'.repeat(22), ownership: 'shared' }),
    env({ id: 'env_' + 'e'.repeat(22), kind: 'terminal', terminal: { shell: '/bin/sh', cwd: '/' } }), env({ id: 'env_../x' }), env({ state: 'paused' }), null,
    env({ id: 'env_' + 'f'.repeat(22), state: 'exited', exitCode: 0, endedAt: 9 }),
  ] }));
  assert.deepEqual((await api.list()).map((b) => [b.id.slice(4, 5), b.kind, b.ownership, b.state]), [
    ['a', 'browser_dedicated', 'own', 'running'], ['b', 'browser_habitual', 'shared', 'running'], ['f', 'browser_dedicated', 'own', 'exited'],
  ]);
  assert.equal(readBrowser(env({ kind: 'browser_habitual', ownership: 'own' })), null);
});

test('opening, ending and discarding a browser go to the environments capability, with a confirmed end', async () => {
  const { api, calls } = clients((method, path) => method === 'DELETE' ? { ok: true } : env(path.endsWith('/terminate') ? { state: 'exited', endedAt: 9 } : {}));
  assert.equal((await api.create('req-12345678', 'browser_dedicated')).id, ID);
  assert.equal((await api.terminate(ID)).state, 'exited');
  await api.discard(ID);
  assert.deepEqual(calls.map((c) => [c.client, c.method, c.path, c.body]), [
    ['environments', 'POST', '/v1/remote/environments', { requestId: 'req-12345678', kind: 'browser_dedicated' }],
    ['environments', 'POST', `/v1/remote/environments/${ID}/terminate`, { confirm: true }],
    ['environments', 'DELETE', `/v1/remote/environments/${ID}`, undefined],
  ]);
  await assert.rejects(api.terminate('env_../../x'));
  assert.equal(calls.length, 3);
  // An answer of another kind is not the browser asked for.
  const other = clients(() => env({ kind: 'browser_habitual', ownership: 'shared' }));
  await assert.rejects(other.api.create('req-12345678', 'browser_dedicated'), { kind: 'unexpected' });
});

test('the page requests go to the browser capability, with URLs and text only in bodies and tab IDs checked before any path', async () => {
  const { port, calls } = clients(() => ({ ok: true }));
  await port(ID).frames(() => {}, new AbortController().signal);
  await port(ID).view('c'.repeat(22), { tab: 'T1', width: 400, height: 700, scale: 2, quality: 60 });
  await port(ID).ack('c'.repeat(22), 3);
  await port(ID).tabs();
  await port(ID).open('https://example.com/a?b');
  await port(ID).open(null);
  await port(ID).close('T1');
  await port(ID).act('41', { type: 'text', text: 'canción' });
  assert.deepEqual(calls.map((c) => [c.client, c.method, c.path, c.body]), [
    ['browser', 'STREAM', `/v1/remote/browsers/${ID}/frames`, undefined],
    ['browser', 'POST', `/v1/remote/browsers/${ID}/view`, { channel: 'c'.repeat(22), tab: 'T1', width: 400, height: 700, scale: 2, quality: 60 }],
    ['browser', 'POST', `/v1/remote/browsers/${ID}/ack`, { channel: 'c'.repeat(22), seq: 3 }],
    ['browser', 'GET', `/v1/remote/browsers/${ID}/tabs`, undefined],
    ['browser', 'POST', `/v1/remote/browsers/${ID}/tabs`, { url: 'https://example.com/a?b' }],
    ['browser', 'POST', `/v1/remote/browsers/${ID}/tabs`, {}],
    ['browser', 'DELETE', `/v1/remote/browsers/${ID}/tabs/T1`, undefined],
    ['browser', 'POST', `/v1/remote/browsers/${ID}/tabs/41/action`, { type: 'text', text: 'canción' }],
  ]);
  await assert.rejects(port(ID).act('../x', { type: 'reload' }));
  await assert.rejects(port(ID).close('a/b'));
  assert.throws(() => browserPort(() => { throw new Error('unused'); }, 'env_../x'));
  assert.equal(calls.length, 8);
});
