import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBridgeClient, normalizeBaseUrl } from './bridgeClient.ts';
import { RelayError, type RelayClient } from './client.ts';
import { cleartextWillBeBlocked, describeConnection, testConnection, describeDown } from './connection.ts';
import { createDemoClient, resetDemo } from './demo.ts';
import { createSseDecoder } from './sse.ts';
import { applyRunEvent, buildBlocks, toneLine } from './transcript.ts';
import type { ChatRunEvent, TranscriptItem } from '../../../protocol/protocol.ts';

// ---------------------------------------------------------------- SSE

test('sse decoder emits one payload per event, across arbitrary chunk boundaries', () => {
  const got: string[] = [];
  const d = createSseDecoder((s) => got.push(s));
  d.push('data: {"a":1}\n\n: keepalive\n\nda');
  d.push('ta: {"b":2}\r\n\r\nevent: x\ndata: one\ndata: two\n\n');
  d.end();
  assert.deepEqual(got, ['{"a":1}', '{"b":2}', 'one\ntwo']);
});

test('sse decoder flushes a trailing event without a blank line on end()', () => {
  const got: string[] = [];
  const d = createSseDecoder((s) => got.push(s));
  d.push('data: tail\n');
  assert.deepEqual(got, []);
  d.end();
  assert.deepEqual(got, ['tail']);
});

// ---------------------------------------------------------------- bridge client

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return handler({ url, init });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('normalizeBaseUrl uses HTTP for tailnet names, HTTPS for other hosts and drops trailing slashes', () => {
  // A tailnet name without a scheme means the bridge's plain HTTP (decision in issue #11).
  assert.equal(normalizeBaseUrl(' atlas.tailnet-7f2c.ts.net:8650/ '), 'http://atlas.tailnet-7f2c.ts.net:8650');
  assert.equal(normalizeBaseUrl('hermes.example.dev'), 'https://hermes.example.dev');
  assert.equal(normalizeBaseUrl('https://atlas.tailnet-7f2c.ts.net'), 'https://atlas.tailnet-7f2c.ts.net');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8650'), 'http://127.0.0.1:8650');
  assert.equal(normalizeBaseUrl(''), '');
});

test('normalizeBaseUrl checks the parsed hostname rather than suffixes in a query or path', () => {
  assert.equal(normalizeBaseUrl('evil.com?.ts.net'), 'https://evil.com?.ts.net');
  assert.equal(normalizeBaseUrl('evil.com\\.ts.net'), 'https://evil.com\\.ts.net');
  assert.equal(normalizeBaseUrl('atlas.tailnet.ts.net:8650'), 'http://atlas.tailnet.ts.net:8650');
  assert.equal(normalizeBaseUrl('not a host'), 'https://not a host');
});


test('authenticated routes send the bearer key; /health and /v1/whoami do not', async () => {
  const f = fakeFetch(() => jsonRes({ agents: [], ok: true }));
  const c = createBridgeClient({ baseUrl: 'http://h:1/', key: 'k'.repeat(32), fetch: f.fn });
  await c.agents();
  await c.health();
  await c.whoami();
  const auth = (i: number) => (f.calls[i].init.headers as Record<string, string>).Authorization;
  assert.equal(f.calls[0].url, 'http://h:1/v1/agents');
  assert.equal(auth(0), `Bearer ${'k'.repeat(32)}`);
  assert.equal(auth(1), undefined);
  assert.equal(auth(2), undefined);
});

