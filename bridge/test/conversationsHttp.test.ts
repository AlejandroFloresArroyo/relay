import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { hashDeviceKey } from '../src/auth.ts';
import { createDeviceStore } from '../src/deviceStore.ts';
import { createPairing } from '../src/pairing.ts';
import { RunManager } from '../src/runs.ts';
import { createApp } from '../src/server.ts';
import { FakeHermes } from '../support/fake_hermes.ts';
import type { StoredConversation } from '../src/chatPorts.ts';
import type { ApiError, ChatRunEvent, Conversation, ConversationPage, ConversationSearchPage, ConversationDeletionPreview, ConversationDeleted, ConversationTranscript, RunCreated, RunSnapshot, SteerAccepted } from '../../protocol/protocol.ts';
import { HermesError } from '../src/hermes.ts';
import { eventually } from '../support/channel.ts';
import { createConversationStore } from '../src/conversationStore.ts';
import { ConversationService } from '../src/conversations.ts';
import type { StateIO } from '../src/changeLog.ts';

const KEY = `rly1_${Buffer.alloc(32, 19).toString('base64url')}`;
const AUTH = { Authorization: `Bearer ${KEY}`, 'X-Relay-Protocol': '2', 'Content-Type': 'application/json' };
const imageFixture = { attachmentId: 'image-fixture-1', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=', width: 1, height: 1 };
const external: StoredConversation = {
  id: 'discord-history', sessionId: 'discord-history', source: 'discord', createdSource: 'discord', title: 'Migrar a Node 22',
  kind: 'interactive', hidden: false, archived: false, startedAt: 1700000000000, lastActiveAt: 1700000001000,
  messageCount: 31, preview: 'Pendiente', sessionIds: ['discord-history'],
};
async function start(t: TestContext, options: { directory?: string; hermes?: FakeHermes; io?: StateIO } = {}) {
  const directory = options.directory ?? await fs.mkdtemp(path.join(os.tmpdir(), 'relay-conversations-'));
  if (!options.directory) t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await createDeviceStore({ directory });
  if (store.snapshot().devices.length === 0) await store.mutate((state) => { state.devices.push({ id: '00000000-0000-4000-8000-000000000019', name: 'phone', pairedAt: 1700000000000, revokedAt: null, keyHash: hashDeviceKey(KEY).toString('hex') }); });
  const hermes = options.hermes ?? new FakeHermes();
  if (!options.hermes) hermes.seedConversation('default', external);
  const logs: string[] = [];
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} }, sleep: async () => {} });
  const conversations = options.io ? new ConversationService({ hermes, runs, store: await createConversationStore({ directory, changeLog: store.changeLog, io: options.io }) }) : undefined;
  const server = createApp({ config: { corsOrigins: ['http://localhost:8081'] }, store, pairing: createPairing({ store, origin: async () => 'http://fixture.example.ts.net:8650', serverName: 'fixture' }), hermes, runs, conversations, tailnet: { async whois() { return null; } }, peerAddress: () => '100.64.0.1', log: (line) => logs.push(line) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { runs.close(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function call<T = ApiError>(method: string, route: string, body?: unknown, headers: Record<string, string> = AUTH) {
    const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    // Each test asserts the exercised wire shape and status independently.
    const json = await response.json() as T;
    return { status: response.status, headers: response.headers, json };
  }
  return { call, hermes, runs, directory, store, logs, base, stop: () => { runs.close(); server.closeAllConnections(); server.close(); } };
}

test('authenticated conversation list exposes external history but refuses an external message Turn', async (t) => {
  const { call, hermes } = await start(t);
  const listed = await call<ConversationPage>('GET', '/v1/agents/default/conversations');
  assert.equal(listed.status, 200);
  assert.equal(listed.json.conversations[0].id, 'discord-history');
  assert.equal(listed.json.conversations[0].origin, 'external');
  assert.equal(listed.json.conversations[0].originLabel, 'Discord');
  assert.equal(listed.json.conversations[0].writable, false);
  assert.equal(listed.json.conversations[0].messageCount, 31);
  const rejected = await call('POST', '/v1/agents/default/runs', { input: 'No escribir aquí', sessionId: 'discord-history' });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.json.error.code, 'conversation_read_only');
  assert.equal(hermes.callsTo('createRun').length, 0);
});

test('#39 image Turns accept the prepared payload, return the real input receipt and never expose image bytes in snapshots or logs', async (t) => {
  const { call, hermes, logs } = await start(t);
  const conversation = await call<Conversation>('POST', '/v1/agents/default/conversations', { requestId: 'image-conversation' });
  const bytes = Buffer.alloc(1_100_000); Buffer.from('iVBORw0KGgo=', 'base64').copy(bytes);
  const image = { ...imageFixture, dataBase64: bytes.toString('base64') };
  const sent = await call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'Imagen privada', sessionId: conversation.json.id, clientMessageId: 'image-message-1', images: [image] });
  assert.equal(sent.status, 200);
  assert.equal(sent.json.clientMessageId, 'image-message-1');
  assert.equal(sent.json.inputMessageId, `message_${sent.json.runId}`);
  assert.deepEqual(hermes.callsTo('createRun')[0].args[1], { input: 'Imagen privada', sessionId: conversation.json.id, clientMessageId: 'image-message-1', images: [image] });
  const snapshot = await call<RunSnapshot>('GET', `/v1/runs/${sent.json.runId}`);
  assert.deepEqual(snapshot.json.items[0].kind === 'user' && snapshot.json.items[0].attachmentIds, ['image-fixture-1']);
  assert.doesNotMatch(JSON.stringify(snapshot.json), /dataBase64|iVBORw0KGgo/);
  assert.doesNotMatch(logs.join('\n'), /Imagen privada|dataBase64|iVBORw0KGgo/);
});

test('#39 invalid images and oversized bodies cause no Conversation or upstream write and their content is redacted', async (t) => {
  const { call, hermes, logs } = await start(t);
  const cases = [
    { images: [{ ...imageFixture, dataBase64: 'private-image-data' }], code: 'invalid_image', status: 400 },
    { images: [{ ...imageFixture, mimeType: 'image/svg+xml' }], code: 'invalid_image', status: 400 },
    { images: [{ ...imageFixture, width: 1601 }], code: 'invalid_image', status: 400 },
    { images: [{ ...imageFixture, dataBase64: 'A'.repeat(2_666_672) }], code: 'image_too_large', status: 413 },
    { images: [imageFixture, imageFixture], code: 'invalid_image', status: 400 },
  ];
  for (const entry of cases) {
    const response = await call('POST', '/v1/agents/default/runs', { input: 'Privado', images: entry.images, clientMessageId: 'image-message-1' });
    assert.equal(response.status, entry.status); assert.equal(response.json.error.code, entry.code);
    assert.doesNotMatch(JSON.stringify(response.json), /private-image-data|iVBORw0KGgo/);
  }
  const large = await call('POST', '/v1/agents/default/runs', { input: 'Privado', images: [{ ...imageFixture, dataBase64: 'A'.repeat(9_000_001) }], clientMessageId: 'image-message-1' });
  assert.equal(large.status, 413); assert.equal(large.json.error.code, 'image_too_large');
  assert.equal(hermes.callsTo('createRun').length, 0); assert.equal(hermes.callsTo('createConversation').length, 0);
  assert.doesNotMatch(logs.join('\n'), /Privado|private-image-data|iVBORw0KGgo/);
});

