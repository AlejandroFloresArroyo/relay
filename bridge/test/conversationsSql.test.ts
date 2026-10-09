import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { HermesError } from '../src/hermes.ts';
import { withFileNotes } from '../../protocol/chatFiles.ts';
import { RealHermes } from '../src/hermes_real.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createConversationStore } from '../src/conversationStore.ts';
import { ConversationService } from '../src/conversations.ts';
import { CODING_KEY, createHermesHome, DEFAULT_KEY, writeStateDb } from '../support/hermes_home.ts';

function setup(t: TestContext, fetchFn?: typeof fetch, apiPort?: number | null) {
  const fixture = createHermesHome({ apiPort });
  t.after(() => fixture.cleanup());
  const hermes = new RealHermes({ home: fixture.home, bin: '/unused', procRoot: fixture.procRoot,
    exec: async () => { throw new Error('CLI must not be called'); },
    fetch: fetchFn ?? (async () => { throw new Error('HTTP must not be called'); }) });
  return { fixture, hermes, file: path.join(fixture.home, 'state.db') };
}
const fails = (code: string) => (error: unknown) => error instanceof HermesError && error.code === code;

test('#39 an image-only user retains its stable database message identity even when Hermes stores no text', async (t) => {
  const { hermes, file } = setup(t);
  writeStateDb(file, [{ id: 'image-only', source: 'api_server', startedAt: 1 }], [{ session: 'image-only', role: 'user', content: '', at: 2 }]);
  const items = (await hermes.transcript('default', 'image-only')).items;
  assert.deepEqual(items, [{ kind: 'user', id: '1', text: '', at: 2000 }]);
});

test('automatic families retain root origin and include inherited markers without absorbing forks', async (t) => {
  const { hermes, file } = setup(t);
  writeStateDb(file, [
    { id: 'origin', source: 'discord', startedAt: 1, endReason: 'compression', hidden: 1, archived: 1 },
    { id: 'tip', source: 'discord', startedAt: 2, parent: 'origin', endReason: 'compression', modelConfig: { _branched_from: 'older-ancestor' } },
    { id: 'tip2', source: 'discord', startedAt: 3, parent: 'tip', modelConfig: { _branched_from: 'older-ancestor' } },
    { id: 'branch', source: 'discord', startedAt: 4, parent: 'origin', modelConfig: { _branched_from: 'origin' } },
    { id: 'reset', source: 'discord', startedAt: 5, parent: 'origin', modelConfig: { _reset_from: 'origin' } },
    { id: 'delegate', source: 'discord', startedAt: 6, parent: 'origin', modelConfig: { _delegate_from: 'origin' } },
    { id: 'cron', source: 'cron', startedAt: 7 },
    { id: 'tool', source: 'tool', startedAt: 8, parent: 'origin' },
    { id: 'other-source', source: 'cli', startedAt: 9, parent: 'origin' },
  ], [
    { session: 'origin', role: 'user', content: 'first', at: 1 },
    { session: 'tip', role: 'assistant', content: 'second', at: 2 },
    { session: 'tip2', role: 'assistant', content: 'newest', at: 20 },
    { session: 'tip2', role: 'assistant', content: 'inactive', at: 21, active: 0 },
    { session: 'tip2', role: 'assistant', content: 'summary', at: 22, compressedSummary: 1 },
  ]);
  const family = await hermes.getConversation('default', 'origin');
  assert.equal(family?.id, 'origin');
  assert.equal(family?.sessionId, 'tip2');
  assert.equal(family?.source, 'discord');
  assert.equal(family?.hidden, true);
  assert.equal(family?.archived, true);
  assert.equal(family?.messageCount, 5);
  assert.deepEqual(family?.sessionIds, ['origin', 'tip', 'tip2']);
  assert.equal((await hermes.getConversation('default', 'tip2'))?.id, 'origin');
  assert.deepEqual((await hermes.listConversations('default')).conversations.map((c) => c.id), ['origin', 'other-source', 'reset', 'branch']);
  assert.deepEqual((await hermes.listConversations('default', { background: true })).conversations.map((conversation) => conversation.id), ['tool', 'cron', 'delegate']);
  const transcript = await hermes.transcript('default', null);
  assert.equal(transcript.sessionId, 'tip2');
  assert.deepEqual(transcript.items.map((item) => item.kind === 'tool' ? item.preview : item.text), ['first', 'second', 'newest']);
  assert.deepEqual(await hermes.lastMessage('default'), { text: 'newest', at: 20_000 });
});

