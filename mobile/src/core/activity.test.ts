import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAT_PROTOCOL_HEADER, PROTOCOL_VERSION } from '../../../protocol/protocol.ts';
import { createBridgeClient } from './bridgeClient.ts';
import { appendActivityPage, ACTIVITY_VISIBLE_LIMIT, ACTIVITY_RESPONSE_BYTES } from './activity.ts';
import { readActivityResponse } from './activityTransport.ts';
import { activityActorLabel, activityTone, activityDay } from './activityPresentation.ts';
import type { ActivityPage, ActivityQuery } from '../../../protocol/activity.ts';
const at = 1_700_000_000_000;
const item = { id: 'event-1', at, actor: { kind: 'device', id: 'synthetic-device' }, action: 'job.run', category: 'tasks', result: 'requested', scope: { kind: 'agent', agentId: 'dev' }, conversationId: 'conversation-A' };
test('Activity bridge reads exact filters and normalizes only allowed metadata without inventing success', async () => {
  let observed = ''; let headers = new Headers();
  const client = createBridgeClient({ baseUrl: 'http://synthetic.fixture.ts.net:17651', key: 'synthetic-key', fetch: (async (url: string, init?: RequestInit) => {
    observed = url; headers = new Headers(init?.headers);
    return new Response(JSON.stringify({ items: [{ ...item, command: 'hidden-command', deviceName: 'hidden-device', message: 'hidden-message', ip: 'hidden-ip' }], capturedAt: at, nextCursor: 'opaque-cursor-1', secret: 'hidden-secret' }));
  }) as typeof fetch });
  const activity = (client as unknown as { activity?: (query: ActivityQuery) => Promise<ActivityPage> }).activity;
  assert.equal(typeof activity, 'function', 'The real RelayClient must support Activity');
  const page = await activity!({ agentId: 'dev', category: 'tasks', failuresOnly: false });
  assert.equal(observed, 'http://synthetic.fixture.ts.net:17651/v1/activity?limit=50&agentId=dev&category=tasks');
  assert.equal(headers.get(CHAT_PROTOCOL_HEADER), String(PROTOCOL_VERSION)); assert.equal(headers.get('Authorization'), 'Bearer synthetic-key');
  assert.deepEqual(page, { items: [item], capturedAt: at, nextCursor: 'opaque-cursor-1' });
  assert.ok(!JSON.stringify(page).includes('hidden-'));
  assert.equal(page.items[0].result, 'requested');
});

test('Activity transport bounds response bytes and preserves only safe endpoint error causes', async () => {
  const client = (response: Response) => createBridgeClient({ baseUrl: 'http://synthetic.fixture.ts.net:17651', key: 'synthetic-key', fetch: (async () => response) as typeof fetch });
  await assert.rejects(client(new Response(JSON.stringify({ error: { code: 'activity_cursor_expired', message: 'private-error-fragment' } }), { status: 409 })).activity(), (error: unknown) => {
    const e = error as { code: string; message: string };
    assert.equal(e.code, 'activity_cursor_expired'); assert.ok(!e.message.includes('private-error-fragment')); return true;
  });
  await assert.rejects(client(new Response('unsupported-private-fragment', { status: 404 })).activity(), /Actualiza el Puente/);
  await assert.rejects(client(new Response(JSON.stringify({ items: [{ ...item, extra: 'x'.repeat(300000) }], capturedAt: at, nextCursor: null }))).activity(), /Actividad/);
});

test('Activity demo uses the same metadata contract, fixed per-Server snapshots and honest failure outcomes', async () => {
  const { createDemoClient, resetDemo } = await import('./demo.ts'); resetDemo();
  const client = createDemoClient('atlas', () => at);
  assert.equal(typeof client.activity, 'function', 'Demo must implement the real Activity contract');
  const first = await client.activity({ limit: 3 });
  assert.equal(first.items.length, 3); assert.ok(first.nextCursor);
  const all = await client.activity();
  assert.ok(all.items.filter(row => row.action.startsWith('job.')).every(row => row.result === 'requested'), 'Current task audit producers only record requested operations');
  const next = await client.activity({ limit: 3, cursor: first.nextCursor! });
  assert.equal(first.capturedAt, next.capturedAt);
  assert.equal(new Set([...first.items, ...next.items].map(item => item.id)).size, 6);
  const failures = await client.activity({ failuresOnly: true });
  assert.deepEqual([...new Set(failures.items.map(item => item.result))].sort(), ['failed', 'rejected', 'uncertain']);
  assert.ok(failures.items.every(item => !('command' in item) && !('message' in item) && !('deviceName' in item)));
});