test('fetch is never called as a method: the browser fetch throws "Illegal invocation" on a foreign this', async () => {
  const seen: unknown[] = [];
  function strictFetch(this: unknown) {
    seen.push(this);
    return Promise.resolve(new Response('data: {"type":"run.cancelled"}\n\n', { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  const c = createBridgeClient({ baseUrl: 'http://h:1', key: 'k', fetch: strictFetch as unknown as typeof fetch });
  await c.health().catch(() => {});
  await c.runEvents('r1', () => {});
  assert.deepEqual(seen, [undefined, undefined]);
});

test('decide posts the choice to the approval route', async () => {
  const f = fakeFetch(() => jsonRes({ ok: true }));
  const c = createBridgeClient({ baseUrl: 'http://h:1', key: 'k', fetch: f.fn });
  await c.decide('ap/1', 'session');
  assert.equal(f.calls[0].url, 'http://h:1/v1/approvals/ap%2F1');
  assert.equal(f.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[0].init.body as string), { choice: 'session' });
});

test('logs passes level and line count as query', async () => {
  const f = fakeFetch(() => jsonRes({ lines: [] }));
  const c = createBridgeClient({ baseUrl: 'http://h:1', key: 'k', fetch: f.fn });
  await c.logs('WARN', 50);
  await c.logs(null);
  assert.equal(f.calls[0].url, 'http://h:1/v1/logs?lines=50&level=WARN');
  assert.equal(f.calls[1].url, 'http://h:1/v1/logs?lines=100');
});

test('401 becomes unauthorized, 503 unavailable, network failure unreachable', async () => {
  const mk = (h: () => Response | Promise<Response>) => createBridgeClient({ baseUrl: 'http://h:1', key: 'k', fetch: fakeFetch(h).fn });
  await assert.rejects(mk(() => jsonRes({ error: { code: 'unauthorized', message: 'bad key' } }, 401)).server(), (e) => {
    assert.ok(e instanceof RelayError);
    assert.equal(e.code, 'unauthorized');
    assert.equal(e.status, 401);
    assert.equal(e.message, 'bad key');
    return true;
  });
  await assert.rejects(mk(() => jsonRes({ error: { code: 'unavailable', message: 'api server off' } }, 503)).agents(), (e) => {
    assert.ok(e instanceof RelayError);
    assert.equal(e.code, 'unavailable');
    return true;
  });
  await assert.rejects(
    mk(() => {
      throw new TypeError('fetch failed');
    }).server(),
    (e) => e instanceof RelayError && e.code === 'unreachable',
  );
});

// What expo/fetch rejects with on Android when the network security config forbids http:// to a host.
// Copied from logcat of the release APK (issue #15); OkHttp raises it before any packet leaves.
const cleartextError = (host: string) =>
  new Error(`fetch failed: java.net.UnknownServiceException: CLEARTEXT communication to ${host} not permitted by network security policy`);

test("Android's cleartext block is its own error, not unreachable, on requests and on the event stream", async () => {
  const blocked = createBridgeClient({
    baseUrl: 'http://100.64.0.10:8650',
    key: 'k',
    fetch: fakeFetch(() => {
      throw cleartextError('100.64.0.10');
    }).fn,
  });
  const isBlock = (e: unknown) => {
    assert.ok(e instanceof RelayError);
    assert.equal(e.code, 'cleartext_blocked');
    // screens print the message as is: it must name the cause, not the Java exception
    assert.equal(e.message, 'Android bloquea http:// fuera de *.ts.net');
    return true;
  };
  await assert.rejects(blocked.server(), isBlock);
  await assert.rejects(blocked.whoami(), isBlock);
  await assert.rejects(blocked.runEvents('r1', () => {}), isBlock);
});

test('other network failures stay unreachable, even when they mention the policy in passing', async () => {
  for (const message of ['fetch failed: java.net.ConnectException: Failed to connect to /100.64.0.10:8650', 'Network request failed', 'cleartext']) {
    const c = createBridgeClient({
      baseUrl: 'http://h:1',
      key: 'k',
      fetch: fakeFetch(() => {
        throw new Error(message);
      }).fn,
    });
    await assert.rejects(c.server(), (e) => e instanceof RelayError && e.code === 'unreachable');
  }
});

test('a request that outlives the timeout is reported as timeout', async () => {
  const f = fakeFetch(
    ({ init }) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
  );
  const c = createBridgeClient({ baseUrl: 'http://h:1', key: 'k', fetch: f.fn, timeoutMs: 20 });
  await assert.rejects(c.server(), (e) => e instanceof RelayError && e.code === 'timeout');
});

test('runEvents streams parsed events and skips malformed frames', async () => {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(enc.encode('data: {"type":"message.delta","text":"ho"}\n\ndata: not json\n\n'));
      ctrl.enqueue(enc.encode('data: {"type":"run.completed","output":"hola"}\n\n'));
      ctrl.close();
    },
  });
  const f = fakeFetch(() => new Response(body, { status: 200 }));
  const c = createBridgeClient({ baseUrl: 'http://h:1', key: 'k', fetch: f.fn });
  const events: ChatRunEvent[] = [];
  await c.runEvents('r1', (e) => events.push(e));
  assert.deepEqual(events, [
    { type: 'message.delta', text: 'ho' },
    { type: 'run.completed', output: 'hola' },
  ]);
  assert.equal(f.calls[0].url, 'http://h:1/v1/runs/r1/events');
});

// ---------------------------------------------------------------- connection test

const stub = (server: RelayClient['server']) => ({ server }) as unknown as RelayClient;

