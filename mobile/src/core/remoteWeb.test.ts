import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RemoteToolState } from './remoteCapabilities.ts';
import { createRemoteClient, RemoteFailure } from './remoteClient.ts';
import { cancelWebAccess, grantWebAccess, listWebAccess, webApi, webNavigation, webPathInput, webPathOf } from './remoteWeb.ts';

const WEB: RemoteToolState = { state: 'available', capability: { name: 'web', version: 1 } };
const APP = `app_${'a'.repeat(22)}`;
const ACC = `acc_${'b'.repeat(22)}`;
const REQUEST = { id: ACC, code: 'ABCD-EFGH', createdAt: 1_000, expiresAt: 301_000 };
const GRANTED = { id: ACC, code: 'ABCD-EFGH', grantedAt: 2_000, expiresAt: 3_602_000, redeemed: false };

function client(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond(url, init); }) as unknown as typeof globalThis.fetch;
  return { calls, client: createRemoteClient({ baseUrl: 'http://arch.example.ts.net:8650', key: 'rly1_key', fetch }, WEB, () => WEB) };
}
const failure = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { if (error instanceof RemoteFailure) return error; throw error; }
  assert.fail('expected a RemoteFailure');
};

test('listing, granting with the compared code and cancelling go to the web capability routes', async () => {
  const answers = [
    { serverNow: 5_000, requests: [REQUEST], authorizations: [] },
    GRANTED,
    { ok: true },
  ];
  const { calls, client: web } = client(() => Response.json(answers.shift()));
  assert.deepEqual(await listWebAccess(web, APP), { serverNow: 5_000, requests: [REQUEST], authorizations: [] });
  assert.deepEqual(await grantWebAccess(web, APP, REQUEST), GRANTED);
  await cancelWebAccess(web, APP, ACC);
  assert.deepEqual(calls.map(({ url, init }) => [init.method, url.replace('http://arch.example.ts.net:8650', ''), init.body]), [
    ['GET', `/v1/remote/web/apps/${APP}/authorizations`, undefined],
    ['POST', `/v1/remote/web/apps/${APP}/authorizations`, JSON.stringify({ request: ACC, code: 'ABCD-EFGH' })],
    ['POST', `/v1/remote/web/apps/${APP}/authorizations/${ACC}/cancel`, undefined],
  ]);
  assert.ok(calls.every(({ init }) => (init.headers as Record<string, string>)['X-Relay-Capability'] === 'web/1'));
});

test('an answer the app cannot read is never taken as an authorization', async () => {
  const unreadable = [
    { ...GRANTED, redeemed: 'no' }, { ...GRANTED, code: 'abcd-efgh' }, { ...GRANTED, id: `app_${'b'.repeat(22)}` },
    { ...GRANTED, expiresAt: 1.5 }, { ...GRANTED, id: `acc_${'c'.repeat(22)}` }, { ...GRANTED, code: 'ABCD-EFGJ' }, [GRANTED], null,
  ];
  for (const answer of unreadable) {
    const { client: web } = client(() => Response.json(answer));
    assert.equal((await failure(grantWebAccess(web, APP, REQUEST))).kind, 'unexpected', JSON.stringify(answer));
  }
  for (const answer of [
    { requests: [REQUEST], authorizations: [] }, { serverNow: 5_000, requests: [{ ...REQUEST, code: 'ABCD' }], authorizations: [] },
    { serverNow: 5_000, requests: [{ ...REQUEST, id: `app_${'b'.repeat(22)}` }], authorizations: [] },
    { serverNow: 5_000, requests: [REQUEST], authorizations: [{ ...GRANTED, grantedAt: -1 }] }, { serverNow: 5_000, requests: {}, authorizations: [] },
  ]) {
    const { client: web } = client(() => Response.json(answer));
    assert.equal((await failure(listWebAccess(web, APP))).kind, 'unexpected', JSON.stringify(answer));
  }
  const { client: web } = client(() => Response.json({ ok: false }));
  assert.equal((await failure(cancelWebAccess(web, APP, ACC))).kind, 'unexpected');
});

test('a request that no longer exists is a remote_not_found, not a pairing problem', async () => {
  const { client: web } = client(() => Response.json({ error: { code: 'remote_not_found', message: 'x' } }, { status: 404 }));
  const missing = await failure(grantWebAccess(web, APP, REQUEST));
  assert.equal(missing.kind, 'remote');
  assert.equal(missing.code, 'remote_not_found');
});

const ORIGIN = 'https://relay-0123456789abcdef.tail.ts.net';
const APP_RECORD = { id: APP, name: 'Tienda', address: '127.0.0.1', port: 3000, origin: ORIGIN, createdAt: 1_000 };
const CANDIDATE = { address: '127.0.0.1', port: 3000, process: { name: 'node', directory: '/home/ana/tienda' } };
const TICKET = 'T'.repeat(43);

function api(answers: unknown[]) {
  const { calls, client: web } = client(() => Response.json(answers.shift()));
  return { calls, api: webApi(() => web) };
}
const sent = (calls: { url: string; init: RequestInit }[]) => calls.map(({ url, init }) => [init.method, url.replace('http://arch.example.ts.net:8650', ''), init.body && JSON.parse(String(init.body))]);

