import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatRunEvent } from '../../../protocol/protocol.ts';
import { createBridgeClient } from './bridgeClient.ts';
import { RelayError } from './client.ts';
import { conversationRequestId } from './conversations.ts';
import { createDemoClient, resetDemo } from './demo.ts';
import { setDemoConversationScenario } from './demoConversations.ts';

const requestId = '12345678-1234-4234-8234-123456789abc';


test('conversation errors preserve Hermes messages, conflict codes and status through the public client', async () => {
  const replies = [new Response(JSON.stringify({ error: { code: 'upstream_failure', message: 'Hermes: title already exists' } }), { status: 502 }), new Response(JSON.stringify({ error: { code: 'conversation_changed', message: 'Hay mensajes nuevos' } }), { status: 409 })];
  const client = createBridgeClient({ baseUrl: 'http://fixture.test.ts.net', key: 'fixture', fetch: (async () => replies.shift()!) as typeof fetch });
  await assert.rejects(client.renameConversation('a', 'c', { title: 'Duplicado' }), (failure) => failure instanceof RelayError && failure.code === 'upstream_failure' && failure.status === 502 && failure.message === 'Hermes: title already exists');
  await assert.rejects(client.deleteConversation('a', 'c', { revision: 'old' }), (failure) => failure instanceof RelayError && failure.code === 'conversation_changed' && failure.status === 409);
});

test('creation request identities are distinct UUIDv4 values', () => {
  const first = conversationRequestId(); const second = conversationRequestId();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, second);
});

test('demo lists all interactive origins, hides background by default and opens each selected history read-only when external', async () => {
  resetDemo(); const client = createDemoClient('atlas', () => 1791028800000);
  const page = await client.conversations('dev');
  assert.equal(page.conversations[0].id, 'demo-dev');
  assert.equal(page.conversations.some((conversation) => conversation.kind === 'background'), false);
  const background = await client.conversations('dev', { background: true });
  assert.deepEqual(background.conversations.map((conversation) => conversation.originLabel), ['Tarea programada', 'Subagente']);
  const discord = await client.transcript('dev', 'demo-dev-discord');
  assert.equal(discord.conversation?.writable, false);
  assert.equal(discord.items.some((item) => item.kind === 'assistant' && item.text.includes('.nvmrc')), true);
  await assert.rejects(client.startRun('dev', { input: 'No debe salir', sessionId: 'demo-dev-discord' }), (failure) => failure instanceof RelayError && failure.code === 'conversation_read_only');
  assert.equal((await client.conversation('dev', 'demo-dev-legacy')).writable, false);
  assert.equal((await client.searchConversations('dev', { q: 'TLS interno' })).hits[0].match, 'message');
  assert.equal((await client.searchConversations('dev', { q: 'Migrar' })).hits[0].match, 'title');
  assert.equal((await client.searchConversations('dev', { q: 'kubernetes' })).hits.length, 0);
  const first = await client.conversations('dev', { limit: 2 });
  const second = await client.conversations('dev', { limit: 2, offset: first.nextOffset! });
  assert.deepEqual(second.conversations.map((conversation) => conversation.id), ['demo-dev-terminal', 'demo-dev-caddy']);
});

test('demo CRUD persists across clients, receipts are idempotent, titles stay unique and deletion revisions detect changes', async () => {
  resetDemo(); const client = createDemoClient('atlas', () => 1791028800000);
  const created = await client.createConversation('dev', { requestId });
  assert.equal((await client.createConversation('dev', { requestId })).id, created.id);
  const other = createDemoClient('atlas', () => 1791028800000);
  await client.renameConversation('dev', created.id, { title: 'Nueva investigación' });
  assert.equal((await other.conversation('dev', created.id)).title, 'Nueva investigación');
  await assert.rejects(client.renameConversation('dev', created.id, { title: 'Migrar a Node 22' }), (failure) => failure instanceof RelayError && failure.code === 'upstream_failure');
  await assert.rejects(client.renameConversation('dev', created.id, { title: 'x'.repeat(101) }), (failure) => failure instanceof RelayError && failure.code === 'invalid_title');
  const before = await client.conversationDeletion('dev', created.id);
  await client.renameConversation('dev', created.id, { title: 'Título cambiado' });
  await assert.rejects(client.deleteConversation('dev', created.id, { revision: before.revision }), (failure) => failure instanceof RelayError && failure.code === 'conversation_changed');
  const after = await other.conversationDeletion('dev', created.id);
  assert.equal((await client.deleteConversation('dev', created.id, { revision: after.revision })).messageCount, 0);
  await assert.rejects(other.conversation('dev', created.id), (failure) => failure instanceof RelayError && failure.code === 'conversation_not_found');
  const external = await other.conversationDeletion('dev', 'demo-dev-discord');
  assert.equal((await client.deleteConversation('dev', 'demo-dev-discord', { revision: external.revision })).messageCount, 1);
});

test('demo sends attach only to the selected conversation, protect a live turn and persist the completed history', async () => {
  resetDemo(); const client = createDemoClient('atlas', () => 1791028800000);
  const created = await client.createConversation('dev', { requestId });
  const run = await client.startRun('dev', { input: 'Mensaje nuevo', sessionId: created.sessionId });
  assert.equal(run.sessionId, created.sessionId);
  await assert.rejects(client.conversationDeletion('dev', created.id), (failure) => failure instanceof RelayError && failure.code === 'conversation_busy');
  const events: ChatRunEvent[] = [];
  await client.runEvents(run.runId, (event) => events.push(event));
  assert.equal(events.at(-1)?.type, 'run.completed');
  const transcript = await client.transcript('dev', created.sessionId);
  assert.equal(transcript.items.length, 2);
  assert.equal(transcript.items[0].kind === 'user' && transcript.items[0].text, 'Mensaje nuevo');
  assert.equal((await client.transcript('dev', 'demo-dev-discord')).items.some((item) => item.kind === 'user' && item.text === 'Mensaje nuevo'), false);
  assert.equal((await client.conversationDeletion('dev', created.id)).messageCount, 2);
});

test('demo empty, read error and offline modes are real client states without a Server', async () => {
  resetDemo(); const client = createDemoClient('atlas', () => 1791028800000);
  setDemoConversationScenario('atlas', 'empty');
  assert.equal((await client.transcript('dev')).sessionId, null);
  assert.equal((await client.conversations('dev')).conversations.length, 0);
  await client.createConversation('dev', { requestId });
  assert.equal((await client.conversations('dev')).conversations.length, 1);
  setDemoConversationScenario('atlas', 'error');
  await assert.rejects(client.conversations('dev'), (failure) => failure instanceof RelayError && failure.code === 'conversation_store_unavailable');
  setDemoConversationScenario('atlas', 'offline');
  await assert.rejects(client.conversations('dev'), (failure) => failure instanceof RelayError && failure.code === 'timeout');
  resetDemo();
});