test('literal Unicode search matches visible text and titles, not tool arguments or image URLs; pages count families', async (t) => {
  const { hermes, file } = setup(t);
  writeStateDb(file, [
    { id: 'a', source: 'cli', startedAt: 1, title: 'CAFÉ 100%_ seguro', endReason: 'compression' },
    { id: 'a-tip', source: 'cli', startedAt: 2, parent: 'a' },
    { id: 'b', source: 'telegram', startedAt: 3, title: 'ÉXITO' },
    { id: 'c', source: 'api_server', startedAt: 4 },
    { id: 'noise', source: 'cron', startedAt: 100, title: 'ÉXITO' },
  ], [
    { session: 'a', role: 'user', content: 'éxito antiguo', at: 2 },
    { session: 'a-tip', role: 'assistant', content: 'ÉXITO reciente', at: 30 },
    { session: 'b', role: 'assistant', content: 'text', at: 20 },
    { session: 'c', role: 'assistant', content: JSON.stringify([{ type: 'text', text: "ÉXITO ' OR 1=1 --" }, { type: 'image_url', image_url: { url: 'secret-image-location' } }]), at: 10,
      toolCalls: [{ id: 'tool1', name: 'terminal', args: { command: 'hidden-tool-argument' } }] },
    { session: 'c', role: 'tool', content: 'hidden-tool-result', toolCallId: 'tool1', at: 11 },
    { session: 'c', role: 'assistant', content: 'inactive-needle', at: 12, active: 0 },
    { session: 'c', role: 'assistant', content: 'summary-needle', at: 13, compressedSummary: 1 },
  ]);
  const first = await hermes.searchConversations('default', { q: 'éXiTo', limit: 1 });
  assert.deepEqual(first.hits.map((hit) => [hit.conversation.id, hit.match, hit.messageId]), [['a', 'message', '2']]);
  assert.equal(first.nextOffset, 1);
  const second = await hermes.searchConversations('default', { q: 'éxito', limit: 1, offset: 1 });
  assert.deepEqual(second.hits.map((hit) => [hit.conversation.id, hit.match]), [['b', 'title']]);
  assert.equal(second.nextOffset, 2);
  const third = await hermes.searchConversations('default', { q: 'éxito', limit: 1, offset: 2 });
  assert.equal(third.hits[0].conversation.id, 'c');
  assert.equal(third.nextOffset, null);
  assert.deepEqual((await hermes.searchConversations('default', { q: 'éxito', background: true })).hits.map((hit) => hit.conversation.id), ['noise']);
  assert.deepEqual((await hermes.searchConversations('default', { q: '100%_' })).hits.map((hit) => hit.conversation.id), ['a']);
  assert.deepEqual((await hermes.searchConversations('default', { q: "' OR 1=1 --" })).hits.map((hit) => hit.conversation.id), ['c']);
  for (const q of ['secret-image-location', 'hidden-tool-argument', 'hidden-tool-result', 'inactive-needle', 'summary-needle']) {
    assert.equal((await hermes.searchConversations('default', { q })).hits.length, 0);
  }
  const page = await hermes.listConversations('default', { limit: 2 });
  assert.deepEqual(page.conversations.map((conversation) => conversation.id), ['a', 'b']);
  assert.equal(page.nextOffset, 2);
  assert.deepEqual((await hermes.listConversations('default', { limit: 2, offset: 2 })).conversations.map((conversation) => conversation.id), ['c']);
});

