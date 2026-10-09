import http from 'node:http';
import { once } from 'node:events';
import { hashDeviceKey } from '../src/auth.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from '../support/discoveryHttpFixture.ts';
import { createDiscovery } from '../src/discovery.ts';
test('discovery only probes validated same-tailnet peers and returns public protocol metadata', async (t) => {
  const calls: string[] = [];
  const discovery = createDiscovery({ port: 17651, exec: async (file, args) => {
    assert.equal(file, 'tailscale'); assert.deepEqual(args, ['status', '--json']);
    return { code: 0, stderr: '', stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'self.fixture.ts.net.' }, Peer: {
      a: { DNSName: 'other.fixture.ts.net.', TailscaleIPs: ['100.64.0.2'] },
      b: { DNSName: 'evil.other.ts.net.', TailscaleIPs: ['100.64.0.3'] },
      c: { DNSName: 'lan.fixture.ts.net.', TailscaleIPs: ['192.168.0.1'] },
      d: { DNSName: '127.0.0.1', TailscaleIPs: ['100.64.0.4'] },
    } }) };
  }, probe: async (url, address) => { calls.push(url); assert.equal(address, '100.64.0.2'); return { ok: true, service: 'relayd', version: 'synthetic', protocolVersion: 2, minAppProtocolVersion: 2 }; } });
  const f = await start(t, discovery);
  assert.equal((await f.call('GET', '/v1/discovery', undefined, {})).status, 401);
  assert.deepEqual(calls, []);
  const response = await f.call('GET', '/v1/discovery');
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['http://other.fixture.ts.net:17651/health']);
  assert.equal(response.json.bridges[0].url, 'http://other.fixture.ts.net:17651');
  assert.equal(response.json.bridges[0].protocolVersion, 2);
});

test('revocation during discovery discards results before response', async (t) => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const discovery = { discover: async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { bridges: [], truncated: false }; } };
  const f = await start(t, discovery);
  const pending = f.call('GET', '/v1/discovery'); await started;
  await f.store.mutate(state => { state.devices[0].revokedAt = 1_700_000_000_001; });
  release(); assert.equal((await pending).status, 403);
});

test('discovery errors never expose subprocess output', async (t) => {
  const f = await start(t, { discover: async () => { throw new Error('synthetic-private-token'); } });
  const result = await f.call('GET', '/v1/discovery');
  assert.equal(result.status, 503); assert.ok(!result.text.includes('synthetic-private-token'));
  assert.ok(!f.logs.join('').includes('synthetic-private-token'));
});

test('discovery caps peers and concurrency and preserves incompatible and legacy metadata', async t => {
  let active = 0; let maximum = 0; let count = 0;
  const discovery = createDiscovery({ port: 17651, exec: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'self.fixture.ts.net' }, Peer: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i, { DNSName: `peer${i}.fixture.ts.net`, TailscaleIPs: ['100.64.0.2'] }])) }) }),
    probe: async () => { const index = count++; active++; maximum = Math.max(active, maximum); await new Promise(resolve => setTimeout(resolve, 2)); active--; return index === 0 ? { ok: true, service: 'relayd' } : { ok: true, service: 'relayd', protocolVersion: 99, minAppProtocolVersion: 99 }; } });
  const f = await start(t, discovery); const response = await f.call('GET', '/v1/discovery');
  assert.equal(response.status, 200); assert.equal(response.json.truncated, true);
  assert.equal(count, 24); assert.equal(maximum, 4);
  assert.equal(response.json.bridges[0].protocolVersion, null);
  assert.equal(response.json.bridges[1].protocolVersion, 99);
});


function cancellableSearch() {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const secondConsumer = Promise.withResolvers<void>(); let consumers = 0;
  const releases: (() => void)[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const shared = createDiscovery({ port: 17651,
    exec: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'self.fixture.ts.net' }, Peer: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i, { DNSName: `peer${i}.fixture.ts.net`, TailscaleIPs: ['100.64.0.2'] }])) }) }),
    probe: async (_url, _address, signal?: AbortSignal) => {
      signals.push(signal);
      if (signals.length === 4) entered();
      await new Promise<void>(resolve => { releases.push(resolve); });
      return { ok: true, service: 'relayd', protocolVersion: 2, minAppProtocolVersion: 2 };
    },
  });
  // discover() registers its consumer synchronously, so the second call is the moment both are joined.
  const discovery = { discover: (signal?: AbortSignal) => { if (++consumers === 2) secondConsumer.resolve(); return shared.discover(signal); } };
  return { discovery, started, secondConsumer: secondConsumer.promise, signals, release: () => { for (const release of releases.splice(0)) release(); } };
}

