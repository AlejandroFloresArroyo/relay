import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAT_PROTOCOL_HEADER, PROTOCOL_VERSION } from '../../protocol/protocol.ts';
import { createMetrics, createSystemReader, METRICS_CAPABILITY, type CpuTimes, type SystemReader } from '../src/metrics.ts';
import { AUTH, start } from '../support/discoveryHttpFixture.ts';

const HERMES_HOME = '/srv/synthetic-owner/.hermes-fixture';
const HEADERS = { ...AUTH, [CHAT_PROTOCOL_HEADER]: String(PROTOCOL_VERSION) };
// 3 of 4 CPU units busy; (16 - 4.4) / 16 of memory without the cache; 600 used of 600 + 400 blocks.
const MEMINFO = 'MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    4400000 kB\nCached:          3000000 kB\n';

function fakeReader(overrides: Partial<SystemReader> = {}): SystemReader & { statfsPaths: string[] } {
  const samples: CpuTimes[] = [{ idle: 1000, total: 2000 }, { idle: 1100, total: 2400 }];
  const statfsPaths: string[] = [];
  return {
    supported: true,
    cpu: () => samples.shift() ?? { idle: 1100, total: 2400 },
    meminfo: async () => MEMINFO,
    statfs: async (path) => { statfsPaths.push(path); return { blocks: 1000, bfree: 400, bavail: 400, bsize: 4096 }; },
    statfsPaths,
    ...overrides,
  };
}

const metricsWith = (reader: SystemReader) => createMetrics({ reader, hermesHome: HERMES_HOME, wait: async () => {} });

test('metrics read the whole machine: busy CPU, memory without the cache and the disk that holds Hermes', async () => {
  const reader = fakeReader();
  assert.deepEqual(await metricsWith(reader)!.read(), { cpuPercent: 75, memoryPercent: 72.5, diskPercent: 60 });
  assert.deepEqual(reader.statfsPaths, [HERMES_HOME]);
});

test('CPU compares against a recent previous sample and takes two, waiting without blocking, when there is none', async () => {
  let clock = 0; const waits: number[] = [];
  const samples: CpuTimes[] = [{ idle: 0, total: 0 }, { idle: 50, total: 100 }, { idle: 50, total: 200 }, { idle: 60, total: 300 }, { idle: 160, total: 400 }];
  const metrics = createMetrics({ reader: fakeReader({ cpu: () => samples.shift()! }), hermesHome: HERMES_HOME, monotonic: () => clock,
    wait: async (ms) => { waits.push(ms); clock += ms; } })!;
  assert.equal((await metrics.read()).cpuPercent, 50);
  assert.equal(waits.length, 1);
  clock += 5_000; // a 5 s poll reuses the last sample
  assert.equal((await metrics.read()).cpuPercent, 100);
  clock += 60_000; // a stale sample is not compared against: two fresh ones
  assert.equal((await metrics.read()).cpuPercent, 0);
  assert.equal(waits.length, 2);
});

test('the real reader is off where it cannot read', () => {
  assert.equal(createSystemReader('darwin').supported, false);
  assert.equal(createMetrics({ reader: createSystemReader('win32'), hermesHome: HERMES_HOME }), null);
});

test('GET /v1/metrics answers the four fields with the Server clock in ms, and /health advertises metrics', async (t) => {
  const f = await start(t, undefined, { metrics: metricsWith(fakeReader()) });
  const health = await f.call('GET', '/health', undefined, {});
  assert.deepEqual(health.json.capabilities, { metrics: METRICS_CAPABILITY });
  assert.equal(health.json.protocolVersion, 2);
  assert.equal(health.json.minAppProtocolVersion, 2);
  const response = await f.call('GET', '/v1/metrics', undefined, HEADERS);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { cpuPercent: 75, memoryPercent: 72.5, diskPercent: 60, measuredAt: 1_700_000_000_000 });
});

test('/v1/metrics needs the key and the protocol header like the other /v1 reads', async (t) => {
  const f = await start(t, undefined, { metrics: metricsWith(fakeReader()) });
  assert.equal((await f.call('GET', '/v1/metrics', undefined, {})).status, 401);
  assert.equal((await f.call('GET', '/v1/metrics', undefined, { Authorization: 'Bearer rly1_wrong' })).status, 401);
  assert.equal((await f.call('GET', '/v1/metrics', undefined, AUTH)).status, 426);
});

test('a reader that does not work on this platform: no advertisement and no endpoint', async (t) => {
  const f = await start(t, undefined, { metrics: metricsWith(fakeReader({ supported: false })) });
  assert.deepEqual((await f.call('GET', '/health', undefined, {})).json.capabilities, {});
  assert.equal((await f.call('GET', '/v1/metrics', undefined, HEADERS)).status, 404);
});

test('a failed read answers a generic error, and the log has no paths nor values', async (t) => {
  const statfs = async (path: string) => { throw Object.assign(new Error(`ENOENT: no such file or directory, statfs '${path}'`), { code: 'ENOENT', path }); };
  const failing = await start(t, undefined, { metrics: metricsWith(fakeReader({ statfs })) });
  const failure = await failing.call('GET', '/v1/metrics', undefined, HEADERS);
  assert.equal(failure.status, 503);
  assert.deepEqual(failure.json, { error: { code: 'metrics_unavailable', message: 'No se pudieron leer las métricas del Servidor. Reintenta.' } });
  assert.ok(!failure.text.includes('.hermes'), failure.text);

  const working = await start(t, undefined, { metrics: metricsWith(fakeReader()) });
  assert.equal((await working.call('GET', '/v1/metrics', undefined, HEADERS)).status, 200);
  const lines = [...failing.logs, ...working.logs];
  assert.deepEqual(lines.map((line) => line.replace(/ \d+ms$/, '')), ['GET /v1/metrics 503', 'GET /v1/metrics 200']);
  for (const secret of ['.hermes', 'statfs', '75', '72.5', '60', '1700000000000']) {
    assert.ok(!lines.some((line) => line.replace(/ \d+ms$/, '').includes(secret)), `${secret} in ${lines.join(' | ')}`);
  }
});