test('creation is durable, idempotent per device and Agent, and implicit message creation gets permission', async (t) => {
  const first = await start(t);
  const [created, repeated] = await Promise.all([
    first.call<Conversation>('POST', '/v1/agents/default/conversations', { requestId: 'new-001' }),
    first.call<Conversation>('POST', '/v1/agents/default/conversations', { requestId: 'new-001' }),
  ]);
  assert.equal(created.status, 201); assert.equal(repeated.status, 201);
  assert.equal(created.json.id, repeated.json.id);
  assert.equal(created.json.origin, 'relay'); assert.equal(created.json.writable, true);
  assert.equal(first.hermes.callsTo('createConversation').length, 1);
  assert.equal((await fs.stat(path.join(first.directory, 'conversations.json'))).mode & 0o777, 0o600);
  first.stop();
  const second = await start(t, { directory: first.directory, hermes: first.hermes });
  const recovered = await second.call<Conversation>('POST', '/v1/agents/default/conversations', { requestId: 'new-001' });
  assert.equal(recovered.json.id, created.json.id);
  assert.equal(second.hermes.callsTo('createConversation').length, 1);
  const otherKey = `rly1_${Buffer.alloc(32, 20).toString('base64url')}`;
  await second.store.mutate((state) => { state.devices.push({ id: '00000000-0000-4000-8000-000000000020', name: 'tablet', pairedAt: 1700000000000, revokedAt: null, keyHash: hashDeviceKey(otherKey).toString('hex') }); });
  const otherDevice = await second.call<Conversation>('POST', '/v1/agents/default/conversations', { requestId: 'new-001' }, { ...AUTH, Authorization: `Bearer ${otherKey}` });
  assert.notEqual(otherDevice.json.id, created.json.id);
  const otherAgent = await second.call<Conversation>('POST', '/v1/agents/coding/conversations', { requestId: 'new-001' });
  assert.notEqual(otherAgent.json.id, created.json.id);
  const implicit = await second.call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'Mensaje de la Conversación nueva' });
  assert.equal(implicit.status, 200); assert.ok(implicit.json.conversationId);
  const implicitConversation = await second.call<Conversation>('GET', `/v1/agents/default/conversations/${implicit.json.conversationId}`);
  assert.equal(implicitConversation.json.origin, 'relay'); assert.equal(implicitConversation.json.writable, true);
  const transcript = await second.call<ConversationTranscript>('GET', `/v1/agents/default/transcript?sessionId=${implicit.json.sessionId}`);
  assert.equal(transcript.json.conversation?.id, implicit.json.conversationId);
  assert.deepEqual(transcript.json.items.map((item) => item.kind === 'user' ? item.text : ''), ['Mensaje de la Conversación nueva']);
  const audit = await fs.readFile(path.join(second.directory, 'changes.jsonl'), 'utf8');
  assert.doesNotMatch(audit, /Mensaje de la Conversación nueva|Migrar a Node 22|Pendiente/);
});

test('lost receipts and legacy api_server names never grant message permission', async (t) => {
  const first = await start(t);
  first.hermes.seedConversation('default', { ...external, id: 'relay_legacy', sessionId: 'relay_legacy', sessionIds: ['relay_legacy'], source: 'api_server', createdSource: 'api_server', title: 'Relay' });
  const legacy = await first.call<Conversation>('GET', '/v1/agents/default/conversations/relay_legacy');
  assert.equal(legacy.json.origin, 'external'); assert.equal(legacy.json.writable, false);
  assert.equal((await first.call('POST', '/v1/agents/default/runs', { input: 'no', sessionId: 'relay_legacy' })).status, 403);
  const created = await first.call<Conversation>('POST', '/v1/agents/default/conversations', { requestId: 'lost' });
  first.stop(); await fs.unlink(path.join(first.directory, 'conversations.json'));
  const restarted = await start(t, { directory: first.directory, hermes: first.hermes });
  const lost = await restarted.call<Conversation>('GET', `/v1/agents/default/conversations/${created.json.id}`);
  assert.equal(lost.json.origin, 'external'); assert.equal(lost.json.writable, false);
  assert.equal((await restarted.call('POST', '/v1/agents/default/runs', { input: 'no', sessionId: created.json.id })).status, 403);
});

test('external history can be renamed and deleted, but a stale confirmation cannot delete changed messages', async (t) => {
  const { call, hermes, directory, logs } = await start(t);
  const renamed = await call<Conversation>('PATCH', '/v1/agents/default/conversations/discord-history', { title: 'Título privado de Discord' });
  assert.equal(renamed.status, 200); assert.equal(renamed.json.title, 'Título privado de Discord'); assert.equal(renamed.json.writable, false);
  const preview = await call<ConversationDeletionPreview>('GET', '/v1/agents/default/conversations/discord-history/deletion');
  assert.equal(preview.json.messageCount, 31);
  hermes.seedConversation('default', { ...external, title: 'Título privado de Discord', messageCount: 32 });
  const stale = await call('DELETE', '/v1/agents/default/conversations/discord-history', { revision: preview.json.revision });
  assert.equal(stale.status, 409); assert.equal(stale.json.error.code, 'conversation_changed');
  assert.equal(hermes.callsTo('deleteSession').length, 0);
  const fresh = await call<ConversationDeletionPreview>('GET', '/v1/agents/default/conversations/discord-history/deletion');
  const deleted = await call<ConversationDeleted>('DELETE', '/v1/agents/default/conversations/discord-history', { revision: fresh.json.revision });
  assert.equal(deleted.status, 200); assert.equal(deleted.json.messageCount, 32);
  assert.equal((await call('GET', '/v1/agents/default/conversations/discord-history')).status, 404);
  const audit = await fs.readFile(path.join(directory, 'changes.jsonl'), 'utf8');
  assert.doesNotMatch(audit, /Título privado de Discord|Migrar a Node 22|Pendiente/);
  assert.doesNotMatch(logs.join('\n'), /Título privado de Discord|Migrar a Node 22|Pendiente/);
});

