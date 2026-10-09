import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { PairingResponse } from '../../../protocol/protocol.ts';
import { normalizePairingCode, formatPairingCode, parsePairingQr, validateServerAddress, exchangePairing, describePairingFailure } from './pairing.ts';

test('normalizes only ASCII spaces, hyphens and Crockford aliases', () => {
  assert.equal(normalizePairingCode(' oIl23-abc de '), '01123ABCDE');
  for (const code of ['012345678', '01234567890', '01234U6789', '01234\t56789', '01234\n56789', '０123456789', '01234\u00a056789']) {
    assert.throws(() => normalizePairingCode(code));
  }
});

test('validates HTTP full tailnet origins and explicit or default ports', () => {
  assert.equal(validateServerAddress(' ARCH.Example.ts.net '), 'http://arch.example.ts.net:8650');
  assert.equal(validateServerAddress('HTTP://ARCH.Example.ts.net.:80'), 'http://arch.example.ts.net:80');
  for (const url of ['https://arch.example.ts.net', 'http://arch.ts.net', 'http://ts.net', 'http://127.0.0.1', 'arch', 'http://user@arch.example.ts.net', 'http://arch.example.ts.net/path', 'http://arch.example.ts.net/', 'http://arch.example.ts.net?x=1', 'http://arch.example.ts.net#x', 'http://arch.example.ts.net:0', 'http://arch.example.ts.net:65536', 'http://arch.example.ts.net:', 'http://-arch.example.ts.net', 'http://arch..example.ts.net', 'http://árch.example.ts.net', 'http://arch.example.ts.net\\evil']) {
    assert.throws(() => validateServerAddress(url), url);
  }
});

test('rejects QR destinations outside the tailnet before any network call', () => {
  const fixture = { type: 'relay-pair', version: 1, url: 'http://arch.example.ts.net:8650', code: '0123456789' };
  assert.deepEqual(parsePairingQr(JSON.stringify(fixture)), fixture);
  for (const url of ['http://evil.com', 'http://arch.example.ts.net.evil.com', 'https://arch.example.ts.net', 'http://user:pass@arch.example.ts.net', 'http://arch.ts.net']) {
    assert.throws(() => parsePairingQr(JSON.stringify({ ...fixture, url })), url);
  }
  for (const payload of ['not json', JSON.stringify({ ...fixture, version: 2 }), JSON.stringify({ ...fixture, type: 'other' }), JSON.stringify({ ...fixture, code: 123 }), JSON.stringify({ ...fixture, pad: 'é'.repeat(1024) })]) {
    assert.throws(() => parsePairingQr(payload));
  }
});


export const response: PairingResponse = {
  deviceKey: 'synthetic-device-key',
  device: { id: '12345678-1234-4234-8234-123456789abc', name: 'S23 de Ana', pairedAt: 1_700_000_000_000, revokedAt: null },
  server: { name: 'atlas' },
};
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const baseUrl = 'http://arch.example.ts.net:8650';

test('manual and QR exchange send one canonical code without bearer or redirects', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  function fake(this: unknown, url: string | URL | Request, init: RequestInit = {}) {
    assert.equal(this, undefined);
    calls.push({ url: String(url), init });
    return Promise.resolve(String(url).endsWith('/health') ? json({ ok: true, service: 'relayd', version: 'test', protocolVersion: 1 }) : json(response, 201));
  }
  assert.deepEqual(await exchangePairing({ baseUrl, code: '01234-56789', fetch: fake as typeof fetch }), response);
  assert.equal(calls[1].url, `${baseUrl}/v1/pair`);
  assert.equal(calls[1].init.redirect, 'error');
  assert.equal(new Headers(calls[1].init.headers).get('Authorization'), null);
  assert.deepEqual(JSON.parse(calls[1].init.body as string), { code: '0123456789' });
  const qr = parsePairingQr('{"type":"relay-pair","version":1,"url":"http://arch.example.ts.net:8650","code":"0123456789"}');
  await exchangePairing({ baseUrl: qr.url, code: qr.code, fetch: fake as typeof fetch });
  assert.deepEqual(calls[3].init.body, calls[1].init.body);
});

