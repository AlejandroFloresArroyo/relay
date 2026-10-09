import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridgeClient, createPairedBridgeClient } from './bridgeClient.ts';
import { RelayError } from './client.ts';
import { migratePairedServers, createPairedServerStore } from './pairedServers.ts';
import { createPairingFlow, exchangePairing } from './pairing.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('legacy or key-less servers never send a bearer on any private operation, public routes remain available', async () => {
  for (const credentials of [{ key: 'old-key' }, { key: '', deviceId: 'device' }, { key: 'old-key', deviceId: '' }]) {
    const calls: RequestInit[] = [];
    const client = createPairedBridgeClient({ baseUrl: 'http://atlas.example.ts.net:8650', ...credentials, fetch: (async (_url, init) => { calls.push(init ?? {}); return json({ ok: true }); }) as typeof fetch });
    for (const operation of [() => client.agents(), () => client.server(), () => client.transcript('a'), () => client.startRun('a', { input: 'hello' }), () => client.stopRun('r'), () => client.approvals(), () => client.decide('a', 'deny'), () => client.gateway(), () => client.gatewayAction('start'), () => client.doctor(), () => client.logs(null), () => client.model(), () => client.jobs(), () => client.runEvents('r', () => {})]) {
      await assert.rejects(operation(), (error) => error instanceof RelayError && error.code === 'pairing_required');
    }
    assert.equal(calls.length, 0);
    await client.health();
    await client.whoami();
    assert.equal(calls.length, 2);
    for (const call of calls) assert.equal(new Headers(call.headers).get('Authorization'), null);
  }
});

test('paired client sends its own key and preserves JSON errors in requests and SSE handshakes', async () => {
  for (const [code, status] of [['device_revoked', 403], ['key_unknown', 401], ['rate_limited', 429], ['tailnet_required', 403], ['pairing_invalid', 401], ['bad_request', 400]] as const) {
    const client = createPairedBridgeClient({ baseUrl: 'http://atlas.example.ts.net:8650', deviceId: 'device', key: 'synthetic', fetch: (async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic');
      assert.equal(init?.redirect, 'error');
      return json({ error: { code, message: 'denied' } }, status);
    }) as typeof fetch });
    await assert.rejects(client.agents(), (error) => error instanceof RelayError && error.code === code && error.status === status);
    await assert.rejects(client.runEvents('r', () => {}), (error) => error instanceof RelayError && error.code === code && error.status === status);
  }
});

test('unsafe stored paired origins retain metadata but reject every fetch locally', async () => {
  for (const url of ['https://evil.example', 'https://atlas.example.ts.net', 'http://100.64.0.1:8650', 'http://short:8650', 'http://atlas.ts.net', 'http://atlas.example.ts.net.evil.example', 'http://atlas.example.ts.net@evil.example', 'http://user:pass@atlas.example.ts.net', 'http://atlas.example.ts.net/private', 'http://atlas.example.ts.net?x=1', 'http://atlas.example.ts.net#part']) {
    const saved = { id: 'atlas', name: 'Mi atlas', url, isDefault: true, deviceId: 'device', key: 'synthetic' };
    const migrated = migratePairedServers(JSON.stringify([saved]));
    assert.deepEqual(migrated.servers, [saved]);
    let calls = 0;
    const client = createPairedBridgeClient({ baseUrl: migrated.servers[0].url, deviceId: saved.deviceId, key: saved.key, fetch: (async () => { calls++; return json({}); }) as typeof fetch });
    for (const operation of [() => client.health(), () => client.whoami(), () => client.agents(), () => client.server(), () => client.runEvents('r', () => {})]) {
      await assert.rejects(operation(), (error) => error instanceof RelayError && error.code === 'bad_request');
    }
    assert.equal(calls, 0, url);
  }
});

test('paired calls canonicalize omitted ports and uppercase trailing-dot origins for JSON and SSE', async () => {
  for (const baseUrl of ['atlas.example.ts.net', 'HTTP://ATLAS.EXAMPLE.TS.NET.']) {
    const calls: string[] = [];
    const client = createPairedBridgeClient({ baseUrl, deviceId: 'device', key: 'synthetic', fetch: (async (url) => { calls.push(String(url)); return json({ agents: [] }); }) as typeof fetch });
    await client.agents();
    await client.runEvents('r', () => {});
    assert.deepEqual(calls, ['http://atlas.example.ts.net:8650/v1/agents', 'http://atlas.example.ts.net:8650/v1/runs/r/events']);
  }
});

test('omitted-port pairing saves the canonical origin and success details use the same port', async () => {
  const response = { deviceKey: 'synthetic', device: { id: 'device', name: 'Teléfono', pairedAt: 1700000000000, revokedAt: null }, server: { name: 'atlas' } };
  const calls: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith('/health')) return json({ ok: true, service: 'relayd', version: 'test', protocolVersion: 1 });
    if (String(url).endsWith('/v1/pair')) { assert.equal(new Headers(init?.headers).get('Authorization'), null); return json(response, 201); }
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic');
    return json({});
  };
  const store = createPairedServerStore({ initial: [], write: async () => {}, newId: () => 'atlas' });
  const flow = createPairingFlow({ exchange: (input) => exchangePairing({ ...input, fetch: transport }), persist: (value, url) => store.add({ name: value.server.name, url, key: value.deviceKey, deviceId: value.device.id }) });
  await flow.submit({ baseUrl: 'atlas.example.ts.net', code: '0123456789' });
  const state = flow.state();
  assert.equal(state.kind, 'success');
  if (state.kind !== 'success') return;
  assert.equal(state.url, store.entries()[0].url);
  assert.equal(state.url, 'http://atlas.example.ts.net:8650');
  await createPairedBridgeClient({ baseUrl: state.url, key: state.response.deviceKey, deviceId: state.response.device.id, fetch: transport }).server();
  assert.deepEqual(calls, ['http://atlas.example.ts.net:8650/health', 'http://atlas.example.ts.net:8650/v1/pair', 'http://atlas.example.ts.net:8650/v1/server']);
});

test('unknown wire error codes remain generic HTTP errors for requests and SSE', async () => {
  const client = createPairedBridgeClient({ baseUrl: 'atlas.example.ts.net', deviceId: 'device', key: 'synthetic', fetch: (async () => json({ error: { code: 'future_code' } }, 400)) as typeof fetch });
  await assert.rejects(client.agents(), (error) => error instanceof RelayError && error.code === 'http' && error.status === 400);
  await assert.rejects(client.runEvents('r', () => {}), (error) => error instanceof RelayError && error.code === 'http' && error.status === 400);
});

test('bridge redirects are rejected in regular requests and SSE', async () => {
  const client = createBridgeClient({ baseUrl: 'http://atlas.example.ts.net:8650', key: 'synthetic', fetch: (async () => new Response(null, { status: 302, headers: { Location: 'http://evil.com' } })) as typeof fetch });
  await assert.rejects(client.agents());
  await assert.rejects(client.runEvents('r', () => {}));
});