test('the web tool lists candidates and apps, registers a candidate by its exact address, forgets, opens and closes', async () => {
  const { calls, api: web } = api([
    { candidates: [CANDIDATE] }, { apps: [APP_RECORD] }, APP_RECORD, { ok: true },
    { origin: ORIGIN, entryPath: '/__relay/entrar', ticket: TICKET, expiresAt: 61_000 }, { closed: 1 },
  ]);
  assert.deepEqual(await web.candidates(), [CANDIDATE]);
  assert.deepEqual(await web.apps(), [APP_RECORD]);
  assert.deepEqual(await web.register('req_12345678', 'Tienda', CANDIDATE), APP_RECORD);
  await web.forget(APP);
  // The viewer's entry: a form POST of the single-use ticket to the app's own origin, never a URL query.
  assert.deepEqual(await web.open(APP_RECORD, '/carrito?x=1'), { origin: ORIGIN, uri: `${ORIGIN}/__relay/entrar`, body: `ticket=${TICKET}` });
  await web.close(APP);
  assert.deepEqual(sent(calls), [
    ['GET', '/v1/remote/web/candidates', undefined],
    ['GET', '/v1/remote/web/apps', undefined],
    ['POST', '/v1/remote/web/apps', { requestId: 'req_12345678', name: 'Tienda', address: '127.0.0.1', port: 3000 }],
    ['DELETE', `/v1/remote/web/apps/${APP}`, undefined],
    ['POST', `/v1/remote/web/apps/${APP}/open`, { path: '/carrito?x=1' }],
    ['POST', `/v1/remote/web/apps/${APP}/close`, undefined],
  ]);
});

test('an entry the app cannot read, or for another origin, is never loaded', async () => {
  const good = { origin: ORIGIN, entryPath: '/__relay/entrar', ticket: TICKET, expiresAt: 61_000 };
  for (const answer of [
    { ...good, origin: 'https://otra.tail.ts.net' }, { ...good, origin: `${ORIGIN}/x` }, { ...good, origin: 'http://relay-0123456789abcdef.tail.ts.net' },
    { ...good, entryPath: '/entrar' }, { ...good, ticket: 'corto' }, { ...good, ticket: `${'T'.repeat(42)}&` }, { ...good, expiresAt: -1 }, null,
  ]) {
    const { api: web } = api([answer]);
    assert.equal((await failure(web.open(APP_RECORD, '/'))).kind, 'unexpected', JSON.stringify(answer));
  }
  // Published only now: any https origin of its own is accepted.
  const { api: web } = api([{ ...good, origin: 'https://relay-fedcba9876543210.tail.ts.net' }]);
  assert.equal((await web.open({ ...APP_RECORD, origin: null }, '/')).uri, 'https://relay-fedcba9876543210.tail.ts.net/__relay/entrar');
  for (const answer of [{ apps: [{ ...APP_RECORD, origin: 'ftp://x' }] }, { apps: [{ ...APP_RECORD, id: ACC }] }, { apps: [{ ...APP_RECORD, port: 0 }] }, { candidates: [{ ...CANDIDATE, address: 'localhost' }] }]) {
    const { api: other } = api([answer]);
    assert.equal((await failure('apps' in answer ? other.apps() : other.candidates())).kind, 'unexpected', JSON.stringify(answer));
  }
});

test('navigation: the app stays in the viewer, other webs go to the phone browser, loopback and other schemes are refused', () => {
  assert.equal(webNavigation(`${ORIGIN}/a/b?c=1#d`, ORIGIN), 'inside');
  assert.equal(webNavigation(`${ORIGIN}:443/x`, ORIGIN), 'inside');
  assert.equal(webNavigation('about:blank', ORIGIN), 'inside');
  assert.equal(webNavigation('https://cdn.example.com/lib.js', ORIGIN), 'external');
  // Another app of the same Servidor is another origin: it is not opened here, nor granted.
  assert.equal(webNavigation('https://relay-fedcba9876543210.tail.ts.net/', ORIGIN), 'external');
  assert.equal(webNavigation('http://relay-0123456789abcdef.tail.ts.net/', ORIGIN), 'external');
  for (const local of ['http://127.0.0.1:3000/x', 'http://localhost:5173/', 'https://localhost/', 'http://[::1]:8080/', 'http://0.0.0.0:3000/', 'http://127.1.2.3/']) {
    assert.equal(webNavigation(local, ORIGIN), 'local', local);
  }
  for (const refused of ['intent://scan#Intent;scheme=zxing;end', 'tel:5555', 'file:///android_asset/www.bundle/x.html', 'javascript:alert(1)', 'data:text/html,hola', 'content://x', 'ws://127.0.0.1:3000/hmr', 'no es url']) {
    assert.equal(webNavigation(refused, ORIGIN), 'refused', refused);
  }
});

test('the path kept to come back is the app’s own; what the person types is a path inside it or nothing', () => {
  assert.equal(webPathOf(`${ORIGIN}/carrito/2?x=1#arriba`, ORIGIN), '/carrito/2?x=1#arriba');
  assert.equal(webPathOf('https://otra.tail.ts.net/x', ORIGIN), null);
  assert.equal(webPathOf(`${ORIGIN}/__relay/entrar`, ORIGIN), null);
  assert.equal(webPathOf(`${ORIGIN}/${'a'.repeat(2048)}`, ORIGIN), null);
  assert.equal(webPathInput('carrito'), '/carrito');
  assert.equal(webPathInput(' /pedidos/ñandú?q=a b '), '/pedidos/%C3%B1and%C3%BA?q=a%20b');
  assert.equal(webPathInput('/ya%20codificado'), '/ya%20codificado');
  for (const outside of ['//otro.example/x', 'https://otro.example/', '/__relay/entrar', '/\\otro', '/__RELAY/../__relay/x', '']) {
    assert.equal(webPathInput(outside), null, outside);
  }
});