test('invalid destinations or codes never reach fetch, and legacy health never consumes a code', async () => {
  let count = 0;
  const fake = (async () => { count++; return json({ ok: true, service: 'relayd', version: 'old' }); }) as typeof fetch;
  await assert.rejects(exchangePairing({ baseUrl: 'http://evil.com', code: '0123456789', fetch: fake }));
  await assert.rejects(exchangePairing({ baseUrl, code: 'bad', fetch: fake }));
  assert.equal(count, 0);
  await assert.rejects(exchangePairing({ baseUrl, code: '0123456789', fetch: fake }), { code: 'update_bridge' });
  assert.equal(count, 1);
});

test('maps every A7 error to its own Spanish recovery state without exposing raw bodies', async () => {
  const cases = [['pairing_invalid', 401], ['key_unknown', 401], ['device_revoked', 403], ['rate_limited', 429], ['tailnet_required', 403], ['unavailable', 503], ['bad_request', 400]] as const;
  for (const [code, status] of cases) {
    const fake = (async (url) => String(url).endsWith('/health') ? json({ ok: true, service: 'relayd', version: 'test', protocolVersion: 1 }) : json({ error: { code, message: 'SECRET' } }, status, { 'Retry-After': '61' })) as typeof fetch;
    await assert.rejects(exchangePairing({ baseUrl, code: '0123456789', fetch: fake }), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal((e as { code?: string }).code, code);
      assert.doesNotMatch(e.message, /SECRET/);
      const view = describePairingFailure(e);
      assert.ok(view.title && view.hint);
      assert.equal(view.kind, code);
      if (code === 'rate_limited') assert.match(view.hint, /61/);
      return true;
    });
  }
});

test('redirects, invalid success bodies, network errors and timeout never confirm pairing', async () => {
  for (const answer of [new Response(null, { status: 302 }), json({ ...response, device: { ...response.device, revokedAt: 1 } }, 201), json(response, 200)]) {
    const fake = (async (url) => String(url).endsWith('/health') ? json({ ok: true, service: 'relayd', version: 'test', protocolVersion: 1 }) : answer) as typeof fetch;
    await assert.rejects(exchangePairing({ baseUrl, code: '0123456789', fetch: fake }));
  }
  await assert.rejects(exchangePairing({ baseUrl, code: '0123456789', fetch: (async () => { throw new Error('SECRET'); }) as typeof fetch }), { code: 'unreachable' });
  const hang = ((_url: unknown, init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch;
  await assert.rejects(exchangePairing({ baseUrl, code: '0123456789', fetch: hang, timeoutMs: 10 }), { code: 'unreachable' });
});

test('real fetch refuses redirecting the pairing POST to another origin', async () => {
  let forwarded = 0;
  const target = createServer((_req, res) => { forwarded++; res.end(); });
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  const address = target.address();
  assert.ok(address && typeof address !== 'string');
  const source = createServer((req, res) => {
    if (req.url === '/health') {
      res.end(JSON.stringify({ ok: true, service: 'relayd', version: 'test', protocolVersion: 1 }));
    } else {
      res.writeHead(307, { Location: `http://127.0.0.1:${address.port}/other` }); res.end();
    }
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const local = source.address();
  assert.ok(local && typeof local !== 'string');
  try {
    const transport = ((url, init) => fetch(`http://127.0.0.1:${local.port}${new URL(String(url)).pathname}`, init)) as typeof fetch;
    await assert.rejects(exchangePairing({ baseUrl, code: '0123456789', fetch: transport }), { code: 'unreachable' });
    assert.equal(forwarded, 0);
  } finally {
    source.closeAllConnections(); target.closeAllConnections();
    await Promise.all([new Promise<void>((resolve) => source.close(() => resolve())), new Promise<void>((resolve) => target.close(() => resolve()))]);
  }
});

test('presents all ten code symbols in two groups of five', () => {
  assert.equal(formatPairingCode('0123456789'), '01234-56789');
  assert.equal(formatPairingCode('oIl23abcde'), '01123-ABCDE');
});