test('an active Turn protects rename, deletion and a second send until completion', async (t) => {
  const { call, hermes, runs } = await start(t);
  const created = await call<Conversation>('POST', '/v1/agents/default/conversations', { requestId: 'busy' });
  const route = `/v1/agents/default/conversations/${created.json.id}`;
  const before = await call<ConversationDeletionPreview>('GET', `${route}/deletion`);
  const run = await call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'Mensaje privado', sessionId: created.json.sessionId });
  assert.equal(run.status, 200);
  for (const response of [
    await call('PATCH', route, { title: 'No cambiar aún' }),
    await call('DELETE', route, { revision: before.json.revision }),
    await call('GET', `${route}/deletion`),
    await call('POST', '/v1/agents/default/runs', { input: 'Segundo', sessionId: created.json.sessionId }),
  ]) { assert.equal(response.status, 409); assert.equal(response.json.error.code, 'conversation_busy'); }
  assert.equal(hermes.callsTo('createRun').length, 1);
  hermes.stream(run.json.runId).push({ event: 'run.completed', seq: 0, output: 'Listo' });
  await eventually(() => assert.equal(runs.busy('default'), false));
  assert.equal((await call('PATCH', route, { title: 'Ya puede cambiar' })).status, 200);
  const after = await call<ConversationDeletionPreview>('GET', `${route}/deletion`);
  assert.equal(after.json.messageCount, 1);
  assert.equal((await call('DELETE', route, { revision: after.json.revision })).status, 200);
});

test('title validation, title uniqueness, literal Unicode search and background pagination are public behaviors', async (t) => {
  const { call, hermes } = await start(t);
  hermes.seedConversation('default', { ...external, id: 'terminal', sessionId: 'terminal', sessionIds: ['terminal'], title: 'CAFÉ %_ literal', source: 'cli', createdSource: 'cli', messageCount: 1 }, [{ kind: 'user', id: 'msg', text: 'ÁRBOL %_ contenido', at: 1700000000000 }]);
  hermes.seedConversation('default', { ...external, id: 'cron', sessionId: 'cron', sessionIds: ['cron'], title: 'CAFÉ de fondo', kind: 'background', source: 'cron', createdSource: 'cron', lastActiveAt: 1700000002000 });
  const page = await call<ConversationPage>('GET', '/v1/agents/default/conversations?limit=1');
  assert.equal(page.json.conversations.length, 1); assert.equal(page.json.nextOffset, 1);
  const next = await call<ConversationPage>('GET', '/v1/agents/default/conversations?limit=1&offset=1');
  assert.equal(next.json.conversations.length, 1); assert.notEqual(next.json.conversations[0].id, page.json.conversations[0].id); assert.equal(next.json.nextOffset, null);
  const background = await call<ConversationPage>('GET', '/v1/agents/default/conversations?background=true');
  assert.deepEqual(background.json.conversations.map((conversation) => conversation.id), ['cron']);
  const title = await call<ConversationSearchPage>('GET', '/v1/agents/default/conversations/search?q=caf%C3%A9%20%25_');
  assert.deepEqual(title.json.hits.map((hit) => [hit.conversation.id, hit.match]), [['terminal', 'title']]);
  const message = await call<ConversationSearchPage>('GET', '/v1/agents/default/conversations/search?q=%C3%A1rbol');
  assert.deepEqual(message.json.hits.map((hit) => [hit.conversation.id, hit.match, hit.messageId]), [['terminal', 'message', 'msg']]);
  const duplicate = await call('PATCH', '/v1/agents/default/conversations/discord-history', { title: 'CAFÉ %_ literal' });
  assert.equal(duplicate.status, 400); assert.equal(duplicate.json.error.code, 'invalid_title');
  for (const title of ['', 'x'.repeat(101), 'bad\nline']) assert.equal((await call('PATCH', '/v1/agents/default/conversations/discord-history', { title })).status, 400);
  const unicode = await call<Conversation>('PATCH', '/v1/agents/default/conversations/discord-history', { title: '🌳'.repeat(100) });
  assert.equal(unicode.status, 200);
});

