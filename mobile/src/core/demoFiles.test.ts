import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDemoClient, resetDemo } from './demo.ts';
import { setDemoFileScenario } from './demoFiles.ts';
import { RelayError } from './client.ts';
test('file demo covers produced image/document, progress, oversize and missing states in the real Conversation contract', async () => {
  resetDemo(); const client = createDemoClient('atlas', () => 1_800_000_000_000);
  setDemoFileScenario('atlas', 'produced');
  const transcript = await client.transcript('dev', 'demo-dev');
  assert.ok(transcript.items.some((item) => item.kind === 'assistant' && item.text.includes('MEDIA:')));
  const page = await client.conversationFiles('dev', 'demo-dev');
  assert.equal(page.files.length, 3); assert.equal(page.files[1].mimeType, 'image/png'); assert.ok(page.displayMessages?.length);
  let size = 0; const downloaded = await client.downloadConversationFile('dev', 'demo-dev', page.files[0].id, async (chunk) => { size += chunk.length; });
  assert.equal(size, page.files[0].size); assert.equal(downloaded.bytes, size);
  setDemoFileScenario('atlas', 'states');
  const states = await client.conversationFiles('dev', 'demo-dev');
  assert.deepEqual(states.files.map((file) => file.status), ['ready', 'too_large', 'missing']);
  await assert.rejects(client.downloadConversationFile('dev', 'demo-dev', states.files[1].id, async () => {}), (error: unknown) => error instanceof RelayError && error.code === 'file_too_large');
});