test('ambiguous continuations and non-compression children remain separate; cycles fail closed', async (t) => {
  const { hermes, file } = setup(t);
  writeStateDb(file, [
    { id: 'relay-root', source: 'api_server', startedAt: 1, endReason: 'compression' },
    { id: 'first', source: 'api_server', startedAt: 2, parent: 'relay-root' },
    { id: 'second', source: 'api_server', startedAt: 3, parent: 'relay-root' },
    { id: 'ordinary', source: 'cli', startedAt: 4, endReason: 'reset' },
    { id: 'child', source: 'cli', startedAt: 5, parent: 'ordinary' },
  ], []);
  assert.deepEqual((await hermes.getConversation('default', 'relay-root'))?.sessionIds, ['relay-root']);
  assert.equal((await hermes.getConversation('default', 'relay-root'))?.continuationUncertain, true);
  assert.equal((await hermes.getConversation('default', 'first'))?.continuationUncertain, false);
  assert.equal((await hermes.getConversation('default', 'first'))?.id, 'first');
  assert.equal((await hermes.getConversation('default', 'second'))?.id, 'second');
  assert.equal((await hermes.getConversation('default', 'child'))?.id, 'child');
  const writer = new DatabaseSync(file);
  writer.exec("UPDATE sessions SET parent_session_id = 'first' WHERE id = 'relay-root'");
  writer.close();
  await assert.rejects(hermes.listConversations('default'), fails('chat_unavailable'));
  await assert.rejects(hermes.transcript('default', 'first'), fails('chat_unavailable'));
});

test('missing profiles are empty without creating a database; incompatible and unreadable stores fail content-free', async (t) => {
  const { hermes, fixture, file } = setup(t);
  assert.deepEqual(await hermes.listConversations('default'), { conversations: [], nextOffset: null });
  assert.equal(await hermes.getConversation('default', 'missing'), null);
  assert.deepEqual(await hermes.searchConversations('default', { q: 'anything' }), { hits: [], nextOffset: null });
  assert.deepEqual(await hermes.transcript('default', null), { sessionId: null, items: [] });
  assert.equal(await hermes.lastMessage('default'), null);
  assert.equal(fs.existsSync(file), false);
  const incompatible = new DatabaseSync(file);
  incompatible.exec('CREATE TABLE sessions (id TEXT); CREATE TABLE messages (id INTEGER)');
  incompatible.close();
  for (const operation of [
    () => hermes.listConversations('default'), () => hermes.getConversation('default', 'missing'),
    () => hermes.searchConversations('default', { q: 'secret' }), () => hermes.transcript('default', null),
    () => hermes.lastMessage('default'), () => hermes.deletionPreview('default', 'missing'),
  ]) await assert.rejects(operation(), (error: unknown) => {
    assert.ok(error instanceof HermesError);
    assert.equal(error.code, 'chat_unavailable');
    assert.equal(error.message, 'The Hermes conversation store is unavailable.');
    return true;
  });
  fixture.write('state.db', 'not-a-database secret-profile-content');
  await assert.rejects(hermes.listConversations('default'), fails('chat_unavailable'));
});

test('complete family transcript is chronological and latest selection has a deterministic ID tie breaker', async (t) => {
  const { hermes, file } = setup(t);
  writeStateDb(file, [
    { id: 'a-root', source: 'cli', startedAt: 1, endReason: 'compression' },
    { id: 'a-tip', source: 'cli', startedAt: 2, parent: 'a-root' },
    { id: 'z-root', source: 'discord', startedAt: 1, hidden: 1, archived: 1 },
  ], [
    ...Array.from({ length: 620 }, (_, i) => ({ session: i < 310 ? 'a-root' : 'a-tip', role: i % 2 ? 'assistant' : 'user', content: `message-${i}`, at: i + 1 })),
    { session: 'z-root', role: 'assistant', content: 'tie winner', at: 620 },
  ]);
  const transcript = await hermes.transcript('default', 'a-root');
  assert.equal(transcript.items.length, 620);
  assert.equal(transcript.sessionId, 'a-tip');
  assert.equal(transcript.items[0].kind === 'user' && transcript.items[0].text, 'message-0');
  assert.equal(transcript.items[619].kind === 'assistant' && transcript.items[619].text, 'message-619');
  assert.equal((await hermes.transcript('default', null)).sessionId, 'z-root');
  assert.deepEqual((await hermes.listConversations('default')).conversations.map((conversation) => conversation.id), ['z-root', 'a-root']);
  await assert.rejects(hermes.transcript('default', 'absent'), fails('conversation_not_found'));
});

