import assert from 'node:assert/strict';
import { test } from 'node:test';
import nativeAbort from 'abort-controller';
import { createBridgeClient } from './bridgeClient.ts';
import { createHash } from 'node:crypto';
import { RelayError } from './client.ts';
const bytes = new TextEncoder().encode('<h1>Synthetic</h1>');
const manifest = { schemaVersion: 1, entry: 'index.html', files: [{ name: 'index.html', mime: 'text/html', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] };
const revision = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
const card = { type: 'web' as const, bundleRef: 'counter', revision };
const page = { cards: [], failedAgents: [], observedAt: 1 };
const response = (body: unknown, capability = true) => new Response(JSON.stringify(body), { headers: capability ? { 'X-Relay-Board-Web': '1' } : {} });
test('web assets require a confirmed capability and paired headers never enter downloaded bytes', async () => {
  const calls: { path: string; headers: Headers }[] = [];
  const client = createBridgeClient({ baseUrl: 'https://synthetic.invalid', key: 'synthetic-fixture-key', fetch: (async (url, opts) => {
    calls.push({ path: String(url), headers: new Headers(opts?.headers) });
    if (String(url).endsWith('/v1/board')) return response(page);
    if (String(url).endsWith('/manifest')) return response({ bundleRef: card.bundleRef, revision, manifest });
    return new Response(bytes, { headers: { 'X-Relay-Board-Web': '1', 'Content-Type': 'text/html' } });
  }) as typeof fetch });
  assert.ok(client.boardWeb);
  await assert.rejects(client.boardWeb.bundle('agent', card, new AbortController().signal)); assert.equal(calls.length, 0);
  assert.equal((await client.boardWeb.page(new AbortController().signal)).supported, true);
  const bundle = await client.boardWeb.bundle('agent', card, new AbortController().signal);
  assert.deepEqual(bundle.assets[0].bytes, bytes); assert.equal(bundle.revision, revision);
  for (const call of calls) {
    assert.equal(call.headers.get('X-Relay-Protocol'), '2'); assert.equal(call.headers.get('X-Relay-Board-Web'), '1');
    assert.equal(call.headers.get('Authorization'), 'Bearer synthetic-fixture-key');
  }
});
test('an older bridge without response capability keeps native metadata and never requests assets', async () => {
  let calls = 0; const client = createBridgeClient({ baseUrl: 'https://synthetic.invalid', key: 'fixture', fetch: (async () => { calls++; return response(page, false); }) as typeof fetch });
  assert.equal((await client.boardWeb!.page(new AbortController().signal)).supported, false);
  await assert.rejects(client.boardWeb!.bundle('agent', card, new AbortController().signal)); assert.equal(calls, 1);
});
test('a revoked, oversized or missing capability asset response is rejected without publishing a bundle', async () => {
  for (const kind of ['revoked', 'oversized', 'capability', 'aborted'] as const) {
    const controller = new AbortController(); let assetCalls = 0;
    const client = createBridgeClient({ baseUrl: 'https://synthetic.invalid', key: 'fixture', fetch: (async url => {
      if (String(url).endsWith('/v1/board')) return response(page);
      if (String(url).endsWith('/manifest')) return response({ bundleRef: card.bundleRef, revision, manifest });
      assetCalls++;
      if (kind === 'aborted') controller.abort();
      if (kind === 'revoked') return new Response(JSON.stringify({ error: { code: 'device_revoked', message: '/private/secret' } }), { status: 403 });
      return new Response(kind === 'oversized' ? new Uint8Array(262145) : bytes, { headers: kind === 'capability' ? { 'Content-Type': 'text/html' } : { 'X-Relay-Board-Web': '1', 'Content-Type': 'text/html' } });
    }) as typeof fetch });
    await client.boardWeb!.page(controller.signal);
    await assert.rejects(client.boardWeb!.bundle('agent', card, controller.signal), (error: Error) => !error.message.includes('/private/secret'));
    assert.equal(assetCalls, 1);
  }
});

test('a streaming body stops before the next read when bytes exceed its declared bound', async () => {
  const { boardWebBytes } = await import('./boardWebClient.ts'); let reads = 0, cancelled = false;
  const response = { headers: new Headers(), body: { getReader: () => ({ read: async () => { reads++; return { done: false, value: new Uint8Array(32) }; }, cancel: async () => { cancelled = true; }, releaseLock() {} }) } } as unknown as Response;
  await assert.rejects(boardWebBytes(response, 16, new AbortController().signal, 100));
  assert.equal(reads, 1); assert.equal(cancelled, true);
});

for (const [target, status] of [['page', 200], ['page', 503], ['manifest', 200], ['manifest', 503], ['asset', 503]] as const) {
  test(`malformed ${target} JSON at HTTP ${status} rejects with a content-free public error`, async () => {
    const canary = 'CANARY44';
    const client = createBridgeClient({ baseUrl: 'https://synthetic.invalid', key: 'fixture', fetch: (async url => {
      const path = String(url);
      if (target === 'page' || (target === 'manifest' && path.endsWith('/manifest')) || (target === 'asset' && path.includes('/assets/'))) {
        return new Response(canary, { status, headers: { 'X-Relay-Board-Web': '1' } });
      }
      if (path.endsWith('/v1/board')) return response(page);
      return response({ bundleRef: card.bundleRef, revision, manifest });
    }) as typeof fetch });
    const signal = new AbortController().signal;
    if (target !== 'page') await client.boardWeb!.page(signal);
    await assert.rejects(target === 'page' ? client.boardWeb!.page(signal) : client.boardWeb!.bundle('agent', card, signal), error => {
      assert.equal(String(error instanceof Error ? error.stack : error).includes(canary), false, 'Parser errors must not expose upstream plaintext');
      assert.ok(error instanceof RelayError);
      assert.equal(error.code, 'unavailable');
      assert.equal(error.message, 'La respuesta del Puente sobre el contenido web del Agente no es válida.');
      assert.equal(String(error.stack).includes(canary), false);
      assert.equal(JSON.stringify(error).includes(canary), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  });
}

test('invalid UTF-8 inside otherwise valid JSON is rejected with a content-free error', async () => {
  const body = new TextEncoder().encode('{"cards":[],"failedAgents":[],"observedAt":1,"extra":"X"}');
  body[body.length - 3] = 255;
  const client = createBridgeClient({ baseUrl: 'https://synthetic.invalid', key: 'fixture', fetch: (async () => new Response(body, { headers: { 'X-Relay-Board-Web': '1' } })) as typeof fetch });
  await assert.rejects(client.boardWeb!.page(new AbortController().signal), error => {
    assert.ok(error instanceof RelayError);
    assert.equal(error.code, 'unavailable');
    assert.equal(error.message, 'La respuesta del Puente sobre el contenido web del Agente no es válida.');
    assert.equal(error.cause, undefined);
    return true;
  });
});

for (const code of ['device_revoked', 'key_unknown', 'unauthorized', 'pairing_required', 'protocol_upgrade_required', 'tailnet_required', 'rate_limited'] as const) {
  test(`a valid ${code} denial preserves its safe code without upstream content`, async () => {
    const client = createBridgeClient({ baseUrl: 'https://synthetic.invalid', key: 'fixture', fetch: (async () => new Response(JSON.stringify({ error: { code, message: 'CANARY44' } }), { status: 403 })) as typeof fetch });
    await assert.rejects(client.boardWeb!.page(new AbortController().signal), error => {
      assert.ok(error instanceof RelayError);
      assert.equal(error.code, code); assert.equal(error.status, 403);
      assert.equal(error.message, 'El Puente rechazó la lectura de contenido web.');
      assert.equal(String(error.stack).includes('CANARY44'), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  });
}

test('the board loads with the Android AbortSignal implementation, which has no throwIfAborted method', async () => {
  const controller=new nativeAbort();
  const signal=controller.signal as unknown as AbortSignal;
  assert.equal(typeof signal.throwIfAborted,'undefined');
  const client=createBridgeClient({baseUrl:'https://synthetic.invalid',key:'fixture',fetch:(async()=>response(page)) as typeof fetch});
  assert.deepEqual((await client.boardWeb!.page(signal)).page,page);
});

test('Android cancellation during a streamed board read still prevents publishing the board', async () => {
  const controller=new nativeAbort();
  let reads=0;
  const transport={ok:true,status:200,headers:new Headers({'X-Relay-Board-Web':'1'}),body:{getReader:()=>({
    read:async()=>{reads++;controller.abort();return {done:false,value:new TextEncoder().encode(JSON.stringify(page))};},
    cancel:async()=>{},releaseLock(){}
  })}} as unknown as Response;
  const client=createBridgeClient({baseUrl:'https://synthetic.invalid',key:'fixture',fetch:(async()=>transport) as typeof fetch});
  await assert.rejects(client.boardWeb!.page(controller.signal as unknown as AbortSignal),{code:'cancelled'});
  assert.equal(reads,1);
});

test('Android cancellation after response headers arrives prevents a new body read and publication', async () => {
  const controller=new nativeAbort();
  const transport=response(page);
  const headers=transport.headers,get=headers.get.bind(headers);
  headers.get=(name:string)=>{controller.abort();return get(name);};
  const client=createBridgeClient({baseUrl:'https://synthetic.invalid',key:'fixture',fetch:(async()=>transport) as typeof fetch});
  await assert.rejects(client.boardWeb!.page(controller.signal as unknown as AbortSignal),{code:'cancelled'});
});