test('conversation protocol/authentication and CORS are enforced while legacy transcript remains readable', async (t) => {
  const { call, base } = await start(t);
  const missing = await call('GET', '/v1/agents/default/conversations', undefined, { Authorization: AUTH.Authorization });
  assert.equal(missing.status, 426); assert.equal(missing.json.error.code, 'protocol_upgrade_required');
  for (const value of ['1', '3', 'nonsense']) assert.equal((await call('GET', '/v1/agents/default/conversations', undefined, { ...AUTH, 'X-Relay-Protocol': value })).status, 426);
  assert.equal((await call('GET', '/v1/agents/default/conversations', undefined, {})).status, 401);
  assert.equal((await call('GET', '/v1/agents/default/conversations?limit=0')).status, 400);
  assert.equal((await call('GET', '/v1/agents/default/conversations/search?q=')).status, 400);
  const legacy = await call<ConversationTranscript>('GET', '/v1/agents/default/transcript', undefined, { Authorization: AUTH.Authorization });
  assert.equal(legacy.status, 200); assert.equal(legacy.json.conversation?.id, 'discord-history');
  // Preflight has no JSON body.
  const result = await fetch(`${base}/v1/agents/default/conversations`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:8081', 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'X-Relay-Protocol,Content-Type,Authorization' } });
  assert.equal(result.status, 204);
  assert.match(result.headers.get('access-control-allow-methods') ?? '', /PATCH/);
  assert.match(result.headers.get('access-control-allow-methods') ?? '', /DELETE/);
  assert.match(result.headers.get('access-control-allow-headers') ?? '', /X-Relay-Protocol/);
});

test('creation uncertainty persists across restart without adopting an upstream row or repeating creation', async (t) => {
  const first = await start(t);
  let upstreamId = '';
  first.hermes.chatHooks.createConversation = async (profile, id) => {
    upstreamId = id;
    first.hermes.seedConversation(profile, { ...external, id, sessionId: id, sessionIds: [id], source: 'api_server', createdSource: 'api_server', title: null, messageCount: 0 });
    throw new HermesError('operation_uncertain', 'Synthetic dropped response');
  };
  const uncertain = await first.call('POST', '/v1/agents/default/conversations', { requestId: 'uncertain' });
  assert.equal(uncertain.status, 503); assert.equal(uncertain.json.error.code, 'operation_uncertain');
  // The app shows this text as it is: an uncertain outcome is not a «No se pudo…» that invites a retry.
  assert.equal(uncertain.json.error.message, 'La operación quedó sin confirmar. Conserva el texto y la misma solicitud; no se enviará otra vez.');
  first.stop();
  const restarted = await start(t, { directory: first.directory, hermes: first.hermes });
  const repeated = await restarted.call('POST', '/v1/agents/default/conversations', { requestId: 'uncertain' });
  assert.equal(repeated.status, 503); assert.equal(repeated.json.error.code, 'operation_uncertain');
  assert.equal(first.hermes.callsTo('createConversation').length, 1);
  const observed = await restarted.call<Conversation>('GET', `/v1/agents/default/conversations/${upstreamId}`);
  assert.equal(observed.json.writable, false); assert.equal(observed.json.origin, 'external');
  assert.equal((await restarted.call('POST', '/v1/agents/default/runs', { input: 'No adoptar', sessionId: upstreamId })).status, 503);
});

test('revocation during creation prevents the 201 response and audit never stores titles or message text', async (t) => {
  const fixture = await start(t);
  let entered!: () => void; let release!: () => void;
  const begun = new Promise<void>((resolve) => { entered = resolve; });
  const paused = new Promise<void>((resolve) => { release = resolve; });
  fixture.hermes.chatHooks.createConversation = async (profile, id) => {
    entered(); await paused;
    fixture.hermes.seedConversation(profile, { ...external, id, sessionId: id, sessionIds: [id], source: 'api_server', createdSource: 'api_server', title: null, messageCount: 0 });
  };
  const pending = fixture.call('POST', '/v1/agents/default/conversations', { requestId: 'revoked' });
  await begun;
  await fixture.store.mutate((state) => { state.devices[0].revokedAt = Date.now(); });
  release();
  const response = await pending;
  assert.equal(response.status, 403); assert.equal(response.json.error.code, 'device_revoked');
  const audit = await fs.readFile(path.join(fixture.directory, 'changes.jsonl'), 'utf8');
  assert.match(audit, /conversation.create.succeeded/);
  assert.doesNotMatch(audit, /Migrar a Node 22|Pendiente|Synthetic dropped response|rly1_/);
  assert.doesNotMatch(fixture.logs.join('\n'), /Migrar a Node 22|Pendiente|revoked|rly1_/);
});

test('unsafe private receipt permissions fail closed without adopting sessions', async (t) => {
  const first = await start(t);
  await first.call('GET', '/v1/agents/default/conversations');
  first.stop(); await fs.chmod(path.join(first.directory, 'conversations.json'), 0o644);
  const restarted = await start(t, { directory: first.directory, hermes: first.hermes });
  const result = await restarted.call('POST', '/v1/agents/default/conversations', { requestId: 'unsafe' });
  assert.equal(result.status, 503); assert.equal(result.json.error.code, 'conversation_store_unavailable');
  assert.equal(first.hermes.callsTo('createConversation').length, 0);
});

test('an uncertain atomic receipt commit blocks upstream effects and remains fail-closed after restart', async (t) => {
  let fail = false;
  const io: StateIO = { ...fs, async rename(from, to) {
    await fs.rename(from, to);
    if (fail && String(to).endsWith('/conversations.json')) throw new Error('Synthetic directory sync outcome');
  } };
  const first = await start(t, { io });
  fail = true;
  const result = await first.call('POST', '/v1/agents/default/conversations', { requestId: 'commit-uncertain' });
  assert.equal(result.status, 503); assert.equal(result.json.error.code, 'conversation_store_unavailable');
  assert.equal(first.hermes.callsTo('createConversation').length, 0);
  assert.equal((await first.call('GET', '/v1/agents/default/conversations')).status, 503);
  first.stop();
  const restarted = await start(t, { directory: first.directory, hermes: first.hermes });
  const repeated = await restarted.call('POST', '/v1/agents/default/conversations', { requestId: 'commit-uncertain' });
  assert.equal(repeated.status, 503); assert.equal(repeated.json.error.code, 'operation_uncertain');
  assert.equal(first.hermes.callsTo('createConversation').length, 0);
});

test('verified continuation aliases send to the family tip while a separate branch stays read-only', async (t) => {
  const { call, hermes } = await start(t);
  const created = await call<Conversation>('POST', '/v1/agents/default/conversations', { requestId: 'family' });
  const root = created.json.id;
  hermes.seedConversation('default', { ...external, id: root, sessionId: 'automatic-tip', sessionIds: [root, 'automatic-tip'], source: 'api_server', createdSource: 'api_server', title: 'Familia', messageCount: 2 }, [
    { kind: 'user', id: '1', text: 'Antes de comprimir', at: 1700000000000 },
    { kind: 'assistant', id: '2', text: 'Después de comprimir', at: 1700000001000 },
  ]);
  hermes.seedConversation('default', { ...external, id: 'branch', sessionId: 'branch', sessionIds: ['branch'], source: 'api_server', createdSource: 'api_server' });
  const selected = await call<ConversationTranscript>('GET', '/v1/agents/default/transcript?sessionId=automatic-tip');
  assert.equal(selected.json.conversation?.id, root); assert.equal(selected.json.conversation?.writable, true);
  assert.deepEqual(selected.json.items.map((item) => item.kind === 'user' || item.kind === 'assistant' ? item.text : ''), ['Antes de comprimir', 'Después de comprimir']);
  const run = await call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'Continuar', sessionId: root });
  assert.equal(run.status, 200); assert.equal(run.json.conversationId, root); assert.equal(run.json.sessionId, 'automatic-tip');
  assert.equal((await call('POST', '/v1/agents/default/runs', { input: 'No adoptar rama', sessionId: 'branch' })).status, 403);
});

test('uncertain deletion survives restart and resumes the same plan without recreating permission', async (t) => {
  const first = await start(t);
  const created = await first.call<Conversation>('POST', '/v1/agents/default/conversations', { requestId: 'delete-retry' });
  const route = `/v1/agents/default/conversations/${created.json.id}`;
  const preview = await first.call<ConversationDeletionPreview>('GET', `${route}/deletion`);
  first.hermes.failWith.deleteSession = new Error('Synthetic lost delete response');
  const uncertain = await first.call('DELETE', route, { revision: preview.json.revision });
  assert.equal(uncertain.status, 503); assert.equal(uncertain.json.error.code, 'operation_uncertain');
  const pending = await first.call<Conversation>('GET', route);
  assert.equal(pending.json.state, 'deleting'); assert.equal(pending.json.writable, false);
  first.stop(); delete first.hermes.failWith.deleteSession;
  const restarted = await start(t, { directory: first.directory, hermes: first.hermes });
  const stored = await first.hermes.getConversation('default', created.json.id);
  assert.ok(stored);
  first.hermes.seedConversation('default', { ...stored, messageCount: 1 });
  const resumed = await restarted.call<ConversationDeletionPreview>('GET', `${route}/deletion`);
  assert.equal(resumed.json.revision, preview.json.revision);
  assert.equal(resumed.json.messageCount, preview.json.messageCount);
  const drifted = await restarted.call('DELETE', route, { revision: resumed.json.revision });
  assert.equal(drifted.status, 409); assert.equal(drifted.json.error.code, 'conversation_changed');
  const fresh = await restarted.call<ConversationDeletionPreview>('GET', `${route}/deletion`);
  assert.equal(fresh.json.messageCount, 1);
  const removed = await restarted.call<ConversationDeleted>('DELETE', route, { revision: fresh.json.revision });
  assert.equal(removed.status, 200); assert.equal(removed.json.deleted, true);
  assert.equal((await restarted.call('GET', route)).status, 404);
  const replay = await restarted.call('POST', '/v1/agents/default/conversations', { requestId: 'delete-retry' });
  assert.equal(replay.status, 409); assert.equal(replay.json.error.code, 'request_conflict');
});

