import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REMOTE_ERROR_MESSAGES, type RemoteErrorCode } from '../../../protocol/protocol.ts';
import { remoteToolStates, type AppRemoteCapabilities, type RemoteInputs, type RemoteToolState } from './remoteCapabilities.ts';
import { createRemoteClient, fetchRemoteStatus, RemoteFailure } from './remoteClient.ts';

const V1 = { version: 1, minAppVersion: 1 };
const APP: AppRemoteCapabilities = { environments: { version: 1, minBridgeVersion: 1 }, files: { version: 1, minBridgeVersion: 1 } };
const health = (capabilities?: unknown) => ({ ok: true, service: 'relayd', version: '9.9.9', protocolVersion: 2, minAppProtocolVersion: 2, ...(capabilities === undefined ? {} : { capabilities }) });
const AVAILABLE: RemoteToolState = { state: 'available', capability: { name: 'files', version: 1 } };

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response> = () => Response.json({ ok: true })) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return respond(url, init); }) as unknown as typeof globalThis.fetch;
  return { calls, transport: { baseUrl: 'http://arch.example.ts.net:8650', key: 'rly1_key', fetch } };
}

const failure = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { if (error instanceof RemoteFailure) return error; throw error; }
  assert.fail('expected a RemoteFailure');
};

test('a remote request carries the key, the protocol and the negotiated capability', async () => {
  const { calls, transport } = fakeFetch();
  const client = createRemoteClient(transport, AVAILABLE, () => AVAILABLE);
  assert.deepEqual(await client.request('POST', '/v1/remote/files/list', { at: 'x' }), { ok: true });
  assert.equal(calls[0]!.url, 'http://arch.example.ts.net:8650/v1/remote/files/list');
  assert.equal(calls[0]!.init.redirect, 'error');
  assert.deepEqual(calls[0]!.init.headers, {
    Accept: 'application/json', Authorization: 'Bearer rly1_key', 'X-Relay-Protocol': '2', 'X-Relay-Capability': 'files/1', 'Content-Type': 'application/json',
  });
  assert.equal(calls[0]!.init.body, '{"at":"x"}');
});

test('a transfer chunk goes up raw and comes down raw; a refused one is normalized; cancelling it aborts the request', async () => {
  const { calls, transport } = fakeFetch((url, init) => {
    if (url.endsWith('/refused')) return Response.json({ error: { code: 'remote_ended', message: 'x' } }, { status: 410 });
    if (url.endsWith('/slow')) {
      const { promise, reject } = Promise.withResolvers<Response>();
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
      return promise;
    }
    return init.method === 'GET' ? new Response(new Uint8Array([1, 2, 3])) : Response.json({ id: 'op_x', received: 3 });
  });
  const client = createRemoteClient(transport, AVAILABLE, () => AVAILABLE);
  const signal = new AbortController().signal;
  assert.deepEqual(await client.chunk('PUT', '/v1/remote/files/uploads/op_x/0', new Uint8Array([7, 8, 9]), signal), { id: 'op_x', received: 3 });
  assert.deepEqual(calls[0]!.init.body, new Uint8Array([7, 8, 9]));
  assert.equal((calls[0]!.init.headers as Record<string, string>)['Content-Type'], 'application/octet-stream');
  assert.deepEqual(await client.chunk('GET', '/v1/remote/files/downloads/op_x/0', undefined, signal), new Uint8Array([1, 2, 3]));
  assert.equal((calls[1]!.init.headers as Record<string, string>).Accept, 'application/octet-stream');
  assert.equal((await failure(client.chunk('GET', '/v1/remote/files/downloads/op_x/refused', undefined, signal))).code, 'remote_ended');
  const cancel = new AbortController();
  const slow = client.chunk('GET', '/v1/remote/files/downloads/op_x/slow', undefined, cancel.signal);
  cancel.abort();
  assert.equal((await failure(slow)).kind, 'no_response');
});