test('testConnection classifies ok / bad key / unreachable and words them like the design', async () => {
  let t = 1000;
  const clock = () => (t += 42);
  const ok = await testConnection(
    stub(async () => ({ host: 'arch', hermesVersion: '0.21.5', profiles: 3, chat: { available: false, reason: 'off' } })),
    clock,
  );
  assert.deepEqual(ok, { kind: 'ok', latencyMs: 42, hermesVersion: '0.21.5', profiles: 3 });
  assert.deepEqual(describeConnection(ok), { title: 'CONEXIÓN OK', sub: '42 MS · HERMES 0.21.5 · 3 PERFILES', tone: 'green' });

  const bad = await testConnection(stub(async () => Promise.reject(new RelayError('unauthorized', 'x', 401))));
  assert.deepEqual(bad, { kind: 'bad_key', status: 401 });
  assert.equal(describeConnection(bad).title, 'API KEY INVÁLIDA');
  assert.equal(describeConnection(bad).tone, 'red');

  const gone = await testConnection(stub(async () => Promise.reject(new RelayError('timeout', 'x'))));
  assert.deepEqual(gone, { kind: 'unreachable', timeoutSeconds: 5 });
  assert.equal(describeConnection(gone).title, 'SERVIDOR INALCANZABLE');
  assert.equal(describeConnection(gone).tone, 'off');
});

test('testConnection reports a cleartext block as such and words the real cause', async () => {
  const blocked = await testConnection(stub(async () => Promise.reject(new RelayError('cleartext_blocked', 'x'))));
  assert.deepEqual(blocked, { kind: 'cleartext_blocked' });
  assert.deepEqual(describeConnection(blocked), {
    title: 'HTTP BLOQUEADO POR ANDROID',
    sub: 'LA APP SOLO ADMITE HTTP:// PARA NOMBRES *.TS.NET · USA EL NOMBRE DE TAILNET O HTTPS://',
    tone: 'red',
  });
  // the old wording blamed a timeout and Tailscale
  assert.doesNotMatch(describeConnection(blocked).sub, /TIMEOUT|TAILSCALE/);
});

test('cleartextWillBeBlocked flags http:// URLs whose host is not under ts.net', () => {
  const blocked = [
    'http://100.64.0.10:8650',
    'http://arch:8650',
    'http://192.168.1.10:8650',
    'http://localhost:8650',
    'http://example.com',
    'HTTP://Example.com/',
    'http://evil-ts.net',
    'http://ts.net.evil.com',
    'http://arch.tail0a1b2c.ts.net.evil.com:8650',
    'http://user@100.64.0.10:8650',
    'http://[fd7a:115c:a1e0::1]:8650',
    '  http://100.64.0.10:8650/  ',
  ];
  for (const url of blocked) assert.equal(cleartextWillBeBlocked(url), true, url);

  const allowed = [
    'http://arch.tail0a1b2c.ts.net:8650',
    'http://ARCH.Tail0a1b2c.TS.NET:8650/',
    'http://arch.tail0a1b2c.ts.net',
    'http://ts.net',
    'https://100.64.0.10:8650',
    'https://example.com',
    // A tailnet name without a scheme uses HTTP (normalizeBaseUrl).
    'arch.tail0a1b2c.ts.net:8650',
    '100.64.0.10:8650',
    '',
    '   ',
    'http://',
  ];
  for (const url of allowed) assert.equal(cleartextWillBeBlocked(url), false, url);
});

// ---------------------------------------------------------------- transcript


test('a result Hermes cut at 500 chars still yields readable output, and its tool status decides the block', () => {
  const cut = '{"output": "09:01:40\\n=== parar ===\\nactive", "exit_co';
  const mk = (id: string, status: 'done' | 'error'): TranscriptItem => ({
    kind: 'tool', id, tool: 'terminal', preview: 'date', status, durationSeconds: null, result: cut, at: 0,
  });
  assert.deepEqual(buildBlocks([mk('fine', 'done')], false).map((b) => b.kind), ['activity']);
  const blocks = buildBlocks([mk('bad', 'error')], false);
  const term = blocks[1];
  assert.ok(term.kind === 'terminal');
  assert.equal(term.end, 'failed');
  assert.deepEqual(term.lines.map((l) => l.map((x) => x.text).join('')), ['$ date', '09:01:40', '=== parar ===', 'active']);
});

test('only failing commands get a terminal block; successful ones stay in the activity list', () => {
  const term = (id: string, exit: number): TranscriptItem => ({
    kind: 'tool', id, tool: 'terminal', preview: 'ls', status: exit ? 'error' : 'done', durationSeconds: 1,
    result: JSON.stringify({ output: 'x', exit_code: exit }), at: 0,
  });
  const blocks = buildBlocks([term('ok', 0), term('bad', 2)], false);
  assert.deepEqual(blocks.map((b) => b.kind), ['activity', 'terminal']);
  assert.equal(blocks[1].id, 'bad:term');
});

test('toneLine colors failures and passes inside one line', () => {
  assert.deepEqual(toneLine('1 failed · 23 passed'), [
    { text: '1 failed', tone: 'fail', glow: false },
    { text: ' · ', tone: 'plain' },
    { text: '23 passed', tone: 'ok', glow: true },
  ]);
  assert.deepEqual(toneLine('FAIL src/db/client.test.ts'), [
    { text: 'FAIL', tone: 'fail', glow: true },
    { text: ' src/db/client.test.ts', tone: 'plain' },
  ]);
  assert.deepEqual(toneLine('TypeError: createPool is not a fn'), [{ text: 'TypeError: createPool is not a fn', tone: 'fail', glow: false }]);
});