test('the deletion revision is rechecked after persistence immediately before any upstream effect', async (t) => {
  const { call, hermes } = await start(t);
  const preview = await call<ConversationDeletionPreview>('GET', '/v1/agents/default/conversations/discord-history/deletion');
  let previews = 0;
  const changingPreview = async (profile: string, id: string) => {
    previews++;
    if (previews === 2) hermes.seedConversation('default', { ...external, messageCount: 32 });
    delete hermes.chatHooks.deletionPreview;
    try { return await hermes.deletionPreview(profile, id); }
    finally { hermes.chatHooks.deletionPreview = changingPreview; }
  };
  hermes.chatHooks.deletionPreview = changingPreview;
  const changed = await call('DELETE', '/v1/agents/default/conversations/discord-history', { revision: preview.json.revision });
  assert.equal(changed.status, 409); assert.equal(changed.json.error.code, 'conversation_changed');
  assert.equal(hermes.callsTo('deleteSession').length, 0);
  const stillPresent = await call<Conversation>('GET', '/v1/agents/default/conversations/discord-history');
  assert.equal(stillPresent.json.state, 'ready'); assert.equal(stillPresent.json.messageCount, 32);
  const fresh = await call<ConversationDeletionPreview>('GET', '/v1/agents/default/conversations/discord-history/deletion');
  assert.equal((await call('DELETE', '/v1/agents/default/conversations/discord-history', { revision: fresh.json.revision })).status, 200);
});

test('receipt-backed roots with ambiguous automatic lineage cannot let Hermes choose a writable child', async (t) => {
  const { call, hermes } = await start(t);
  const created = await call<Conversation>('POST', '/v1/agents/default/conversations', { requestId: 'ambiguous' });
  hermes.seedConversation('default', { ...external, id: created.json.id, sessionId: created.json.id, sessionIds: [created.json.id], source: 'api_server', createdSource: 'api_server', continuationUncertain: true });
  const observed = await call<Conversation>('GET', `/v1/agents/default/conversations/${created.json.id}`);
  assert.equal(observed.json.origin, 'relay'); assert.equal(observed.json.writable, false);
  const rejected = await call('POST', '/v1/agents/default/runs', { input: 'No resolver al azar', sessionId: created.json.id });
  assert.equal(rejected.status, 503); assert.equal(rejected.json.error.code, 'operation_uncertain');
  assert.equal(hermes.callsTo('createRun').length, 0);
});

test('#37 steering accepts one instruction per request without stopping the active Turn', async (t) => {
  const { call, hermes, runs, logs } = await start(t);
  hermes.chatHooks.steerRun = async () => {};
  const created = await call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'Entrada privada inicial' });
  assert.equal(created.status, 200);
  const runId = created.json.runId;
  const request = { requestId: 'redirect-001', input: 'Instrucción privada redirigida' };
  const accepted = await call<SteerAccepted>('POST', `/v1/runs/${runId}/steer`, request);
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.json, { runId, requestId: request.requestId, accepted: true });
  const repeated = await call<SteerAccepted>('POST', `/v1/runs/${runId}/steer`, request);
  assert.deepEqual(repeated.json, accepted.json);
  const conflict = await call('POST', `/v1/runs/${runId}/steer`, { ...request, input: 'Otra instrucción' });
  assert.equal(conflict.status, 409); assert.equal(conflict.json.error.code, 'request_conflict');
  assert.deepEqual(hermes.callsTo('steerRun').map((call) => call.args), [['default', runId, request.input]]);
  assert.equal(hermes.callsTo('stopRun').length, 0);
  assert.equal(runs.busy('default'), true);
  const events: ChatRunEvent[] = [];
  const unsubscribe = runs.subscribe(runId, -1, (_seq, event) => events.push(event), () => {});
  t.after(() => unsubscribe?.());
  assert.deepEqual(events.filter((event) => event.type === 'run.steered'), [{ type: 'run.steered', requestId: request.requestId, accepted: true }]);
  assert.doesNotMatch(logs.join('\n'), /Entrada privada|Instrucción privada|redirect-001/);
  assert.match(logs.join('\n'), /POST \/v1\/runs\/:id\/steer 200/);
});

test('#37 snapshot and reconnect preserve this Turn and terminal undelivered steering at the replay cursor', async (t) => {
  const { call, hermes, runs, base } = await start(t);
  const created = await call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'Entrada del Turno' });
  const runId = created.json.runId;
  const seen: ChatRunEvent[] = [];
  runs.subscribe(runId, -1, (_seq, event) => seen.push(event), () => {});
  hermes.stream(runId).push({ event: 'message.delta', seq: 0, delta: 'Respuesta parcial' });
  await eventually(() => assert.equal(seen.some((event) => event.type === 'message.delta'), true));
  const snapshot = await call<RunSnapshot>('GET', `/v1/runs/${runId}`);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.json.conversationId, created.json.conversationId);
  assert.equal(snapshot.json.sessionId, created.json.sessionId);
  assert.equal(snapshot.json.phase, 'running'); assert.equal(snapshot.json.complete, true);
  assert.deepEqual(snapshot.json.items.map((item) => item.kind === 'tool' ? item.preview : item.text), ['Entrada del Turno', 'Respuesta parcial']);
  const cursor = snapshot.json.lastEventId;
  hermes.stream(runId).push({ event: 'run.completed', seq: 1, output: 'Respuesta parcial', pending_steer: 'No se llegó a entregar' });
  await eventually(() => assert.equal(runs.busy('default'), false));
  const reconnect = await call<RunSnapshot>('POST', `/v1/runs/${runId}/reconnect`, {});
  assert.equal(reconnect.status, 200); assert.equal(reconnect.json.phase, 'completed');
  assert.deepEqual(reconnect.json.terminal, { type: 'run.completed', output: 'Respuesta parcial', pendingSteer: 'No se llegó a entregar' });
  assert.deepEqual(reconnect.json.items, snapshot.json.items);
  const response = await fetch(`${base}/v1/runs/${runId}/events`, { headers: { ...AUTH, 'Last-Event-ID': String(cursor) } });
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.doesNotMatch(stream, /"type":"message.delta"/);
  assert.match(stream, /"pendingSteer":"No se llegó a entregar"/);
  assert.equal(hermes.callsTo('createRun').length, 1, 'reconnect never starts another Turn');
});

