import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createDiscovery, probeHealth } from '../src/discovery.ts';
import { start } from '../support/discoveryHttpFixture.ts';

test('HTTP discovery probe sends only public health, rejects redirects, oversized bodies and timeout', async t => {
  let mode = 'normal'; const received: http.IncomingHttpHeaders[] = [];
  const candidate = http.createServer((req, res) => {
    received.push(req.headers); assert.equal(req.url, '/health');
    if (mode === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1/private' }).end(); return; }
    if (mode === 'oversized') { res.end('x'.repeat(4097)); return; }
    if (mode === 'timeout') return;
    res.end(JSON.stringify({ ok: true, service: 'relayd', protocolVersion: 2, minAppProtocolVersion: 2 }));
  });
  await new Promise<void>(resolve => candidate.listen(0, '127.0.0.1', resolve));
  t.after(() => { candidate.closeAllConnections(); candidate.close(); });
  const original = http.get;
  t.mock.method(http, 'get', ((url: URL, options: http.RequestOptions, callback: Parameters<typeof http.get>[2]) => {
    assert.equal(url.href, 'http://peer.fixture.ts.net:17651/health');
    assert.equal(options.headers, undefined); assert.equal(options.agent, false);
    let pinned: unknown;
    const lookup = options.lookup as (host: string, options: { all: boolean }, callback: (...args: unknown[]) => void) => void;
    lookup(url.hostname, { all: true }, (...args) => { pinned = args; });
    assert.deepEqual(pinned, [null, [{ address: '100.64.0.2', family: 4 }]]);
    // Transport boundary redirects the synthetic candidate to a local ephemeral server.
    return original(`http://127.0.0.1:${(candidate.address() as AddressInfo).port}/health`, { agent: false }, callback);
  }) as typeof http.get);
  const discovery = createDiscovery({ port: 17651, exec: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'self.fixture.ts.net' }, Peer: { a: { DNSName: 'peer.fixture.ts.net', TailscaleIPs: ['100.64.0.2'] } } }) }) });
  const f = await start(t, discovery);
  assert.equal((await f.call('GET', '/v1/discovery')).json.bridges.length, 1);
  for (mode of ['redirect', 'oversized', 'timeout']) assert.deepEqual((await f.call('GET', '/v1/discovery')).json.bridges, []);
  assert.equal(received.length, 4);
  for (const headers of received) { assert.equal(headers.authorization, undefined); assert.equal(headers.cookie, undefined); }
});


test('cancelling a public health probe closes the synthetic HTTP connection', async t => {
  let arrived!: () => void; let closed!: () => void;
  const started = new Promise<void>(resolve => { arrived = resolve; });
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const candidate = http.createServer((_req, res) => { res.on('close', closed); arrived(); });
  await new Promise<void>(resolve => candidate.listen(0, '127.0.0.1', resolve));
  t.after(() => { candidate.closeAllConnections(); candidate.close(); });
  const original = http.get;
  t.mock.method(http, 'get', ((_url: URL, options: http.RequestOptions, callback: Parameters<typeof http.get>[2]) => original(`http://127.0.0.1:${(candidate.address() as AddressInfo).port}/health`, { agent: false, signal: options.signal }, callback)) as typeof http.get);
  const controller = new AbortController();
  const probing = probeHealth('http://peer.fixture.ts.net:17651/health', '100.64.0.2', controller.signal);
  void probing.catch(() => {});
  await started; controller.abort();
  let timer!: ReturnType<typeof setTimeout>;
  try {
    await assert.rejects(Promise.race([probing, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Cancellation was ignored')), 300); })]), /Health unavailable/);
  } finally { clearTimeout(timer); }
  await disconnected;
});