test('assistant Markdown preserves the original text, including code indentation and boundary newlines', () => {
  const blocks = buildBlocks([{ kind: 'assistant', id: 'a1', text: '\n\nListo. El comando corrió.\n', at: 0 }], false);
  assert.ok(blocks[0].kind === 'text');
  assert.equal(blocks[0].text, '\n\nListo. El comando corrió.\n');
});

test('a new user message starts a new activity panel', () => {
  const tool = (id: string): TranscriptItem => ({ kind: 'tool', id, tool: 'read_file', preview: 'a.ts', status: 'done', durationSeconds: 1, result: null, at: 0 });
  const blocks = buildBlocks([{ kind: 'user', id: 'u1', text: 'a', at: 0 }, tool('t1'), { kind: 'user', id: 'u2', text: 'b', at: 0 }, tool('t2')], false);
  assert.deepEqual(blocks.map((b) => b.kind), ['user', 'activity', 'user', 'activity']);
});

test('applyRunEvent folds a live run into the transcript', () => {
  let items: TranscriptItem[] = [{ kind: 'user', id: 'u1', text: 'hola', at: 0 }];
  const feed = (e: ChatRunEvent) => (items = applyRunEvent(items, e, 5));
  feed({ type: 'message.delta', text: 'Voy' });
  feed({ type: 'message.delta', text: ' a ello.' });
  feed({ type: 'tool.started', toolCallId: 'c1', tool: 'terminal', preview: 'rm -rf ./build' });
  assert.equal(items.length, 3);
  assert.equal(items[1].kind === 'assistant' && items[1].text, 'Voy a ello.');

  feed({ type: 'approval.request', approval: { id: 'ap1' } as never });
  assert.equal(items[2].kind === 'tool' && items[2].status, 'waiting');

  feed({ type: 'approval.resolved', approvalId: 'ap1', choice: 'once' });
  assert.equal(items[2].kind === 'tool' && items[2].status, 'running');

  feed({ type: 'tool.completed', toolCallId: 'c1', tool: 'terminal', durationSeconds: 0.2, error: false, preview: '{"output":"","exit_code":0}' });
  const t = items[2];
  assert.ok(t.kind === 'tool');
  assert.deepEqual([t.status, t.durationSeconds], ['done', 0.2]);

  feed({ type: 'run.completed', output: 'Listo.' });
  assert.equal(items[items.length - 1].kind === 'assistant' && (items[items.length - 1] as { text: string }).text, 'Listo.');
});

test('a denied approval marks the waiting tool as failed', () => {
  let items: TranscriptItem[] = [
    { kind: 'tool', id: 'c1', tool: 'terminal', preview: 'rm -rf /', status: 'running', durationSeconds: null, result: null, at: 0 },
  ];
  items = applyRunEvent(items, { type: 'approval.request', approval: { id: 'ap1', expiresAt: null } as never }, 0);
  items = applyRunEvent(items, { type: 'approval.resolved', approvalId: 'ap1', choice: 'deny' }, 1);
  assert.equal(items[0].kind === 'tool' && items[0].status, 'error');
});

// ---------------------------------------------------------------- demo world

test('deciding the demo approval empties the inbox and updates the agent', async () => {
  resetDemo();
  const c = createDemoClient('atlas');
  const [ap] = await c.approvals();
  assert.equal(ap.command, 'rm -rf ./build');
  assert.equal((await c.agents())[0].status, 'busy');
  await c.decide(ap.id, 'once');
  assert.deepEqual((await c.approvals()).map((approval) => approval.id), ['ap-demo-2']);
  const dev = (await c.agents())[0];
  assert.deepEqual([dev.status, dev.pendingApprovals], ['on', 0]);
});

test('the unreachable demo server times out on every call', async () => {
  const c = createDemoClient('homelab');
  await assert.rejects(c.agents(), (e) => e instanceof RelayError && e.code === 'timeout');
});

test('a server that stops answering says why, when the app knows why', () => {
  assert.deepEqual(describeDown(new RelayError('cleartext_blocked', 'x')), {
    label: 'HTTP BLOQUEADO',
    hint: 'Android solo admite http:// para nombres *.ts.net.',
  });
  assert.deepEqual(describeDown(new RelayError('unauthorized', 'x', 401)), {
    label: 'LLAVE RECHAZADA',
    hint: 'El servidor ya no acepta la API key guardada.',
  });
  assert.deepEqual(describeDown(new RelayError('timeout', 'x')), { label: 'SIN RESPUESTA', hint: null });
  assert.deepEqual(describeDown(new TypeError('boom')), { label: 'SIN RESPUESTA', hint: null });
});