test('#37 reconnect accepts a zero-length HTTP body before the first event without starting another Turn', async (t) => {
  const { call, hermes } = await start(t);
  const created = await call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'Primera respuesta pendiente' });
  const resumed = await call<RunSnapshot>('POST', `/v1/runs/${created.json.runId}/reconnect`, undefined, { Authorization: AUTH.Authorization, 'X-Relay-Protocol': '2' });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.json.runId, created.json.runId);
  assert.equal(resumed.json.phase, 'running');
  assert.equal(resumed.json.lastEventId, -1);
  assert.equal(hermes.callsTo('createRun').length, 1);
});

for (const outcome of ['rejected', 'unknown'] as const) test(`#37 ${outcome} steer receipts retain identity and never repeat an upstream write`, async (t) => {
  const { call, hermes, logs } = await start(t);
  hermes.chatHooks.steerRun = async () => { throw outcome === 'rejected' ? new HermesError('steer_not_accepted', 'secret instruction') : new Error('secret transport receipt'); };
  const created = await call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'Entrada' });
  const runId = created.json.runId;
  const request = { requestId: `receipt-${outcome}`, input: 'secret instruction' };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await call('POST', `/v1/runs/${runId}/steer`, request);
    assert.equal(response.status, outcome === 'rejected' ? 409 : 503);
    assert.equal(response.json.error.code, outcome === 'rejected' ? 'steer_not_accepted' : 'operation_uncertain');
    assert.doesNotMatch(JSON.stringify(response.json), /secret instruction|secret transport/);
  }
  assert.equal(hermes.callsTo('steerRun').length, 1);
  assert.equal(hermes.callsTo('stopRun').length, 0);
  const snapshot = await call<RunSnapshot>('GET', `/v1/runs/${runId}`);
  assert.deepEqual(snapshot.json.steers, [{ requestId: request.requestId, status: outcome }]);
  assert.deepEqual(snapshot.json.items.map((item) => item.kind === 'tool' ? item.preview : item.text), ['Entrada']);
  assert.doesNotMatch(logs.join('\n'), /secret instruction|secret transport|receipt-rejected|receipt-unknown/);
});

test('#37 steer requires exact bounded input, current protocol, an authenticated device and a known active Turn', async (t) => {
  const { call, hermes } = await start(t);
  const created = await call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'Entrada' });
  const runId = created.json.runId;
  const route = `/v1/runs/${runId}/steer`;
  for (const body of [
    {}, [], null, { requestId: 'r', input: '' }, { requestId: 'r', input: ' \n\t' }, { requestId: 'r', input: 42 },
    { requestId: '', input: 'x' }, { requestId: 'r'.repeat(129), input: 'x' }, { requestId: 'bad/id', input: 'x' },
    { requestId: 'r', input: 'x', extra: true }, { requestId: 'r', input: 'x\u0000' },
    { requestId: 'r', input: '🌳'.repeat(16_001) },
  ]) {
    const response = await call('POST', route, body);
    assert.equal(response.status, 400); assert.equal(response.json.error.code, 'invalid_steer_input');
  }
  for (const protocol of [undefined, '1', '3']) {
    const headers: Record<string, string> = { Authorization: AUTH.Authorization, 'Content-Type': 'application/json' };
    if (protocol !== undefined) headers['X-Relay-Protocol'] = protocol;
    assert.equal((await call('POST', route, { requestId: 'r', input: 'x' }, headers)).status, 426);
    assert.equal((await call('GET', `/v1/runs/${runId}`, undefined, headers)).status, 426);
    assert.equal((await call('POST', `/v1/runs/${runId}/reconnect`, {}, headers)).status, 426);
  }
  assert.equal((await call('POST', route, { requestId: 'r', input: 'x' }, {})).status, 401);
  const unknown = await call('POST', '/v1/runs/unknown/steer', { requestId: 'r', input: 'x' });
  assert.equal(unknown.status, 404); assert.equal(unknown.json.error.code, 'run_not_found');
  assert.equal((await call('POST', `/v1/runs/${runId}/reconnect`, { input: 'no resend' })).status, 400);
  assert.equal(hermes.callsTo('steerRun').length, 0);
  const boundary = await call<SteerAccepted>('POST', route, { requestId: 'boundary', input: '🌳'.repeat(16_000) });
  assert.equal(boundary.status, 200);
  assert.equal(hermes.callsTo('steerRun').length, 1);
});

test('#37 per-Agent unavailable chat refuses new Turn creation while another Agent remains available', async (t) => {
  const { call, hermes } = await start(t);
  hermes.chatHooks.chat = async (profile) => ({ available: profile !== 'coding', reason: profile === 'coding' ? 'fixture disabled' : null });
  const disabled = await call<{ available: boolean; reason: string | null }>('GET', '/v1/agents/coding/chat');
  assert.equal(disabled.status, 200); assert.equal(disabled.json.available, false); assert.ok(disabled.json.reason);
  const enabled = await call<{ available: boolean; reason: string | null }>('GET', '/v1/agents/default/chat');
  assert.deepEqual(enabled.json, { available: true, reason: null });
  const rejected = await call('POST', '/v1/agents/coding/runs', { input: 'No crear Conversación' });
  assert.equal(rejected.status, 503); assert.equal(rejected.json.error.code, 'chat_unavailable');
  assert.equal(hermes.callsTo('createConversation').length, 0); assert.equal(hermes.callsTo('createRun').length, 0);
});

test('#37 revocation while checking upstream status prevents delayed steering and reconnect effects', async (t) => {
  const { call, hermes, store } = await start(t);
  const created = await call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'Entrada' });
  let entered!: () => void; let release!: () => void;
  const begun = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const status = hermes.runStatus.bind(hermes);
  hermes.runStatus = async (...args) => { entered(); await waiting; return status(...args); };
  const pending = call('POST', `/v1/runs/${created.json.runId}/steer`, { requestId: 'delayed', input: 'No escribir' });
  await begun;
  await store.mutate((state) => { state.devices[0].revokedAt = Date.now(); });
  release();
  const rejected = await pending;
  assert.equal(rejected.status, 403); assert.equal(rejected.json.error.code, 'device_revoked');
  assert.equal(hermes.callsTo('steerRun').length, 0);
  const connections = hermes.callsTo('runEvents').length;
  const reconnect = await call('POST', `/v1/runs/${created.json.runId}/reconnect`, {});
  assert.equal(reconnect.status, 403); assert.equal(hermes.callsTo('runEvents').length, connections);
});

