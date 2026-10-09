import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAT_PROTOCOL_HEADER, PROTOCOL_VERSION } from '../../../protocol/protocol.ts';
import { createBridgeClient } from './bridgeClient.ts';
import { readServerMetrics, validServerMetrics } from './serverMetrics.ts';

const READING = { cpuPercent: 61, memoryPercent: 48.5, diskPercent: 82, measuredAt: 1_700_000_000_000 };
const health = (capabilities?: unknown) =>
  ({ ok: true, service: 'relayd', version: '9.9.9', protocolVersion: 2, minAppProtocolVersion: 2, ...(capabilities === undefined ? {} : { capabilities }) });
const ADVERTISED = health({ metrics: { version: 1, minAppVersion: 1 } });

function client(answer: () => Promise<Response>) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url, headers: init?.headers as Record<string, string> });
    return answer();
  }) as typeof globalThis.fetch;
  return { requests, client: createBridgeClient({ baseUrl: 'http://synthetic.fixture.ts.net:17651', key: 'synthetic-key', fetch }) };
}

test('an advertised Puente is asked once, with the key and protocol header, and its reading is returned', async () => {
  const { client: bridge, requests } = client(async () => new Response(JSON.stringify(READING)));
  assert.deepEqual(await readServerMetrics(ADVERTISED, bridge), { state: 'reading', metrics: READING });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://synthetic.fixture.ts.net:17651/v1/metrics');
  assert.equal(requests[0].headers.Authorization, 'Bearer synthetic-key');
  assert.equal(requests[0].headers[CHAT_PROTOCOL_HEADER], String(PROTOCOL_VERSION));
});

test('an old Puente without the advertisement is told apart from a failure and is never asked', async () => {
  const { client: bridge, requests } = client(async () => new Response(JSON.stringify(READING)));
  for (const body of [health(), health({}), health({ files: { version: 1, minAppVersion: 1 } }), health({ metrics: { version: 1, minAppVersion: 2 } }),
    health({ metrics: { version: '1', minAppVersion: 1 } }), health({ metrics: { version: 0, minAppVersion: 0 } }), null]) {
    assert.deepEqual(await readServerMetrics(body, bridge), { state: 'not_advertised' }, JSON.stringify(body));
  }
  assert.equal(requests.length, 0);
  // A client without the method (the demo) behaves as a Puente without metrics.
  assert.deepEqual(await readServerMetrics(ADVERTISED, {}), { state: 'not_advertised' });
});

test('an invalid reading is a failure and is never shown', async () => {
  for (const change of [{ cpuPercent: 100.1 }, { memoryPercent: -1 }, { diskPercent: NaN }, { cpuPercent: Infinity }, { memoryPercent: '48' },
    { measuredAt: undefined }, { measuredAt: -1 }, { measuredAt: 1.5 }, { diskPercent: null }]) {
    const value = { ...READING, ...change };
    assert.equal(validServerMetrics(value), false, JSON.stringify(change));
    assert.deepEqual(await readServerMetrics(ADVERTISED, { metrics: async () => value }), { state: 'failure' }, JSON.stringify(change));
  }
  for (const value of [null, [], 'reading', { ...READING, measuredAt: undefined, extra: 1 }]) {
    assert.deepEqual(await readServerMetrics(ADVERTISED, { metrics: async () => value }), { state: 'failure' });
  }
  // The edges are valid; only the four fields are kept.
  assert.deepEqual(await readServerMetrics(ADVERTISED, { metrics: async () => ({ ...READING, cpuPercent: 0, diskPercent: 100, extra: 'x' }) }),
    { state: 'reading', metrics: { ...READING, cpuPercent: 0, diskPercent: 100 } });
});

test('a network failure or an error answer is a failure, not a missing capability', async () => {
  const offline = client(async () => { throw new TypeError('fetch failed'); });
  assert.deepEqual(await readServerMetrics(ADVERTISED, offline.client), { state: 'failure' });
  const failing = client(async () => new Response(JSON.stringify({ error: { code: 'metrics_unavailable', message: 'No se pudieron leer las métricas del Servidor.' } }), { status: 503 }));
  assert.deepEqual(await readServerMetrics(ADVERTISED, failing.client), { state: 'failure' });
});
