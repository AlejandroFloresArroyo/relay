import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoClient, resetDemo } from './demo.ts';

test('changing a demo Conversation model persists in its transcript and list without changing the Agent default', async () => {
  resetDemo();
  const client = createDemoClient('atlas', () => 1_800_000_000_000);
  const conversation = await client.conversation('dev', 'demo-dev');
  const options = await client.models('dev');
  assert.equal(options.models.length, 4);
  const selected = { provider: 'openrouter', model: 'claude-sonnet-4.5' };
  const updated = await client.setConversationModel('dev', conversation.id, { model: selected });
  assert.deepEqual(updated.model, selected);
  assert.deepEqual((await client.transcript('dev', conversation.sessionId)).conversation?.model, selected);
  assert.deepEqual((await client.conversations('dev')).conversations.find((row) => row.id === conversation.id)?.model, selected);
  assert.equal((await client.agents())[0].model, 'qwen3-coder-480b');
  assert.equal((await client.conversation('dev', 'demo-dev-caddy')).model, null);
  assert.equal((await client.setConversationModel('dev', conversation.id, { model: null })).model, null);
});


test('a demo model change during a Turn applies only to the next Turn', async () => {
  resetDemo();
  const client = createDemoClient('atlas', () => 1_800_000_000_000);
  const conversation = await client.conversation('dev', 'demo-dev');
  const first = { provider: 'openrouter', model: 'claude-sonnet-4.5' };
  const next = { provider: 'ollama', model: 'llama-3.3-70b' };
  await client.setConversationModel('dev', conversation.id, { model: first });
  const run = await client.startRun('dev', { input: 'Hola', sessionId: conversation.sessionId });
  await client.setConversationModel('dev', conversation.id, { model: next });
  await client.runEvents(run.runId, () => {}, undefined, -1);
  const terminal = (await client.runSnapshot(run.runId)).terminal;
  assert.deepEqual(terminal?.runtime, first);
  const following = await client.startRun('dev', { input: 'Siguiente', sessionId: conversation.sessionId });
  await client.runEvents(following.runId, () => {}, undefined, -1);
  assert.deepEqual((await client.runSnapshot(following.runId)).terminal?.runtime, next);
  const transcript = await client.transcript('dev', conversation.sessionId);
  assert.deepEqual(transcript.items.filter((item) => item.kind === 'assistant').at(-1)?.runtime, next);
});