test('#37 a terminal racing the upstream status check cannot receive steering', async (t) => {
  const { call, hermes, runs } = await start(t);
  const created = await call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'Entrada' });
  const runId = created.json.runId;
  let entered!: () => void; let release!: () => void;
  const begun = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  hermes.runStatus = async () => { entered(); await waiting; return { status: 'running', output: null, error: null }; };
  const pending = call('POST', `/v1/runs/${runId}/steer`, { requestId: 'terminal-race', input: 'No llegó' });
  await begun;
  hermes.stream(runId).push({ event: 'run.completed', seq: 0, output: 'Listo' });
  await eventually(() => assert.equal(runs.busy('default'), false));
  release();
  const rejected = await pending;
  assert.equal(rejected.status, 409); assert.equal(rejected.json.error.code, 'run_not_accepting_steer');
  assert.equal(hermes.callsTo('steerRun').length, 0);
  const snapshot = await call<RunSnapshot>('GET', `/v1/runs/${runId}`);
  assert.deepEqual(snapshot.json.steers, [{ requestId: 'terminal-race', status: 'rejected' }]);
});

test('#37 concurrent duplicate steering shares one confirmed receipt and ignores the anonymous upstream event', async (t) => {
  const { call, hermes, runs } = await start(t);
  const created = await call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'Entrada' });
  const runId = created.json.runId;
  let entered!: () => void; let release!: () => void;
  const begun = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  hermes.chatHooks.steerRun = async () => {
    hermes.stream(runId).push({ event: 'run.steered', seq: 0, accepted: true });
    entered(); await waiting;
  };
  const request = { requestId: 'concurrent', input: 'Instrucción' };
  const first = call<SteerAccepted>('POST', `/v1/runs/${runId}/steer`, request);
  await begun;
  const second = call<SteerAccepted>('POST', `/v1/runs/${runId}/steer`, request);
  const snapshot = await call<RunSnapshot>('GET', `/v1/runs/${runId}`);
  assert.deepEqual(snapshot.json.steers, [{ requestId: 'concurrent', status: 'unknown' }]);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200); assert.deepEqual(a.json, b.json);
  assert.equal(hermes.callsTo('steerRun').length, 1);
  const events: ChatRunEvent[] = [];
  const unsubscribe = runs.subscribe(runId, -1, (_seq, event) => events.push(event), () => {});
  t.after(() => unsubscribe?.());
  assert.deepEqual(events.filter((event) => event.type === 'run.steered'), [{ type: 'run.steered', requestId: 'concurrent', accepted: true }]);
  const final = await call<RunSnapshot>('GET', `/v1/runs/${runId}`);
  assert.equal(final.json.items.filter((item) => item.kind === 'user' && item.redirected).length, 1);
});

test('#37 revocation after one steer write blocks its success response and the next queued instruction', async (t) => {
  const { call, hermes, store, runs } = await start(t);
  const created = await call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'Entrada' });
  const runId = created.json.runId;
  let entered!: () => void; let release!: () => void;
  const begun = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  hermes.chatHooks.steerRun = async () => { entered(); await waiting; };
  const first = call('POST', `/v1/runs/${runId}/steer`, { requestId: 'first-delayed', input: 'Primera' });
  await begun;
  const second = call('POST', `/v1/runs/${runId}/steer`, { requestId: 'second-delayed', input: 'Segunda' });
  await eventually(() => assert.equal(runs.snapshot(runId).steers.length, 2));
  await store.mutate((state) => { state.devices[0].revokedAt = Date.now(); });
  release();
  const responses = await Promise.all([first, second]);
  for (const response of responses) { assert.equal(response.status, 403); assert.equal(response.json.error.code, 'device_revoked'); }
  assert.equal(hermes.callsTo('steerRun').length, 1);
  assert.deepEqual(runs.snapshot(runId).steers, [{ requestId: 'first-delayed', status: 'accepted' }, { requestId: 'second-delayed', status: 'rejected' }]);
});

test('#37 waiting, stopping and terminal Turns reject steering without an upstream steer write', async (t) => {
  const { call, hermes, runs } = await start(t);
  const created = await call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'Entrada' });
  const runId = created.json.runId;
  hermes.stream(runId).push({ event: 'approval.request', seq: 0, request_id: 'pending-approval', command: 'comando', choices: ['once', 'deny'] });
  await eventually(() => assert.equal(runs.approvals().length, 1));
  const waiting = await call('POST', `/v1/runs/${runId}/steer`, { requestId: 'waiting', input: 'No entregar' });
  assert.equal(waiting.status, 409); assert.equal(waiting.json.error.code, 'run_not_accepting_steer');
  await call('POST', `/v1/approvals/pending-approval`, { choice: 'deny' });
  await call('POST', `/v1/runs/${runId}/stop`);
  const stopping = await call('POST', `/v1/runs/${runId}/steer`, { requestId: 'stopping', input: 'No entregar' });
  assert.equal(stopping.status, 409); assert.equal(stopping.json.error.code, 'run_not_accepting_steer');
  hermes.stream(runId).push({ event: 'run.cancelled', seq: 1, pending_steer: 'Instrucción tardía' });
  await eventually(() => assert.equal(runs.busy('default'), false));
  const terminal = await call('POST', `/v1/runs/${runId}/steer`, { requestId: 'terminal', input: 'No entregar' });
  assert.equal(terminal.status, 409); assert.equal(terminal.json.error.code, 'run_not_accepting_steer');
  const snapshot = await call<RunSnapshot>('GET', `/v1/runs/${runId}`);
  assert.equal(snapshot.json.terminal?.pendingSteer, 'Instrucción tardía');
  assert.equal(hermes.callsTo('steerRun').length, 0); assert.equal(hermes.callsTo('stopRun').length, 1);
});

test('#37 invalid JSON and impossible replay cursors fail closed instead of replaying an entire Turn', async (t) => {
  const { base, call, hermes, runs } = await start(t);
  const created = await call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'Entrada' });
  const runId = created.json.runId;
  const malformed = await fetch(`${base}/v1/runs/${runId}/steer`, { method: 'POST', headers: AUTH, body: '{not-json' });
  assert.equal(malformed.status, 400);
  const error = await malformed.json() as ApiError;
  assert.equal(error.error.code, 'invalid_steer_input');
  hermes.stream(runId).push({ event: 'run.completed', seq: 0, output: 'Listo' });
  await eventually(() => assert.equal(runs.busy('default'), false));
  for (const cursor of ['NaN', '1.5', '-1', '9999999999', '9007199254740992']) {
    const response = await fetch(`${base}/v1/runs/${runId}/events`, { headers: { ...AUTH, 'Last-Event-ID': cursor } });
    assert.equal(response.status, 400);
    const invalid = await response.json() as ApiError;
    assert.equal(invalid.error.code, 'invalid_request');
  }
  const resumed = await fetch(`${base}/v1/runs/${runId}/events`, { headers: { ...AUTH, 'Last-Event-ID': String(runs.snapshot(runId).lastEventId) } });
  assert.equal(resumed.status, 200); assert.doesNotMatch(await resumed.text(), /data:/);
  assert.equal(hermes.callsTo('steerRun').length, 0);
});