test('Activity rejects foreign scopes, unsafe references, unknown enums and successes in a failures-only query', async () => {
  for (const change of [{ action: 'private-command' }, { result: 'invented' }, { scope: { kind: 'agent', agentId: '../private' } }, { actor: { kind: 'device', id: 'bad/id' } }, { conversationId: '../../private' }, { at: -1 }]) {
    const client = createBridgeClient({ baseUrl: 'http://synthetic.fixture.ts.net:17651', key: 'synthetic-key', fetch: (async () => new Response(JSON.stringify({ items: [{ ...item, ...change }], capturedAt: at, nextCursor: null }))) as typeof fetch });
    await assert.rejects(client.activity(), /Actividad/);
  }
  const client = createBridgeClient({ baseUrl: 'http://synthetic.fixture.ts.net:17651', key: 'synthetic-key', fetch: (async () => new Response(JSON.stringify({ items: [item], capturedAt: at, nextCursor: null }))) as typeof fetch });
  await assert.rejects(client.activity({ failuresOnly: true }), /Actividad/, 'A requested action must not appear among failures');
  await assert.rejects(client.activity({ agentId: 'other' }), /Actividad/);
  await assert.rejects(client.activity({ category: 'server' }), /Actividad/);
});


test('Activity pagination preserves fixed Server order, deduplicates, bounds retained rows and rejects stalled cursors', () => {
  const value = item as ActivityPage['items'][number];
  const first = { items: [value], capturedAt: at, nextCursor: 'c1' };
  const second = { items: [{ ...value, result: 'succeeded' as const }, { ...value, id: 'event-2', at: at + 86400000 }], capturedAt: at, nextCursor: 'c2' };
  const merged = appendActivityPage(first, second);
  assert.deepEqual(merged.items.map(row => [row.id, row.result]), [['event-1', 'requested'], ['event-2', 'requested']]);
  assert.equal(merged.capturedAt, at);
  assert.throws(() => appendActivityPage(first, { ...second, capturedAt: at + 1 }), /Actualiza/);
  assert.throws(() => appendActivityPage(first, { ...second, nextCursor: 'c1' }), /Actividad/);
  assert.throws(() => appendActivityPage(first, { ...second, items: [value] }), /Actividad/);
  const existing = Array.from({ length: ACTIVITY_VISIBLE_LIMIT - 1 }, (_, n) => ({ ...value, id: 'event-' + n }));
  const capped = appendActivityPage({ ...first, items: existing }, { ...second, items: [{ ...value, id: 'added-1' }, { ...value, id: 'added-2' }] });
  assert.equal(capped.items.length, 500); assert.equal(capped.nextCursor, null); assert.equal(capped.items.at(-1)!.id, 'added-1');
});

test('Activity invalid queries fail before transport and repeated/oversized pages never reach state', async () => {
  let calls = 0;
  const client = createBridgeClient({ baseUrl: 'http://synthetic.fixture.ts.net:17651', key: 'synthetic-key', fetch: (async () => { calls++; return new Response(JSON.stringify({ items: [item, item], capturedAt: at, nextCursor: null })); }) as typeof fetch });
  for (const query of [{ agentId: '../dev' }, { cursor: 'bad\n' }, { cursor: 'x'.repeat(2049) }, { limit: 101 }, { limit: 0 }]) await assert.rejects(client.activity(query), /filtro/);
  assert.equal(calls, 0); await assert.rejects(client.activity(), /Actividad/); assert.equal(calls, 1);
});

test('Activity reader bounds actual streamed bytes, cancels on timeout and rejects oversized Content-Length before reading', async () => {
  let cancelled = 0; let reads = 0;
  const response = (read: () => Promise<ReadableStreamReadResult<Uint8Array>>, length?: number) => ({ status: 200, ok: true, headers: new Headers(length ? { 'Content-Length': String(length) } : {}), body: { getReader: () => ({ read, cancel: async () => { cancelled++; }, releaseLock() {} }) } }) as unknown as Response;
  await assert.rejects(readActivityResponse(response(async () => { reads++; return { done: false, value: new Uint8Array(ACTIVITY_RESPONSE_BYTES + 1) }; }), {}, 100), /Actividad/);
  assert.equal(reads, 1); assert.equal(cancelled, 1);
  await assert.rejects(readActivityResponse(response(async () => { reads++; return { done: true, value: undefined }; }, ACTIVITY_RESPONSE_BYTES + 1), {}, 100), /Actividad/);
  assert.equal(reads, 1);
  await assert.rejects(readActivityResponse(response(() => new Promise(() => {})), {}, 5), /Sin respuesta/);
  assert.equal(cancelled, 2);
});

