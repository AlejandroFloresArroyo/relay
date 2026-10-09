import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRunEvent, buildBlocks, reloadTranscript, type ChatItem } from './transcript.ts';

const runtime = { provider: 'fallback', model: 'actual-model' };
test('only the final assistant response receives actual Hermes runtime, including snapshot recovery', () => {
  let items: ChatItem[] = [{ kind: 'user', id: 'u', text: 'Hola', at: 1, runId: 'r' }];
  items = applyRunEvent(items, { type: 'message.delta', text: 'Voy a consultar.' }, 2, 'r');
  items = applyRunEvent(items, { type: 'tool.started', toolCallId: 't', tool: 'terminal', preview: 'pwd' }, 3, 'r');
  items = applyRunEvent(items, { type: 'message.delta', text: 'Respuesta final' }, 4, 'r');
  items = applyRunEvent(items, { type: 'run.completed', output: 'Respuesta final', runtime }, 5, 'r');
  const assistants = items.filter((item) => item.kind === 'assistant');
  assert.equal(assistants[0].runtime, undefined);
  assert.deepEqual(assistants[1].runtime, runtime);
  const texts = buildBlocks(items, false).filter((block) => block.kind === 'text');
  assert.deepEqual(texts[1].runtime, runtime);
  const reloaded = reloadTranscript(items, 'c', { sessionId: 'c', items: items.map((item) => {
    if (item.kind !== 'assistant') return item;
    const copy = { ...item }; delete copy.runtime; return copy;
  }) });
  assert.deepEqual(reloaded.filter((item) => item.kind === 'assistant')[1].runtime, runtime);
  assert.equal(reloadTranscript(items, 'c', { sessionId: 'other', items: [{ kind: 'assistant', id: assistants[1].id, text: 'Otro chat', at: 4 }] }).filter((item) => item.kind === 'assistant')[0].runtime, undefined);
});

test('terminal runtime never labels a previous Turn or an error as the model response', () => {
  const previous: ChatItem[] = [{ kind: 'assistant', id: 'old', text: 'Anterior', at: 1, runId: 'old-run' }];
  assert.deepEqual(applyRunEvent(previous, { type: 'run.completed', output: '', runtime }, 2, 'new-run'), previous);
  const failed = applyRunEvent(previous, { type: 'run.failed', error: 'Fallo', runtime }, 3, 'new-run');
  assert.equal(failed.filter((item) => item.kind === 'assistant')[0].runtime, undefined);
  assert.equal(failed.filter((item) => item.kind === 'assistant')[1].runtime, undefined);
  const output = applyRunEvent(previous, { type: 'run.completed', output: 'Nueva', runtime }, 4, 'new-run');
  assert.equal(output.length, 2);
  assert.deepEqual(output.filter((item) => item.kind === 'assistant')[1].runtime, runtime);
});