test('live WAL writes change recency, physical counts and revisions for content, role, metadata and family edits', async (t) => {
  const { hermes, file } = setup(t);
  writeStateDb(file, [{ id: 'root', source: 'api_server', startedAt: 1 }, { id: 'other', source: 'cli', startedAt: 2 }], [
    { session: 'root', role: 'user', content: 'initial private content', at: 1 },
  ], { wal: true });
  const writer = new DatabaseSync(file);
  try {
    writer.exec('PRAGMA wal_autocheckpoint = 0');
    const initial = await hermes.deletionPreview('default', 'root');
    writer.prepare('INSERT INTO messages(session_id,role,content,timestamp,active,_compressed_summary) VALUES (?,?,?,?,?,?)').run('root', 'assistant', 'committed WAL text', 20, 1, 0);
    assert.equal((await hermes.transcript('default', null)).sessionId, 'root');
    assert.equal((await hermes.searchConversations('default', { q: 'wal TEXT' })).hits[0].conversation.id, 'root');
    const appended = await hermes.deletionPreview('default', 'root');
    assert.equal(appended.messageCount, 2);
    assert.notEqual(appended.revision, initial.revision);
    assert.notEqual(appended.sessionRevisions?.root, initial.sessionRevisions?.root);
    let revision = appended.revision;
    for (const sql of [
      "UPDATE messages SET content='edited private content' WHERE id=1",
      "UPDATE messages SET role='assistant' WHERE id=1",
      "UPDATE messages SET reasoning='private hidden reasoning' WHERE id=1",
      "UPDATE messages SET active=0 WHERE id=1",
      "UPDATE messages SET _compressed_summary=1 WHERE id=2",
      "UPDATE sessions SET title='Renamed',hidden=1,archived=1 WHERE id='root'",
      "UPDATE sessions SET model_config='{\"browser_model_lock\":{\"model\":\"changed\"}}' WHERE id='root'",
    ]) {
      writer.exec(sql);
      const current = await hermes.deletionPreview('default', 'root');
      assert.notEqual(current.revision, revision);
      assert.equal(current.messageCount, 2);
      assert.equal(current.revision.includes('private'), false);
      revision = current.revision;
    }
    writer.exec("UPDATE sessions SET end_reason='compression',ended_at=21 WHERE id='root'");
    writer.prepare('INSERT INTO sessions(id,source,parent_session_id,started_at) VALUES (?,?,?,?)').run('next', 'api_server', 'root', 22);
    const continued = await hermes.deletionPreview('default', 'root');
    assert.notEqual(continued.revision, revision);
    assert.deepEqual((await hermes.getConversation('default', 'root'))?.sessionIds, ['root', 'next']);
    assert.equal((await hermes.getConversation('default', 'root'))?.sessionId, 'next');
  } finally { writer.close(); }
});

test('deletion preview includes exact recursive API delegate cascades and all physical messages but not orphaned branches', async (t) => {
  const { hermes, file } = setup(t);
  writeStateDb(file, [
    { id: 'root', source: 'cli', startedAt: 1, endReason: 'compression' },
    { id: 'tip', source: 'cli', startedAt: 2, parent: 'root' },
    { id: 'delegate', source: 'subagent', startedAt: 3, parent: 'root', modelConfig: { _delegate_from: 'root' } },
    { id: 'nested', source: 'subagent', startedAt: 4, parent: 'delegate', modelConfig: { _delegate_from: 'delegate' } },
    { id: 'inherited', source: 'subagent', startedAt: 5, parent: 'delegate', modelConfig: { _delegate_from: 'old-ancestor' } },
    { id: 'marker-only', source: 'subagent', startedAt: 6, modelConfig: { _delegate_from: 'tip' } },
    { id: 'branch', source: 'cli', startedAt: 7, parent: 'root', modelConfig: { _branched_from: 'root' } },
    { id: 'untagged', source: 'cli', startedAt: 8, parent: 'delegate' },
  ], [
    { session: 'root', role: 'user', content: 'visible', at: 1 },
    { session: 'root', role: 'assistant', content: 'inactive', at: 2, active: 0 },
    { session: 'tip', role: 'assistant', content: 'summary', at: 3, compressedSummary: 1 },
    { session: 'delegate', role: 'tool', content: 'tool result', at: 4 },
    { session: 'nested', role: 'assistant', content: 'nested', at: 5 },
    { session: 'inherited', role: 'assistant', content: 'inherited', at: 6 },
    { session: 'marker-only', role: 'assistant', content: 'marker-only', at: 7 },
    { session: 'branch', role: 'assistant', content: 'survives', at: 8 },
    { session: 'untagged', role: 'assistant', content: 'survives too', at: 9 },
  ]);
  const preview = await hermes.deletionPreview('default', 'root');
  assert.deepEqual(preview.sessionIds, ['tip', 'root', 'delegate', 'inherited', 'marker-only', 'nested']);
  assert.equal(preview.messageCount, 7);
  assert.equal(preview.conversationCount, 5);
  assert.equal((await hermes.getConversation('default', 'root'))?.messageCount, 3);
  assert.equal(Object.keys(preview.sessionRevisions ?? {}).length, 6);
  assert.match(preview.revision, /^[a-f0-9]{64}$/);
  const writer = new DatabaseSync(file);
  writer.prepare("UPDATE sessions SET model_config=? WHERE id='branch'").run(JSON.stringify({ _reset_from: 'root' }));
  writer.close();
  assert.notEqual((await hermes.deletionPreview('default', 'root')).revision, preview.revision);
});