test('Activity presentation distinguishes requested, accepted, uncertain and rejection without exposing actor IDs', () => {
  assert.equal(activityTone('requested'), 'orange'); assert.equal(activityTone('accepted'), 'orange'); assert.equal(activityTone('uncertain'), 'orange'); assert.equal(activityTone('succeeded'), 'green');
  assert.equal(activityActorLabel(item as ActivityPage['items'][number], 'synthetic-device'), 'Este dispositivo');
  assert.equal(activityActorLabel(item as ActivityPage['items'][number], 'different'), 'Otro dispositivo');
  assert.equal(activityActorLabel({ ...item, actor: { kind: 'server' } } as ActivityPage['items'][number]), 'Puente');
  assert.equal(activityDay(Date.parse('2026-10-04T00:01:00Z')), activityDay(Date.parse('2026-10-04T23:59:00Z')));
});

test('Activity demo exposes every endpoint state, independent Server clocks, fixed capture, TTL and restart invalidation', async () => {
  const { createDemoClient, resetDemo, setDemoActivityScenario, setDemoConnection, DEMO_ACTIVITY_SCENARIOS } = await import('./demo.ts'); resetDemo();
  setDemoConnection('homelab', 'compatible'); let now = at; const client = createDemoClient('atlas', () => now); const other = createDemoClient('homelab', () => now);
  for (const scenario of DEMO_ACTIVITY_SCENARIOS) {
    if (scenario.id === 'loading') continue;
    setDemoActivityScenario('atlas', scenario.id);
    if (['error', 'offline', 'unsupported', 'busy'].includes(scenario.id)) await assert.rejects(client.activity());
    else { const page = await client.activity(); if (scenario.id === 'empty') assert.equal(page.items.length, 0); else assert.ok(page.items.length > 0); }
  }
  setDemoActivityScenario('atlas', 'partial'); setDemoActivityScenario('homelab', 'partial'); assert.ok((await client.activity()).items.length); await assert.rejects(other.activity());
  setDemoActivityScenario('atlas', 'clock-skew'); setDemoActivityScenario('homelab', 'clock-skew'); assert.equal((await other.activity()).capturedAt - (await client.activity()).capturedAt, 2 * 86400000);
  setDemoActivityScenario('atlas', 'normal'); let first = await client.activity({ limit: 3 }); now += 300000;
  assert.equal((await client.activity({ limit: 3, cursor: first.nextCursor! })).capturedAt, first.capturedAt);
  now += 300000; await assert.rejects(client.activity({ limit: 3, cursor: first.nextCursor! }), /caducó/);
  first = await client.activity({ limit: 3 }); resetDemo(); await assert.rejects(client.activity({ limit: 3, cursor: first.nextCursor! }), /caducó/);
});


test('Activity accepts the backend identifier bounds and safe recorded Conversation references', async () => {
  const agentId = 'a'.repeat(256); const conversationId = 'synthetic: conversación'; let observed = '';
  const client = createBridgeClient({ baseUrl: 'http://synthetic.fixture.ts.net:17651', key: 'synthetic-key', fetch: (async url => { observed = String(url); return new Response(JSON.stringify({ items: [{ ...item, scope: { kind: 'agent', agentId }, conversationId }], capturedAt: at, nextCursor: null })); }) as typeof fetch });
  const page = await client.activity({ agentId }); assert.equal(page.items[0].scope.kind, 'agent'); assert.equal(page.items[0].conversationId, conversationId); assert.ok(observed.endsWith('&agentId=' + agentId));
  await assert.rejects(client.activity({ agentId: 'a'.repeat(257) }), /filtro/);
});