test('the client is built only from an available tool and re-reads the state before every call', async () => {
  const { calls, transport } = fakeFetch();
  assert.throws(() => createRemoteClient(transport, { state: 'update_bridge' }, () => AVAILABLE));
  let current: RemoteToolState = AVAILABLE;
  const client = createRemoteClient(transport, AVAILABLE, () => current);
  await client.request('GET', '/v1/remote/files/x');
  for (const next of [
    { state: 'update_bridge' }, { state: 'no_response' }, { state: 'checking' }, { state: 'unavailable', reason: 'helper_stopped' },
    { state: 'available', capability: { name: 'files', version: 2 } }, { state: 'available', capability: { name: 'web', version: 1 } },
  ] as RemoteToolState[]) {
    current = next;
    assert.equal((await failure(client.request('GET', '/v1/remote/files/x'))).kind, 'not_offered', JSON.stringify(next));
  }
  assert.equal(calls.length, 1);
  current = AVAILABLE;
  await client.request('GET', '/v1/remote/files/x');
  assert.equal(calls.length, 2);
  await assert.rejects(client.request('GET', '/v1/agents'));
  // Only plain segments: anything fetch could normalize or split out of /v1/remote/ sends nothing.
  for (const path of ['/v1/remote/../whoami', '/v1/remote/files/..', '/v1/remote/./status', '/v1/remote//whoami', '/v1/remote/status?x=1', '/v1/remote/status#x', '/v1/remote/%2e%2e/whoami', '/v1/remote/%2E%2E/whoami', '/v1/remote/files\\..\\..\\whoami', '/v1/remote/', '/v1/remote']) {
    await assert.rejects(client.request('GET', path), /only to \/v1\/remote/, path);
  }
  assert.equal(calls.length, 2);
});

test('no /v1/remote request leaves without a current advertisement that includes it', async () => {
  const { calls, transport } = fakeFetch(() => Response.json({ serverNow: 5, files: { state: 'available' } }));
  const capability = (extra: Partial<RemoteInputs>) => () =>
    remoteToolStates({ health: { body: health({ environments: V1, files: V1 }), at: 100 }, lastConnectionFailureAt: null, bridgeChangedAt: null, status: null, app: APP, ...extra }).status;
  for (const extra of [
    { health: { body: health(), at: 100 } }, { health: { body: health({ files: 'x' }), at: 100 } }, { health: null },
    { lastConnectionFailureAt: 100 }, { bridgeChangedAt: 100 }, { app: {} },
  ] as Partial<RemoteInputs>[]) assert.equal((await failure(fetchRemoteStatus(transport, capability(extra)))).kind, 'not_offered', JSON.stringify(extra));
  assert.equal(calls.length, 0);
  assert.deepEqual(await fetchRemoteStatus(transport, capability({})), { serverNow: 5, files: { state: 'available' } });
  assert.equal(calls.length, 1);
  assert.equal((calls[0]!.init.headers as Record<string, string>)['X-Relay-Capability'], 'environments/1');
});

const respond = (status: number, body?: unknown) => () => body === undefined ? new Response('<html>', { status }) : Response.json(body, { status });
const error = (code: string, message = 'texto del Puente con /home/user') => ({ error: { code, message } });

test('remote responses are normalized by code, never through the generic auth or connection mapping', async () => {
  const cases: [() => Response | Promise<Response>, Record<string, unknown>][] = [
    [respond(404, error('remote_not_found')), { kind: 'remote', code: 'remote_not_found' }],
    [respond(404, error('not_found')), { kind: 'bridge_changed' }],
    [respond(404, error('something_new')), { kind: 'bridge_changed' }],
    [respond(404), { kind: 'bridge_changed' }],
    [respond(426, error('protocol_upgrade_required')), { kind: 'bridge_changed' }],
    [respond(426, error('remote_upgrade_required')), { kind: 'bridge_changed' }],
    [respond(401, error('key_unknown')), { kind: 'auth', code: 'key_unknown' }],
    [respond(401), { kind: 'auth', code: 'key_unknown' }],
    [respond(403, error('device_revoked')), { kind: 'auth', code: 'device_revoked' }],
    [respond(403, error('remote_permission_denied')), { kind: 'remote', code: 'remote_permission_denied' }],
    [respond(403, error('forbidden_something')), { kind: 'unexpected', status: 403 }],
    [respond(429, error('remote_limit_reached')), { kind: 'remote', code: 'remote_limit_reached' }],
    [respond(409, error('remote_conflict')), { kind: 'remote', code: 'remote_conflict' }],
    [respond(409, error('remote_limit_reached')), { kind: 'unexpected', status: 409 }],
    [respond(500, error('internal')), { kind: 'unexpected', status: 500 }],
    [() => { throw new TypeError('fetch failed'); }, { kind: 'no_response' }],
  ];
  for (const [response, expected] of cases) {
    const { transport } = fakeFetch(response);
    const got = await failure(createRemoteClient(transport, AVAILABLE, () => AVAILABLE).request('GET', '/v1/remote/files/x'));
    assert.deepEqual({ kind: got.kind, code: got.code, status: got.status }, { code: undefined, status: undefined, ...expected }, JSON.stringify(expected));
    // The app's own fixed text, never the Puente's message.
    if (got.kind === 'remote') assert.equal(got.message, REMOTE_ERROR_MESSAGES[got.code as RemoteErrorCode]);
    assert.doesNotMatch(got.message, /home/);
  }
});

