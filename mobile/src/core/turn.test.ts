import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunSnapshot } from '../../../protocol/protocol.ts';
import { applyRunEvent, type ChatItem } from './transcript.ts';
import { mergeTurnSnapshot } from './turn.ts';

const history: ChatItem[] = [{ kind: 'assistant', id: 'history', text: 'Historia anterior', at: 1 }];
const input: ChatItem = { kind: 'user', id: 'local-input', runId: 'r1', text: 'Revisa la integración', at: 2 };
const partial: ChatItem = { kind: 'assistant', id: 'local-answer', text: 'Lo recibido hasta aquí', at: 3 };
const tool: ChatItem = { kind: 'tool', id: 'r1:tool:0', tool: 'terminal', preview: 'npm test', status: 'done', durationSeconds: 1, result: 'PASS', at: 4 };
const snapshot: RunSnapshot = { runId: 'r1', conversationId: 'c1', sessionId: 's1', phase: 'running', connection: 'connected', lastEventId: 7, complete: false, items: [], steers: [], terminal: null };

test('incomplete Turn snapshots never erase existing history, partial text, input or tools', () => {
  const previous = [...history, input, partial, tool];
  assert.deepEqual(mergeTurnSnapshot(history, previous, snapshot), previous);
  const incoming = { ...snapshot, items: [{ ...input, id: 'r1:input' }, { ...partial, id: 'r1:message:1', text: 'Lo recibido' }] };
  const merged = mergeTurnSnapshot(history, previous, incoming);
  assert.equal(merged.length, previous.length);
  assert.equal(merged[2].kind === 'assistant' && merged[2].text, partial.text);
  assert.equal(merged[3], tool);
  assert.equal(previous[2], partial);
});

test('complete snapshots replace only this Turn and incomplete steering matches request identity rather than prose', () => {
  const steering: ChatItem = { kind: 'user', id: 'local-steer', runId: 'r1', clientMessageId: 'request-1', redirected: true, text: 'Solo integración', at: 5 };
  const incoming = { ...snapshot, items: [{ ...input, id: 'r1:input' }, { ...steering, id: 'r1:steer:0' }] };
  const merged = mergeTurnSnapshot(history, [...history, input, steering], incoming);
  assert.equal(merged.filter((item) => item.kind === 'user' && item.clientMessageId === 'request-1').length, 1);
  assert.deepEqual(mergeTurnSnapshot(history, [...history, input, partial, tool], { ...incoming, complete: true }), [...history, ...incoming.items]);
});

test('terminal full output repairs assistant text without inventing missing tools or removing retained evidence', () => {
  const terminal = { ...snapshot, phase: 'completed' as const, terminal: { type: 'run.completed' as const, output: 'Respuesta final' }, items: [{ ...input, id: 'r1:input' }, { ...partial, id: 'r1:message:1', text: 'Respuesta final' }] };
  const merged = mergeTurnSnapshot(history, [...history, input, partial, tool], terminal);
  assert.equal(merged[2].kind === 'assistant' && merged[2].text, 'Respuesta final');
  assert.equal(merged[3], tool);
  assert.equal(terminal.complete, false);
});

test('a truncated snapshot keeps distinct assistant block identities instead of merging a later block into the first', () => {
  const first: ChatItem = { ...partial, id: 'r1:message:1', text: 'Primer bloque conservado' };
  const last: ChatItem = { ...partial, id: 'r1:message:2', text: 'Último bloque conservado' };
  const incoming = { ...snapshot, items: [{ ...last, text: 'Último bloque' }] };
  const merged = mergeTurnSnapshot(history, [...history, input, first, tool, last], incoming);
  assert.equal(merged[2].kind === 'assistant' && merged[2].text, first.text);
  assert.equal(merged[4].kind === 'assistant' && merged[4].text, last.text);
  assert.equal(merged.filter((item) => item.kind === 'assistant' && item.id === first.id).length, 1);
});

test('incomplete snapshots match real Puente assistant ordinals without duplicating or swapping live blocks', () => {
  let live = applyRunEvent([...history, input], { type: 'message.delta', text: 'Primer bloque más largo' }, 3, 'r1');
  live = applyRunEvent(live, { type: 'tool.started', toolCallId: tool.id, tool: tool.tool, preview: tool.preview }, 4, 'r1');
  live = applyRunEvent(live, { type: 'message.delta', text: 'Segundo bloque' }, 5, 'r1');
  const incoming: RunSnapshot = { ...snapshot, items: [
    { ...input, id: 'r1:input' },
    { ...partial, id: 'r1:message:1', text: 'Primer bloque' },
    tool,
    { ...partial, id: 'r1:message:2', text: 'Segundo bloque completo' },
  ] };
  const merged = mergeTurnSnapshot(history, live, incoming);
  assert.deepEqual(merged.slice(history.length).map((item) => item.kind), ['user', 'assistant', 'tool', 'assistant']);
  assert.deepEqual(merged.slice(history.length).filter((item) => item.kind === 'assistant').map((item) => item.text), ['Primer bloque más largo', 'Segundo bloque completo']);
});

test('both complete and incomplete snapshots preserve observed approval rejection and expiry', () => {
  for (const resolution of ['decision', 'expired'] as const) {
    let live = applyRunEvent([...history, input], { type: 'tool.started', toolCallId: tool.id, tool: tool.tool, preview: tool.preview }, 3, 'r1');
    live = applyRunEvent(live, { type: 'approval.request', approval: { id: 'approval-1', runId: 'r1', command: tool.preview } as never }, 4, 'r1');
    live = applyRunEvent(live, { type: 'approval.resolved', approvalId: 'approval-1', choice: 'deny', resolution }, 5, 'r1');
    for (const complete of [true, false]) {
      const merged = mergeTurnSnapshot(history, live, { ...snapshot, complete, items: [input, { ...tool, status: 'running' }] });
      const observed: ChatItem | undefined = merged.find((item) => item.kind === 'tool' && item.id === tool.id);
      assert.equal(observed?.approval?.outcome, resolution === 'expired' ? 'expired' : 'rejected');
      assert.equal(observed?.kind === 'tool' && observed.status, 'error');
    }
  }
});