test('Activity DTO composes all new producer outcomes while stripping private fields and preserving references', async () => {
  const rows = [
    ['personality.preset.create', 'configuration', 'requested'], ['personality.preset.create', 'configuration', 'succeeded'],
    ['personality.preset.update', 'configuration', 'requested'], ['personality.preset.update', 'configuration', 'succeeded'],
    ['personality.preset.delete', 'configuration', 'requested'], ['personality.preset.delete', 'configuration', 'succeeded'],
    ['personality.soul.apply', 'configuration', 'requested'], ['personality.soul.apply', 'configuration', 'recorded'],
    ['conversation.personality.change', 'conversations', 'recorded'], ['notification.registration', 'server', 'requested'],
  ].map(([action, category, result], index) => ({ ...item, id: 'new-event-' + index, action, category, result,
    scope: action.startsWith('personality.preset.') || action === 'notification.registration' ? { kind: 'server' } : item.scope,
    conversationId: action === 'conversation.personality.change' ? 'conversation-A' : null }));
  const client = createBridgeClient({ baseUrl: 'http://synthetic.fixture.ts.net:17651', key: 'synthetic-key', fetch: (async () => new Response(JSON.stringify({
    items: rows.map(row => ({ ...row, presetId: 'private-preset-uuid', name: 'private-preset-name', soul: 'private-soul-body', actor: { ...row.actor, name: 'private-actor-name' } })), capturedAt: at, nextCursor: null,
  }))) as typeof fetch });
  assert.deepEqual(await client.activity(), { items: rows, capturedAt: at, nextCursor: null });
});

test('Activity rejects fabricated new-event categories, scopes, results and preset Conversation links', async () => {
  const preset = { ...item, action: 'personality.preset.create', category: 'configuration', result: 'requested', scope: { kind: 'server' }, conversationId: null };
  const soul = { ...item, action: 'personality.soul.apply', category: 'configuration', result: 'recorded', conversationId: null };
  const conversation = { ...item, action: 'conversation.personality.change', category: 'conversations', result: 'recorded' };
  const registration = { ...preset, action: 'notification.registration', category: 'server' };
  for (const row of [
    { ...preset, category: 'server' }, { ...preset, scope: item.scope, conversationId: 'preset-uuid' }, { ...preset, result: 'recorded' },
    { ...soul, scope: { kind: 'server' } }, { ...soul, conversationId: 'preset-uuid' }, { ...soul, result: 'succeeded' },
    { ...conversation, result: 'succeeded' }, { ...conversation, conversationId: null }, { ...conversation, category: 'configuration' },
    { ...registration, result: 'succeeded' }, { ...registration, scope: item.scope }, { ...registration, action: 'notification.unknown' },
  ]) {
    const client = createBridgeClient({ baseUrl: 'http://synthetic.fixture.ts.net:17651', key: 'synthetic-key', fetch: (async () => new Response(JSON.stringify({ items: [item, { ...row, id: 'new-event-invalid' }], capturedAt: at, nextCursor: null }))) as typeof fetch });
    await assert.rejects(client.activity(), /Actividad/, JSON.stringify(row));
  }
});

test('Activity composition demo enumerates the ten real new outcomes with honest filters and pagination', async () => {
  const { createDemoClient, resetDemo, setDemoActivityScenario } = await import('./demo.ts'); resetDemo();
  setDemoActivityScenario('atlas', 'composition'); const client = createDemoClient('atlas', () => at);
  const all = await client.activity(); assert.equal(all.items.length, 10);
  assert.deepEqual(all.items.map(row => [row.action, row.result]), [
    ['personality.preset.create', 'requested'], ['personality.preset.create', 'succeeded'],
    ['personality.preset.update', 'requested'], ['personality.preset.update', 'succeeded'],
    ['personality.preset.delete', 'requested'], ['personality.preset.delete', 'succeeded'],
    ['personality.soul.apply', 'requested'], ['personality.soul.apply', 'recorded'],
    ['conversation.personality.change', 'recorded'], ['notification.registration', 'requested'],
  ]);
  assert.equal((await client.activity({ category: 'configuration' })).items.length, 8);
  assert.equal((await client.activity({ category: 'conversations' })).items.length, 1);
  assert.equal((await client.activity({ category: 'server' })).items.length, 1);
  assert.equal((await client.activity({ agentId: 'dev' })).items.length, 3);
  assert.equal((await client.activity({ failuresOnly: true })).items.length, 0);
  const first = await client.activity({ limit: 4 }); const next = await client.activity({ limit: 4, cursor: first.nextCursor! });
  assert.deepEqual([...first.items, ...next.items], all.items.slice(0, 8));
});