test('conversation model selection is durable, isolated, validated, and decorates only its next Turn', async (t) => {
  const first = await start(t);
  const catalog = { defaultModel: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, models: [{ provider: 'configured', model: 'org/model', label: 'Model' }] };
  first.hermes.chatHooks.models = async () => catalog;
  assert.deepEqual((await first.call('GET', '/v1/agents/default/models')).json, catalog);
  const created = await first.call<Conversation>('POST', '/v1/agents/default/conversations', { requestId: 'model' });
  const other = await first.call<Conversation>('POST', '/v1/agents/default/conversations', { requestId: 'other' });
  const route = `/v1/agents/default/conversations/${created.json.id}/model`;
  const selected = { provider: 'configured', model: 'org/model' };
  const changed = await first.call<Conversation>('PUT', route, { model: selected });
  assert.equal(changed.status, 200); assert.deepEqual(changed.json.model, selected);
  assert.equal((await first.call<Conversation>('GET', `/v1/agents/default/conversations/${other.json.id}`)).json.model, null);
  assert.equal((await first.call('PUT', route, { model: { provider: 'unconfigured', model: 'org/model' } })).status, 400);
  assert.equal((await first.call('PUT', '/v1/agents/default/conversations/discord-history/model', { model: null })).status, 403);
  assert.equal((await first.call('PUT', route, { model: selected, other: 'rejected' })).status, 400);
  first.stop();
  const second = await start(t, { directory: first.directory, hermes: first.hermes });
  assert.deepEqual((await second.call<Conversation>('GET', `/v1/agents/default/conversations/${created.json.id}`)).json.model, selected);
  const run = await second.call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'Selected', sessionId: created.json.id });
  assert.equal(run.status, 200);
  assert.deepEqual(second.hermes.callsTo('createRun').at(-1)?.args, ['default', { input: 'Selected', sessionId: created.json.id, model: selected }]);
  assert.equal((await second.call('PUT', route, { model: null })).status, 200);
  assert.deepEqual(second.hermes.callsTo('createRun').at(-1)?.args, ['default', { input: 'Selected', sessionId: created.json.id, model: selected }]);
  const otherRun = await second.call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'Default', sessionId: other.json.id });
  assert.equal(otherRun.status, 200); assert.deepEqual(second.hermes.callsTo('createRun').at(-1)?.args, ['default', { input: 'Default', sessionId: other.json.id }]);
  second.hermes.stream(run.json.runId).push({ event: 'run.completed', seq: 0, output: 'Done', model: 'ignored/request', runtime: { model: 'actual/model', provider: 'actual' } });
  await eventually(() => assert.equal(second.runs.busy('default'), true));
  await eventually(() => assert.deepEqual(second.runs.snapshot(run.json.runId).terminal?.runtime, { model: 'actual/model', provider: 'actual' }));
  assert.deepEqual(second.runs.snapshot(run.json.runId).items.find((item) => item.kind === 'assistant'), { kind: 'assistant', id: `${run.json.runId}:message:1`, text: 'Done', at: second.runs.snapshot(run.json.runId).items.at(-1)?.at, runId: run.json.runId, runtime: { model: 'actual/model', provider: 'actual' } });
  assert.equal((await second.call('PUT', route, { model: null })).status, 200);
  const next = await second.call<RunCreated>('POST', '/v1/agents/default/runs', { input: 'Next default', sessionId: created.json.id });
  assert.equal(next.status, 200);
  assert.deepEqual(second.hermes.callsTo('createRun').at(-1)?.args, ['default', { input: 'Next default', sessionId: created.json.id }]);
  const audit = await fs.readFile(path.join(second.directory, 'changes.jsonl'), 'utf8');
  assert.match(audit, /conversation.model.changed/); assert.doesNotMatch(audit, /org\/model|actual\/model|Selected/);
  assert.doesNotMatch(second.logs.join('\n'), /org\/model|actual\/model|Selected/);
});

test('model selection checks protocol and revocation after a delayed catalog before durable mutation', async (t) => {
  const { call, hermes, store } = await start(t);
  const created = await call<Conversation>('POST', '/v1/agents/default/conversations', { requestId: 'revoke-model' });
  assert.equal((await call('GET', '/v1/agents/default/models', undefined, { Authorization: AUTH.Authorization })).status, 426);
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  hermes.chatHooks.models = async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return { defaultModel: { provider: 'p', model: 'm' }, models: [{ provider: 'p', model: 'm', label: 'M' }] }; };
  const changing = call('PUT', `/v1/agents/default/conversations/${created.json.id}/model`, { model: { provider: 'p', model: 'm' } });
  await waiting;
  await store.mutate((state) => { state.devices[0].revokedAt = Date.now(); }); release();
  assert.equal((await changing).status, 403);
  const state = JSON.parse(await fs.readFile(path.join(store.directory, 'conversations.json'), 'utf8'));
  assert.equal(state.conversations[0].model, null);
});


test('a pending model write reserves the Conversation against send and model writes while configured changes fail closed', async (t) => {
  const { call, hermes } = await start(t);
  const defaults = structuredClone(hermes.profilesList);
  const created = await call<Conversation>('POST', '/v1/agents/default/conversations', { requestId: 'model-race' });
  const route = `/v1/agents/default/conversations/${created.json.id}/model`;
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  hermes.chatHooks.models = async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return { defaultModel: { provider: 'p', model: 'default' }, models: [{ provider: 'p', model: 'm', label: 'M' }] }; };
  const pending = call('PUT', route, { model: { provider: 'p', model: 'm' } });
  await waiting;
  assert.equal((await call('PUT', route, { model: null })).status, 409);
  assert.equal((await call('POST', '/v1/agents/default/runs', { input: 'blocked', sessionId: created.json.id })).status, 409);
  release(); assert.equal((await pending).status, 200);
  hermes.chatHooks.models = async () => ({ defaultModel: { provider: 'p', model: 'default' }, models: [] });
  const stale = await call('POST', '/v1/agents/default/runs', { input: 'no effects', sessionId: created.json.id });
  assert.equal(stale.status, 400); assert.equal(stale.json.error.code, 'model_not_configured');
  assert.equal(stale.json.error.message, 'El modelo no está configurado para este Agente. Elige otro modelo.');
  assert.equal(hermes.callsTo('createRun').length, 0);
  assert.deepEqual(hermes.profilesList, defaults);
});