for (const reason of ['disconnect', 'revoke'] as const) {
  test(`discovery stops queued probes when the last consumer ${reason}s`, async t => {
    const search = cancellableSearch();
    const f = await start(t, search.discovery);
    let request: http.ClientRequest | undefined;
    const pending = reason === 'revoke' ? f.call('GET', '/v1/discovery') : new Promise<void>(resolve => {
      request = http.get(f.base + '/v1/discovery', { headers: { Authorization: `Bearer rly1_${Buffer.alloc(32, 7).toString('base64url')}` } });
      request.on('error', () => resolve());
    });
    void pending.catch(() => {});
    await search.started;
    if (reason === 'revoke') await f.store.mutate(state => { state.devices[0].revokedAt = 1_700_000_000_001; });
    else request!.destroy();
    // The server sees the socket close on its own schedule; release probes only once that cancelled the search.
    // Every probe shares the search signal; a missing cancellation leaves this wait (and the test) unresolved.
    if (!search.signals[0]!.aborted) await once(search.signals[0]!, 'abort');
    search.release();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(search.signals.length, 4, 'Cancelled consumers must not launch queued probes');
    assert.ok(search.signals.every(signal => signal?.aborted), 'In-flight probes must receive cancellation');
    if (reason === 'revoke') assert.equal((await pending)?.status, 403);
    else await pending;
  });
}

test('shared discovery continues for a valid consumer and excludes a revoked consumer', async t => {
  const search = cancellableSearch();
  const f = await start(t, search.discovery);
  const key = `rly1_${Buffer.alloc(32, 8).toString('base64url')}`;
  await f.store.mutate(state => { state.devices.push({ id: '00000000-0000-4000-8000-000000000002', name: 'second synthetic phone', pairedAt: 1_700_000_000_000, revokedAt: null, keyHash: hashDeviceKey(key).toString('hex') }); });
  const first = f.call('GET', '/v1/discovery');
  void first.catch(() => {});
  await search.started;
  const second = f.call('GET', '/v1/discovery', undefined, { Authorization: `Bearer ${key}` });
  void second.catch(() => {});
  await search.secondConsumer;
  await f.store.mutate(state => { state.devices[0].revokedAt = 1_700_000_000_001; });
  let timer!: ReturnType<typeof setTimeout>;
  let revoked: Awaited<ReturnType<typeof f.call>>;
  try {
    revoked = await Promise.race([first, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Revoked consumer did not detach')), 500); })]);
  } finally { clearTimeout(timer); }
  assert.equal(revoked.status, 403); assert.ok(!revoked.text.includes('peer'));
  assert.ok(search.signals.every(signal => !signal?.aborted));
  search.release();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(search.signals.length, 8);
  search.release();
  const valid = await second;
  assert.equal(valid.status, 200); assert.equal(valid.json.bridges.length, 8);
});


test('revocation during tailnet status cancels the command and never begins probes', async t => {
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let signal: AbortSignal | undefined; let probes = 0;
  const discovery = createDiscovery({ port: 17651, exec: async (_file, _args, options) => {
    signal = options.signal; entered();
    await new Promise<void>(resolve => { release = resolve; });
    return { code: 0, stderr: '', stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'self.fixture.ts.net' }, Peer: { a: { DNSName: 'peer.fixture.ts.net', TailscaleIPs: ['100.64.0.2'] } } }) };
  }, probe: async () => { probes++; return { ok: true, service: 'relayd' }; } });
  const f = await start(t, discovery);
  const pending = f.call('GET', '/v1/discovery'); void pending.catch(() => {});
  await started;
  await f.store.mutate(state => { state.devices[0].revokedAt = 1_700_000_000_001; });
  assert.equal(signal?.aborted, true);
  release();
  assert.equal((await pending).status, 403);
  assert.equal(probes, 0);
});


test('a disconnect while authorization is pending never starts discovery', async t => {
  let searches = 0;
  const f = await start(t, { discover: async () => { searches++; return { bridges: [], truncated: false }; } });
  let entered!: () => void; let release!: () => void; let held = false;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  const mutate = f.store.mutate;
  const delayed: typeof f.store.mutate = async fn => {
    if (!held) { held = true; entered(); await paused; }
    return mutate(fn);
  };
  // Storage is the controlled boundary; authorization and the HTTP route remain real.
  t.mock.method(f.store, 'mutate', delayed);
  const request = http.get(f.base + '/v1/discovery', { headers: { Authorization: `Bearer rly1_${Buffer.alloc(32, 7).toString('base64url')}` } });
  request.on('error', () => {});
  await started; request.destroy();
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(searches, 0, 'A departed consumer must not start a new search');
});