test('session mutations use authenticated profile API and exact creation receipts with content-free failures', async (t) => {
  const calls: { method: string; url: string; auth: string | undefined; body: unknown }[] = [];
  let mode: 'success' | 'wrong-id' | 'bad-json' | 'invalid-title' | 'auth' | 'conflict' | 'failed-delete' | 'missing' | 'failure' | 'bad-status' = 'success';
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    calls.push({ method: request.method ?? '', url: request.url ?? '', auth: request.headers.authorization, body: body ? JSON.parse(body) : null });
    response.setHeader('Content-Type', 'application/json');
    if (mode === 'auth' || mode === 'invalid-title' || mode === 'conflict' || mode === 'missing' || mode === 'failure') {
      response.statusCode = mode === 'auth' ? 401 : mode === 'invalid-title' ? 400 : mode === 'conflict' ? 409 : mode === 'missing' ? 404 : 500;
      response.end(JSON.stringify({ error: { code: 'invalid_title', message: 'upstream-private-content secret-value' } }));
    } else if (mode === 'bad-json') response.end('not JSON upstream-private-content');
    else if (request.method === 'POST') {
      response.statusCode = mode === 'bad-status' ? 200 : 201;
      response.end(JSON.stringify({ session: { id: mode === 'wrong-id' ? 'somebody-else' : 'chosen-id' } }));
    } else if (request.method === 'DELETE') response.end(JSON.stringify({ id: 'external-id', deleted: mode !== 'failed-delete' }));
    else response.end(JSON.stringify({ session: { id: 'external-id' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { hermes } = setup(t, fetch, address.port);
  await hermes.createConversation('coding', 'chosen-id');
  await hermes.renameConversation('coding', 'external-id', 'Nombre nuevo');
  await hermes.deleteSession('coding', 'external-id');
  assert.deepEqual(calls, [
    { method: 'POST', url: '/p/coding/api/sessions', auth: `Bearer ${CODING_KEY}`, body: { id: 'chosen-id', source: 'api_server' } },
    { method: 'PATCH', url: '/p/coding/api/sessions/external-id', auth: `Bearer ${CODING_KEY}`, body: { title: 'Nombre nuevo' } },
    { method: 'DELETE', url: '/p/coding/api/sessions/external-id', auth: `Bearer ${CODING_KEY}`, body: null },
  ]);
  await hermes.createConversation('default', 'chosen-id');
  assert.equal(calls.at(-1)?.auth, `Bearer ${DEFAULT_KEY}`);
  assert.equal(calls.at(-1)?.url, '/api/sessions');
  for (const nextMode of ['wrong-id', 'bad-json', 'conflict', 'bad-status'] as const) {
    mode = nextMode;
    await assert.rejects(hermes.createConversation('coding', 'chosen-id'), fails('operation_uncertain'));
  }
  mode = 'invalid-title';
  await assert.rejects(hermes.renameConversation('coding', 'external-id', 'Duplicate'), (error: unknown) => {
    assert.ok(error instanceof HermesError);
    assert.equal(error.code, 'invalid_title');
    assert.equal(/upstream-private-content|secret-value/.test(error.message), false);
    return true;
  });
  const count = calls.length;
  await assert.rejects(hermes.renameConversation('coding', 'external-id', 'x'.repeat(101)), fails('invalid_title'));
  assert.equal(calls.length, count);
  mode = 'auth';
  await assert.rejects(hermes.renameConversation('coding', 'external-id', 'Title'), fails('upstream_failure'));
  mode = 'failed-delete';
  await assert.rejects(hermes.deleteSession('coding', 'external-id'), fails('operation_uncertain'));
  mode = 'bad-json';
  await assert.rejects(hermes.deleteSession('coding', 'external-id'), fails('operation_uncertain'));
  mode = 'missing';
  await assert.rejects(hermes.renameConversation('coding', 'external-id', 'Title'), fails('conversation_not_found'));
  await assert.rejects(hermes.deleteSession('coding', 'external-id'), fails('conversation_not_found'));
  mode = 'failure';
  await assert.rejects(hermes.createConversation('coding', 'chosen-id'), fails('upstream_failure'));
  await assert.rejects(hermes.renameConversation('coding', 'external-id', 'Title'), fails('upstream_failure'));
  await assert.rejects(hermes.deleteSession('coding', 'external-id'), fails('upstream_failure'));
  mode = 'success';
  await hermes.renameConversation('coding', 'external-id', '😀'.repeat(100));
});

test('lost mutation responses never leak upstream details or confirm an uncertain operation', async (t) => {
  const { hermes } = setup(t, async () => { throw new Error('private-upstream-response'); });
  await assert.rejects(hermes.createConversation('coding', 'chosen-id'), fails('operation_uncertain'));
  await assert.rejects(hermes.deleteSession('coding', 'external-id'), fails('operation_uncertain'));
  await assert.rejects(hermes.renameConversation('coding', 'external-id', 'Title'), (error: unknown) => {
    assert.ok(error instanceof HermesError);
    assert.equal(error.code, 'upstream_failure');
    assert.equal(error.message.includes('private-upstream-response'), false);
    return true;
  });
});

test('known missing API configuration remains definitively unavailable before creation attempts', async (t) => {
  let calls = 0;
  const { hermes } = setup(t, async () => {
    calls += 1;
    throw new Error('HTTP must not be attempted');
  }, null);
  await assert.rejects(hermes.createConversation('default', 'chosen-id'), (error: unknown) => {
    assert.ok(error instanceof HermesError);
    assert.equal(error.code, 'unavailable');
    assert.match(error.message, /API_SERVER_KEY/);
    return true;
  });
  assert.equal(calls, 0);
});

test('continuation uncertainty propagates to the stable family root when its verified tip is ambiguous', async (t) => {
  const { hermes, file } = setup(t);
  writeStateDb(file, [
    { id: 'chain-root', source: 'api_server', startedAt: 1, endReason: 'compression' },
    { id: 'middle', source: 'api_server', startedAt: 2, parent: 'chain-root', endReason: 'compression' },
    { id: 'choice-a', source: 'api_server', startedAt: 3, parent: 'middle' },
    { id: 'choice-b', source: 'api_server', startedAt: 4, parent: 'middle' },
  ], []);
  const family = await hermes.getConversation('default', 'chain-root');
  assert.deepEqual(family?.sessionIds, ['chain-root', 'middle']);
  assert.equal(family?.sessionId, 'middle');
  assert.equal(family?.continuationUncertain, true);
  assert.equal((await hermes.getConversation('default', 'middle'))?.continuationUncertain, true);
  assert.equal((await hermes.getConversation('default', 'choice-a'))?.id, 'choice-a');
});

test('compacted display history stays searchable without exposing rewound rows or duplicating carried messages', async (t) => {
  const { hermes, file } = setup(t);
  writeStateDb(file, [
    { id: 'root', source: 'api_server', startedAt: 1, endReason: 'compression' },
    { id: 'tip', source: 'api_server', startedAt: 2, parent: 'root' },
  ], [
    { session: 'root', role: 'user', content: 'Consulta archivada sobre WAL', at: 1, active: 0 },
    { session: 'root', role: 'assistant', content: 'Texto rebobinado', at: 2, active: 0 },
    { session: 'root', role: 'user', content: 'Mensaje durante la compresión', at: 3 },
    { session: 'tip', role: 'user', content: 'Mensaje durante la compresión', at: 3 },
    { session: 'tip', role: 'assistant', content: 'Respuesta posterior', at: 4 },
  ]);
  const writer = new DatabaseSync(file);
  writer.exec("UPDATE messages SET compacted = 1 WHERE id = 1");
  writer.close();
  const archived = await hermes.searchConversations('default', { q: 'WAL' });
  assert.deepEqual(archived.hits.map((hit) => [hit.conversation.id, hit.match, hit.messageId]), [['root', 'message', '1']]);
  assert.equal((await hermes.searchConversations('default', { q: 'rebobinado' })).hits.length, 0);
  const transcript = await hermes.transcript('default', 'root');
  assert.deepEqual(transcript.items.filter((item) => item.kind !== 'tool').map((item) => item.text), [
    'Consulta archivada sobre WAL', 'Mensaje durante la compresión', 'Respuesta posterior',
  ]);
  assert.equal((await hermes.deletionPreview('default', 'root')).messageCount, 5);
});

test('presentation-hidden deliveries stay out of visible history and search but remain in deletion counts', async (t) => {
  const { hermes, file } = setup(t);
  writeStateDb(file, [{ id: 'root', source: 'api_server', startedAt: 1 }], [
    { session: 'root', role: 'assistant', content: 'Respuesta visible', at: 2 },
    { session: 'root', role: 'user', content: 'Entrega interna suprimida', at: 3 },
  ]);
  const writer = new DatabaseSync(file);
  writer.exec("UPDATE messages SET display_kind = 'hidden', display_metadata = '{\"presentation_suppressed\":true}' WHERE id = 2");
  writer.close();
  assert.deepEqual((await hermes.transcript('default', 'root')).items.map((item) => item.kind === 'tool' ? item.preview : item.text), ['Respuesta visible']);
  assert.deepEqual((await hermes.searchConversations('default', { q: 'suprimida' })).hits, []);
  assert.equal((await hermes.getConversation('default', 'root'))?.preview, 'Respuesta visible');
  assert.deepEqual(await hermes.lastMessage('default'), { text: 'Respuesta visible', at: 2000 });
  assert.equal((await hermes.deletionPreview('default', 'root')).messageCount, 2);
});

test('a creation receipt cannot authorize a root that Hermes can resume into an unverified descendant', async (t) => {
  const { hermes, fixture, file } = setup(t);
  writeStateDb(file, [
    { id: 'relay-root', source: 'api_server', startedAt: 1 },
    { id: 'unverified', source: 'api_server', startedAt: 2, parent: 'relay-root' },
    { id: 'compressed-root', source: 'api_server', startedAt: 3, endReason: 'compression' },
    { id: 'foreign-tip', source: 'cli', startedAt: 4, parent: 'compressed-root' },
    { id: 'safe-root', source: 'api_server', startedAt: 5 },
    { id: 'explicit-branch', source: 'api_server', startedAt: 6, parent: 'safe-root', modelConfig: { _branched_from: 'safe-root' } },
  ], [
    { session: 'relay-root', role: 'user', content: 'Own root', at: 1 },
    { session: 'unverified', role: 'user', content: 'Foreign continuation', at: 2 },
    { session: 'foreign-tip', role: 'user', content: 'Different source', at: 4 },
  ]);
  fs.mkdirSync(path.join(fixture.home, 'relay-fixture'), { mode: 0o700 });
  const deviceStore = await createDeviceStore({ directory: path.join(fixture.home, 'relay-fixture') });
  const receipts = await createConversationStore({ directory: deviceStore.directory, changeLog: deviceStore.changeLog });
  await receipts.mutate((state) => {
    for (const id of ['relay-root', 'compressed-root', 'safe-root']) state.conversations.push({
      agentId: 'default', id, createdAt: 1700000000000, createdByDeviceId: '00000000-0000-4000-8000-000000000029',
      createRequestId: id, state: 'ready', sessionIds: [id], model: null,
    });
  });
  const service = new ConversationService({ hermes, store: receipts, runs: { activeForConversation: () => false } });
  await assert.rejects(service.assertWritable('default', 'relay-root'), fails('operation_uncertain'));
  await assert.rejects(service.assertWritable('default', 'compressed-root'), fails('operation_uncertain'));
  assert.equal((await service.get('default', 'unverified')).writable, false);
  assert.equal((await service.assertWritable('default', 'safe-root')).sessionId, 'safe-root');
});

test('#42 readonly terminal history uses only exact top-level approval metadata correlated in the same session', async (t) => {
 const {hermes,file}=setup(t);
 const approved = 'Command was flagged (recursive delete) and auto-approved by smart approval.';
 const human = 'Command required approval (recursive delete) and was approved by the user.';
 writeStateDb(file,[{id:'discord-session',source:'discord',startedAt:1},{id:'cli-session',source:'cli',startedAt:1}], [
  {session:'discord-session',role:'assistant',content:null,at:1,toolCalls:[{id:'same-id',name:'terminal',args:{command:'rm -rf build'}}]},
  {session:'discord-session',role:'tool',toolName:'terminal',toolCallId:'same-id',content:JSON.stringify({output:human,exit_code:0,error:null,approval:approved}),at:2},
  {session:'cli-session',role:'assistant',content:null,at:3,toolCalls:[{id:'same-id',name:'terminal',args:{command:'echo unclassified'}}]},
  {session:'cli-session',role:'tool',toolName:'terminal',toolCallId:'same-id',content:JSON.stringify({output:approved,exit_code:0,error:null}),at:4},
  {session:'cli-session',role:'assistant',content:null,at:5,toolCalls:[{id:'blocked-id',name:'terminal',args:{command:'never executed'}}]},
  {session:'cli-session',role:'tool',toolName:'terminal',toolCallId:'blocked-id',content:JSON.stringify({status:'blocked',error:'timeout Guardian denied'}),at:6},
 ]);
 const history=await hermes.decisionHistory('default');
 assert.equal(history.length,2);
 assert.deepEqual(history.map(record=>[record.command,record.actor,record.outcome,record.at,record.timeKind,record.originLabel]), [['echo unclassified','unknown','executed',4000,'result','Terminal'],['rm -rf build','guardian','approved',2000,'result','Discord']]);
 assert.equal(history[0].origin,'other');
});

test('#114 the preview and a search snippet show a message without its file notes', async (t) => {
  const { hermes, file } = setup(t);
  const noted = withFileNotes('Resume el informe trimestral', ['/home/user/informe.pdf']);
  writeStateDb(file, [{ id: 'files', source: 'api_server', startedAt: 1 }], [{ session: 'files', role: 'user', content: noted, at: 2 }]);
  assert.equal((await hermes.getConversation('default', 'files'))?.preview, 'Resume el informe trimestral');
  assert.equal((await hermes.searchConversations('default', { q: 'trimestral' })).hits[0]?.snippet, 'Resume el informe trimestral');
});
test('#115 a title Hermes derived from a file note is no title, in the list and in title search', async (t) => {
  const { hermes, file } = setup(t);
  const noted = withFileNotes('Resume el informe trimestral', ['/home/user/informe.pdf']);
  writeStateDb(file, [
    // Hermes' derive_title: the first line, cut at a word within 48 characters, plus «…».
    { id: 'derived', source: 'api_server', startedAt: 1, title: '[The user attached a file that is on this…' },
    { id: 'whole', source: 'api_server', startedAt: 2, title: noted.split('\n')[0] },
    { id: 'named', source: 'api_server', startedAt: 3, title: 'Informe trimestral #2' },
    // Hermes numbers a colliding title in its lineage with « #N» (get_next_title_in_lineage).
    { id: 'numbered', source: 'api_server', startedAt: 4, title: '[The user attached a file that is on this… #2' },
  ], ['derived', 'whole', 'named', 'numbered'].map((session, index) => ({ session, role: 'user', content: noted, at: 10 + index })));
  assert.equal((await hermes.getConversation('default', 'derived'))?.title, null);
  assert.equal((await hermes.getConversation('default', 'whole'))?.title, null);
  assert.equal((await hermes.getConversation('default', 'numbered'))?.title, null);
  assert.equal((await hermes.getConversation('default', 'named'))?.title, 'Informe trimestral #2');
  const hits = (await hermes.searchConversations('default', { q: 'attached' })).hits;
  assert.deepEqual(hits.filter((hit) => hit.match === 'title').map((hit) => hit.conversation.id), []);
  assert.ok(hits.every((hit) => !hit.snippet.includes('[The user')));
});