test('a timeout is no response', async () => {
  const { transport } = fakeFetch((_, init) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')))));
  const got = await failure(createRemoteClient({ ...transport, timeoutMs: 5 }, AVAILABLE, () => AVAILABLE).request('GET', '/v1/remote/files/x'));
  assert.equal(got.kind, 'no_response');
});

test('after the Puente changed or stopped answering, the same client sends nothing more', async () => {
  for (const first of [respond(404, error('not_found')), respond(426, error('remote_upgrade_required')), () => { throw new TypeError('fetch failed'); }]) {
    const { calls, transport } = fakeFetch(first);
    const client = createRemoteClient(transport, AVAILABLE, () => AVAILABLE);
    await failure(client.request('GET', '/v1/remote/files/x'));
    assert.equal((await failure(client.request('GET', '/v1/remote/files/x'))).kind, 'not_offered');
    assert.equal(calls.length, 1);
  }
});

test('a stream carries the key, the capability and Last-Event-ID, and hands over each event whole', async () => {
  const encoder = new TextEncoder();
  // An event split across reads, and a UTF-8 character split between two chunks.
  const chunks = ['data: {"type":"open"}\n\nid: 7\ndata: {"a":"', 'ñ"}\n\n: keepalive\n\n'].map((text) => encoder.encode(text));
  const ene = chunks[1]![0];
  const parts = [chunks[0]!, ...[chunks[1]!.slice(0, 1), chunks[1]!.slice(1)]];
  assert.equal(ene, 0xc3);
  const { calls, transport } = fakeFetch(() => new Response(new ReadableStream({ start(c) { for (const part of parts) c.enqueue(part); c.close(); } })));
  const got: string[] = [];
  await createRemoteClient(transport, AVAILABLE, () => AVAILABLE).stream('/v1/remote/terminals/env_x/output', 6, (data) => got.push(data), new AbortController().signal);
  assert.deepEqual(got, ['{"type":"open"}', '{"a":"ñ"}']);
  assert.deepEqual(calls[0]!.init.headers, {
    Accept: 'text/event-stream', Authorization: 'Bearer rly1_key', 'X-Relay-Protocol': '2', 'X-Relay-Capability': 'files/1', 'Last-Event-ID': '6',
  });
  assert.equal(calls[0]!.init.redirect, 'error');
});

test('a refused stream is normalized like a request; silence is no response; aborting is a quiet end', async () => {
  const refused = fakeFetch(respond(410, error('remote_ended')));
  const got = await failure(createRemoteClient(refused.transport, AVAILABLE, () => AVAILABLE).stream('/v1/remote/terminals/env_x/output', 0, () => {}, new AbortController().signal));
  assert.deepEqual({ kind: got.kind, code: got.code }, { kind: 'remote', code: 'remote_ended' });

  // Like fetch, the body errors once the request is aborted.
  const silent = (_: string, init: RequestInit) => new Response(new ReadableStream({
    start(c) { if (init.signal!.aborted) c.error(new Error('aborted')); else init.signal!.addEventListener('abort', () => c.error(new Error('aborted'))); },
  }));
  const quiet = fakeFetch(silent);
  const client = createRemoteClient(quiet.transport, AVAILABLE, () => AVAILABLE);
  // Same convention as the request timeout above: a 5 ms idle limit on the real clock.
  assert.equal((await failure(client.stream('/v1/remote/terminals/env_x/output', 0, () => {}, new AbortController().signal, 5))).kind, 'no_response');
  // A stream that stopped answering retires the client like any request.
  assert.equal((await failure(client.request('GET', '/v1/remote/files/x'))).kind, 'not_offered');

  const controller = new AbortController();
  const open = createRemoteClient(fakeFetch(silent).transport, AVAILABLE, () => AVAILABLE).stream('/v1/remote/terminals/env_x/output', 0, () => {}, controller.signal);
  controller.abort();
  await open;
});
