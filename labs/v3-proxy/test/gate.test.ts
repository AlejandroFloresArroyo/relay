// HTTP-level contract of the Puente web listener behind the simulated Serve/Services front.
// Clock is injected (milliseconds) so expiry is checked without waiting an hour.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { startLab, type Lab } from '../src/lab.ts';
import { GRANT_MS, PENDING_COOKIE, PENDING_MAX, PENDING_MS, SESSION_COOKIE } from '../src/webGate.ts';
import { control, cookieValue, loopback, setCookies, sse, upgrade, web } from './helpers.ts';

const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-dest': 'document', accept: 'text/html' };
let t = Date.UTC(2026, 9, 5, 12);
const now = () => t;

let lab: Lab;
const bearer = (device: 'movil' | 'tablet') => ({ authorization: `Bearer ${lab.devices[device]}` });
const origin = (app: 'a' | 'b') => lab.origins[app];
const own = (app: 'a' | 'b') => ({ origin: origin(app), 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' });

async function openAccess(app: 'a' | 'b', path = '/', cookie = '') {
  const page = await web(lab, origin(app), path, { headers: { ...NAV, ...(cookie ? { cookie } : {}) } });
  const code = /id="codigo">([^<]+)</.exec(page.body)?.[1];
  return { page, code, pend: cookieValue(page, PENDING_COOKIE) };
}

async function pendingId(app: 'a' | 'b', code: string | undefined, device: 'movil' | 'tablet' = 'movil') {
  const list = await control(lab, 'GET', `/v1/web/apps/app-${app}/requests`, bearer(device));
  assert.equal(list.status, 200);
  const found = (JSON.parse(list.body) as { id: string; code: string }[]).find((r) => r.code === code);
  assert.ok(found, `pending request ${code} listed`);
  return found.id;
}

async function grant(app: 'a' | 'b', id: string, device: 'movil' | 'tablet' = 'movil') {
  return control(lab, 'POST', `/v1/web/apps/app-${app}/requests/${id}/grant`, bearer(device));
}

// Full handoff: browser opens, Relay grants the matching code, browser redeems once.
async function authorize(app: 'a' | 'b', device: 'movil' | 'tablet' = 'movil', path = '/') {
  const { code, pend } = await openAccess(app, path);
  assert.equal((await grant(app, await pendingId(app, code, device), device)).status, 200);
  const done = await web(lab, origin(app), path, { headers: { ...NAV, cookie: `${PENDING_COOKIE}=${pend}` } });
  const session = cookieValue(done, SESSION_COOKIE);
  assert.ok(session, 'session cookie issued on redemption');
  return { done, pend: pend!, session: session!, cookie: `${SESSION_COOKIE}=${session}` };
}

describe('Puente web listener behind Services (servicios-puente)', () => {
  before(async () => { lab = await startLab('servicios-puente', { now }); });
  after(() => lab.close());
  beforeEach(() => { lab.apps.a.hits.length = 0; lab.apps.b.hits.length = 0; });

  test('an unauthorized navigation gets the access page and nothing reaches the app', async () => {
    const { page, code, pend } = await openAccess('a', '/deep/x?y=1');
    assert.equal(page.status, 200);
    assert.match(page.body, /Autorizar en Relay/);
    assert.ok(code && pend);
    assert.equal(page.headers['cache-control'], 'no-store');
    const line = setCookies(page).find((c) => c.startsWith(`${PENDING_COOKIE}=`))!;
    assert.match(line, /; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=300$/);
    assert.doesNotMatch(line, /Domain/i);
    assert.equal(lab.apps.a.hits.length, 0);
  });

  test('unauthorized subresources and upgrades get 401 and create no pending request', async () => {
    const before = JSON.parse((await control(lab, 'GET', '/v1/web/apps/app-a/requests', bearer('movil'))).body).length;
    assert.equal((await web(lab, origin('a'), '/whoami', { headers: own('a') })).status, 401);
    assert.equal((await upgrade(lab, origin('a'), '/hmr', { origin: origin('a') })).status, 401);
    const afterList = JSON.parse((await control(lab, 'GET', '/v1/web/apps/app-a/requests', bearer('movil'))).body);
    assert.equal(afterList.length, before);
    assert.equal(lab.apps.a.hits.length, 0);
  });

  test('redemption is single use, fresh, bound to the browser holding the pending secret', async () => {
    const one = await openAccess('a', '/deep/uno');
    const two = await openAccess('a', '/deep/dos');
    assert.notEqual(one.code, two.code);
    await grant('a', await pendingId('a', one.code));

    // The other browser, the public code, or a planted session do not redeem.
    const other = await web(lab, origin('a'), '/deep/dos', { headers: { ...NAV, cookie: `${PENDING_COOKIE}=${two.pend}` } });
    assert.equal(cookieValue(other, SESSION_COOKIE), undefined);
    assert.match(other.body, new RegExp(two.code!));
    const forged = await web(lab, origin('a'), '/', { headers: { ...NAV, cookie: `${PENDING_COOKIE}=${one.code}` } });
    assert.equal(cookieValue(forged, SESSION_COOKIE), undefined);

    const done = await web(lab, origin('a'), '/deep/uno', {
      headers: { ...NAV, cookie: `${PENDING_COOKIE}=${one.pend}; ${SESSION_COOKIE}=plantada` },
    });
    assert.equal(done.status, 303);
    assert.equal(done.headers.location, '/deep/uno');
    const session = cookieValue(done, SESSION_COOKIE)!;
    assert.ok(session && session !== 'plantada' && session !== one.pend);
    assert.ok(setCookies(done).some((c) => c.startsWith(`${PENDING_COOKIE}=;`) && /Max-Age=0/.test(c)));
    const line = setCookies(done).find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    assert.match(line, /; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600$/);

    const replay = await web(lab, origin('a'), '/deep/uno', { headers: { ...NAV, cookie: `${PENDING_COOKIE}=${one.pend}` } });
    assert.equal(cookieValue(replay, SESSION_COOKIE), undefined, 'a used pending secret does not redeem twice');
    assert.equal((await web(lab, origin('a'), '/whoami', { headers: { ...own('a'), cookie: `${SESSION_COOKIE}=plantada` } })).status, 401);
    assert.equal((await web(lab, origin('a'), '/whoami', { headers: { ...own('a'), cookie: `${SESSION_COOKIE}=${session}` } })).status, 200);
  });

  test('a grant from a device that does not hold the key is refused and the page keeps waiting', async () => {
    const one = await openAccess('a');
    const id = await pendingId('a', one.code);
    assert.equal((await control(lab, 'POST', `/v1/web/apps/app-a/requests/${id}/grant`)).status, 401);
    assert.equal((await control(lab, 'POST', `/v1/web/apps/app-a/requests/${id}/grant`, { cookie: `${PENDING_COOKIE}=${one.pend}` })).status, 401);
    const still = await web(lab, origin('a'), '/', { headers: { ...NAV, cookie: `${PENDING_COOKIE}=${one.pend}` } });
    assert.equal(cookieValue(still, SESSION_COOKIE), undefined);
  });

  test('the web session never reaches the control API nor is forwarded to the app', async () => {
    const { session, cookie } = await authorize('a');
    for (const headers of [{ cookie }, { authorization: `Bearer ${session}` }]) {
      assert.equal((await control(lab, 'GET', '/v1/web/apps/app-a/requests', headers)).status, 401);
    }
    const who = await web(lab, origin('a'), '/whoami', { headers: { ...own('a'), cookie: `${cookie}; tema=claro; __HOST-RELAYPEND=mayus` } });
    const seen = JSON.parse(who.body);
    assert.deepEqual(seen.cookies, { tema: 'claro' });
    assert.equal(seen.host, new URL(origin('a')).host);
    assert.equal(seen.proto, 'https');
    assert.equal((await upgrade(lab, origin('a'), '/hmr', { cookie: `${cookie}; tema=claro`, origin: origin('a') })).status, 101);
    assert.ok(lab.apps.a.hits.some((h) => h.method === 'UPGRADE'));
    for (const hit of lab.apps.a.hits) {
      assert.doesNotMatch(hit.cookie, /RelayWeb|RelayPend/i);
      assert.equal(hit.identity, '', 'tailnet identity headers are not forwarded');
    }
    // /v1/... on the app name is the app's own path, never the control API.
    const v1 = await web(lab, origin('a'), '/v1/web/apps/app-a/requests', { headers: { ...own('a'), cookie } });
    assert.equal(v1.status, 404);
    assert.match(v1.body, /no existe en app-a/);
  });

  test('a session is scoped to its app and to its Service name', async () => {
    const { cookie } = await authorize('a');
    assert.equal((await web(lab, origin('b'), '/whoami', { headers: { ...own('b'), cookie } })).status, 401);
    // A Service mapped to the wrong listener, or a request that did not come through HTTPS
    // Serve, is misdirected and never served, even with a valid session for that listener.
    const listener = lab.gates!.a.port;
    const hostA = new URL(origin('a')).host;
    const hostB = new URL(origin('b')).host;
    const plain = { ...own('a'), cookie };
    assert.equal((await loopback(listener, '/whoami', { ...plain, host: hostA, 'x-forwarded-proto': 'https' })).status, 200);
    assert.equal((await loopback(listener, '/whoami', { ...plain, host: hostB, 'x-forwarded-proto': 'https' })).status, 421);
    assert.equal((await loopback(listener, '/whoami', { ...plain, host: hostA })).status, 421);
    const ws = { ...plain, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' };
    assert.equal((await loopback(listener, '/hmr', { ...ws, host: hostA, 'x-forwarded-proto': 'https' })).status, 101);
    assert.equal((await loopback(listener, '/hmr', { ...ws, host: hostB, 'x-forwarded-proto': 'https' })).status, 421);
    assert.equal((await loopback(listener, '/hmr', { ...ws, host: hostA })).status, 421);
    // Relay's own prefix never reaches the app, with or without a session.
    assert.equal((await web(lab, origin('a'), '/__relay/otra', { headers: { ...own('a'), cookie } })).status, 404);
    assert.equal(lab.apps.b.hits.length, 0);
    assert.equal(lab.apps.a.hits.filter((h) => h.path === '/whoami').length, 1);
    assert.equal(lab.apps.a.hits.filter((h) => h.path === '/hmr').length, 1);
    assert.ok(lab.apps.a.hits.every((h) => !h.path.startsWith('/__relay')));
  });

  test('upstream cookies cannot use reserved names, a blank name nor any Domain', async () => {
    const { cookie } = await authorize('b');
    const reply = await web(lab, origin('b'), '/cookies-padre', { headers: { ...NAV, cookie } });
    const lines = setCookies(reply);
    // Every spelling of Domain is dropped (browsers accept spaces and tabs around `=`).
    assert.deepEqual(lines.map((c) => c.split('=')[0]), ['padre_http', 'padre_espacio', 'padre_tab', 'padre_mayus'], lines.join(' | '));
    assert.ok(lines.every((c) => !/domain/i.test(c)), lines.join(' | '));
    assert.ok(lines.every((c) => c.includes('de-app-b') && / Path=\/;/.test(c)), lines.join(' | '));
  });

  test('absolute redirects to the loopback upstream are rewritten to the public origin', async () => {
    const { cookie } = await authorize('a');
    const headers = { ...NAV, cookie };
    assert.equal((await web(lab, origin('a'), '/redirect/relative', { headers })).headers.location, '/deep/redirigida?via=relativa');
    assert.equal((await web(lab, origin('a'), '/redirect/host', { headers })).headers.location, `${origin('a')}/deep/redirigida?via=host`);
    assert.equal((await web(lab, origin('a'), '/redirect/upstream', { headers })).headers.location, `${origin('a')}/deep/redirigida?via=upstream`);
    assert.equal((await web(lab, origin('a'), '/redirect/protocolo', { headers })).headers.location, `${origin('a')}/deep/redirigida?via=protocolo`);
  });

  test('a malformed Location or request target is answered and the listener stays up', async () => {
    const { cookie } = await authorize('a');
    const bad = await web(lab, origin('a'), '/redirect/invalida', { headers: { ...NAV, cookie } });
    assert.equal(bad.status, 302);
    assert.equal(bad.headers.location, undefined, 'an unparseable Location is dropped, not passed on');
    assert.equal((await web(lab, origin('a'), '//', { headers: { ...NAV, cookie } })).status, 400);
    assert.equal((await upgrade(lab, origin('a'), '//', { cookie, origin: origin('a') })).status, 400);
    assert.equal((await web(lab, origin('a'), '/whoami', { headers: { ...own('a'), cookie } })).status, 200);
  });

  test('the return path after redemption never leaves the app', async () => {
    for (const hostile of ['//evil.test/x', '/\\evil.test/x', '/__relay/acceso']) {
      assert.equal((await authorize('a', 'movil', hostile)).done.headers.location, '/', hostile);
    }
  });

  test('state-changing requests and upgrades need the exact own Origin', async () => {
    const { cookie } = await authorize('a');
    const post = (headers: Record<string, string>) =>
      web(lab, origin('a'), '/formulario', { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: 'nota=x' });
    assert.equal((await post({ origin: origin('a'), 'sec-fetch-site': 'same-origin' })).status, 200);
    assert.equal((await post({})).status, 403);
    assert.equal((await post({ origin: origin('b'), 'sec-fetch-site': 'same-site' })).status, 403);
    assert.equal((await post({ origin: 'null' })).status, 403);
    // Reads from a sibling are refused too: sibling names are same-site, so SameSite does not help.
    assert.equal((await web(lab, origin('a'), '/whoami', { headers: { cookie, origin: origin('b'), 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' } })).status, 403);
    // A top-level link from a sibling is a navigation and is allowed.
    assert.equal((await web(lab, origin('a'), '/deep/x', { headers: { ...NAV, cookie, 'sec-fetch-site': 'same-site' } })).status, 200);
    assert.equal((await upgrade(lab, origin('a'), '/hmr', { cookie, origin: origin('b') })).status, 403);
    assert.equal((await upgrade(lab, origin('a'), '/hmr', { cookie })).status, 403);
    const ok = await upgrade(lab, origin('a'), '/hmr', { cookie, origin: origin('a') });
    assert.equal(ok.status, 101);
    assert.match(ok.first!, /hmr:hello:app-a/);
    assert.equal(lab.apps.a.hits.filter((h) => h.method === 'POST' || h.method === 'UPGRADE').length, 2);
  });

  test('the hour counts from the grant on the Server clock and is not renewed by use', async () => {
    const start = t;
    const { cookie } = await authorize('a');
    t = start + GRANT_MS - 1000;
    assert.equal((await web(lab, origin('a'), '/whoami', { headers: { ...own('a'), cookie } })).status, 200);
    t = start + GRANT_MS;
    assert.equal((await web(lab, origin('a'), '/whoami', { headers: { ...own('a'), cookie } })).status, 401);
    const page = await web(lab, origin('a'), '/', { headers: { ...NAV, cookie } });
    assert.match(page.body, /Autorizar en Relay/);
  });

  test('expiry cuts open SSE and WebSocket streams', async () => {
    const start = t;
    const { cookie } = await authorize('a');
    const stream = await sse(lab, origin('a'), '/events', { ...own('a'), cookie });
    const ws = await upgrade(lab, origin('a'), '/hmr', { cookie, origin: origin('a') });
    assert.equal(stream.status, 200);
    assert.equal(ws.status, 101);
    t = start + GRANT_MS;
    lab.authority!.sweep();
    assert.match(await stream.ended, /cortado/);
    await ws.closed;
  });

  test('revoking from Relay cuts streams, refuses the session and cancels grants not yet redeemed', async () => {
    const { cookie } = await authorize('a');
    const stream = await sse(lab, origin('a'), '/events', { ...own('a'), cookie });
    const ws = await upgrade(lab, origin('a'), '/hmr', { cookie, origin: origin('a') });
    const late = await openAccess('a');
    assert.equal((await grant('a', await pendingId('a', late.code))).status, 200);
    const revoked = await control(lab, 'POST', '/v1/web/apps/app-a/revoke', bearer('tablet'));
    assert.equal(revoked.status, 200);
    assert.deepEqual(JSON.parse(revoked.body), { revoked: 1, cancelled: 1 });
    await stream.ended;
    await ws.closed;
    assert.equal((await web(lab, origin('a'), '/whoami', { headers: { ...own('a'), cookie } })).status, 401);
    const redeem = await web(lab, origin('a'), '/', { headers: { ...NAV, cookie: `${PENDING_COOKIE}=${late.pend}` } });
    assert.equal(cookieValue(redeem, SESSION_COOKIE), undefined, 'a grant cancelled before redemption does not redeem');
  });

  test('revoking the granting device revokes its web sessions and its key', async () => {
    const mine = await authorize('a', 'tablet');
    const other = await authorize('b', 'movil');
    const stream = await sse(lab, origin('a'), '/events', { ...own('a'), cookie: mine.cookie });
    const late = await openAccess('a');
    assert.equal((await grant('a', await pendingId('a', late.code, 'tablet'), 'tablet')).status, 200);
    lab.authority!.revokeDevice('tablet');
    await stream.ended;
    const redeem = await web(lab, origin('a'), '/', { headers: { ...NAV, cookie: `${PENDING_COOKIE}=${late.pend}` } });
    assert.equal(cookieValue(redeem, SESSION_COOKIE), undefined, 'a grant from a revoked device does not redeem');
    assert.equal((await web(lab, origin('a'), '/whoami', { headers: { ...own('a'), cookie: mine.cookie } })).status, 401);
    assert.equal((await web(lab, origin('b'), '/whoami', { headers: { ...own('b'), cookie: other.cookie } })).status, 200);
    assert.equal((await control(lab, 'GET', '/v1/web/apps/app-a/requests', bearer('tablet'))).status, 401);
    const pending = await openAccess('a');
    const id = await pendingId('a', pending.code, 'movil');
    assert.equal((await grant('a', id, 'tablet')).status, 401);
  });

  test('pending requests expire after five minutes and are capped per app', async () => {
    const stale = await openAccess('b');
    const id = await pendingId('b', stale.code);
    t += PENDING_MS;
    assert.equal((await grant('b', id)).status, 404);
    const refreshed = await web(lab, origin('b'), '/', { headers: { ...NAV, cookie: `${PENDING_COOKIE}=${stale.pend}` } });
    assert.notEqual(/id="codigo">([^<]+)</.exec(refreshed.body)?.[1], stale.code);
    for (let i = 0; i < PENDING_MAX; i += 1) await openAccess('b');
    assert.equal((await web(lab, origin('b'), '/', { headers: NAV })).status, 429);
    t += PENDING_MS;
  });

  test('a restarted Puente forgets in-memory authorizations', async () => {
    const { cookie } = await authorize('a');
    await lab.restartPuente();
    assert.equal((await web(lab, origin('a'), '/whoami', { headers: { ...own('a'), cookie } })).status, 401);
    await authorize('a');
  });

  test('the listener log has method, path and status only', async () => {
    const { pend, session, cookie } = await authorize('a', 'movil', '/deep/log?token=no-registrar');
    await web(lab, origin('a'), '/whoami', { headers: { ...own('a'), cookie } });
    const text = lab.gates!.a.log.join('\n');
    assert.match(text, /^GET \/whoami 200$/m);
    for (const secret of [pend, session, 'no-registrar', lab.devices.movil]) assert.ok(!text.includes(secret));
  });
});

describe('Serve directly to the dev server (serve-directo)', () => {
  before(async () => { lab = await startLab('serve-directo', { now }); });
  after(() => lab.close());

  test('FAIL by design: the app is served without any authorization and leaks loopback redirects', async () => {
    const page = await web(lab, origin('a'), '/whoami', { headers: own('a') });
    assert.equal(page.status, 200);
    const redirect = await web(lab, origin('a'), '/redirect/upstream', { headers: NAV });
    assert.match(redirect.headers.location!, /^http:\/\/127\.0\.0\.1:/);
  });
});
