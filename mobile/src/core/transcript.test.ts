import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Approval } from '../../../protocol/protocol.ts';
import { applyRunEvent, buildBlocks, mergeTranscript, reloadTranscript, type ChatItem } from './transcript.ts';

const approval = (id = 'ap1', expiresAt: number | null = 1000) => ({ id, expiresAt } as Approval);
const start = (id = 't1'): Extract<ChatItem, { kind: 'tool' }> => ({ kind: 'tool', id, tool: 'terminal', preview: 'rm -rf ./build', status: 'running', durationSeconds: null, result: null, at: 0 });

test('reloading the same conversation keeps observed decisions; a new conversation does not inherit them', () => {
  const waiting = applyRunEvent([start()], { type: 'approval.request', approval: approval() }, 100);
  const expired = applyRunEvent(waiting, { type: 'approval.resolved', approvalId: 'ap1', choice: 'deny', resolution: 'expired' }, 1000);
  const loaded: ChatItem[] = [{ ...start(), status: 'error' }];
  assert.equal(mergeTranscript(expired, loaded)[0].approval?.outcome, 'expired');
  assert.equal(mergeTranscript([], loaded)[0].approval, undefined);
});

test('an expired approval reads VENCIDA in the activity and is a terminal block that ended expired, without a red line', () => {
  let items = applyRunEvent([start()], { type: 'approval.request', approval: approval() }, 100);
  items = applyRunEvent(items, { type: 'approval.resolved', approvalId: 'ap1', choice: 'deny', resolution: 'expired' }, 1000);
  const blocks = buildBlocks(items, false);
  assert.equal(blocks[0].kind === 'activity' && blocks[0].steps[0].status, 'error');
  assert.equal(blocks[0].kind === 'activity' && blocks[0].steps[0].outcome, 'VENCIDA');
  assert.equal(blocks[1].kind === 'terminal' && blocks[1].end, 'expired');
  assert.deepEqual(blocks[1].kind === 'terminal' && blocks[1].lines, [[{ text: '$ rm -rf ./build', tone: 'dim' }]]);
});

test('a decision plus deny remains rejected even when it arrives after the approval deadline', () => {
  const waiting = applyRunEvent([start()], { type: 'approval.request', approval: approval() }, 100);
  const items = applyRunEvent(waiting, { type: 'approval.resolved', approvalId: 'ap1', choice: 'deny', resolution: 'decision' }, 2000);
  const blocks = buildBlocks(items, false);
  assert.equal(blocks[0].kind === 'activity' && blocks[0].steps[0].outcome, 'RECHAZADO');
  assert.ok(!JSON.stringify(blocks).includes('VENCIDA'));
});

test('a legacy deny without resolution remains rejected even after the approval deadline', () => {
  const waiting = applyRunEvent([start()], { type: 'approval.request', approval: approval() }, 100);
  const items = applyRunEvent(waiting, { type: 'approval.resolved', approvalId: 'ap1', choice: 'deny' }, 2000);
  const blocks = buildBlocks(items, false);
  assert.equal(blocks[0].kind === 'activity' && blocks[0].steps[0].outcome, 'RECHAZADO');
  assert.ok(!JSON.stringify(blocks).includes('VENCIDA'));
});

test('an explicit expiry is shown even before the phone thinks the deadline has passed', () => {
  const waiting = applyRunEvent([start()], { type: 'approval.request', approval: approval() }, 100);
  const items = applyRunEvent(waiting, { type: 'approval.resolved', approvalId: 'ap1', choice: 'deny', resolution: 'expired' }, 200);
  const activity = buildBlocks(items, false)[0];
  assert.equal(activity.kind === 'activity' && activity.steps[0].outcome, 'VENCIDA');
});

test('resolution matches the approval id, survives tool completion and leaves unrelated steps waiting', () => {
  let items = applyRunEvent([start()], { type: 'approval.request', approval: approval() }, 100);
  items = applyRunEvent([...items, start('t2')], { type: 'approval.request', approval: approval('ap2') }, 200);
  items = applyRunEvent(items, { type: 'approval.resolved', approvalId: 'ap1', choice: 'deny', resolution: 'expired' }, 1001);
  items = applyRunEvent(items, { type: 'tool.completed', toolCallId: 't1', tool: 'terminal', error: true, durationSeconds: 1, preview: 'Denied' }, 1002);
  const unrelated = items.find((it) => it.id === 't2');
  assert.equal(unrelated?.kind === 'tool' && unrelated.status, 'waiting');
  const activity = buildBlocks(items, false)[0];
  assert.equal(activity.kind === 'activity' && activity.steps[0].outcome, 'VENCIDA');
  assert.deepEqual(applyRunEvent(items, { type: 'approval.resolved', approvalId: 'unknown', choice: 'deny' }, 1003), items);
});

const completeApproval: Approval = {
  id: 'req_a', runId: 'run_1', agentId: 'coding', agentName: 'Coding',
  command: 'rm -rf build/', cwd: null, reason: null, affects: null, risk: null,
  createdAt: 1_000_000, expiresAt: 1_300_000, choices: ['once', 'session', 'deny'],
};
const expiryLines = (items: ChatItem[]) => buildBlocks(items, false).flatMap((b) =>
  b.kind === 'terminal' && b.end === 'expired' ? [b.end] : []);

test('request then explicit expiry without tool.started shows the expired command', () => {
  const waiting = applyRunEvent([], { type: 'approval.request', approval: completeApproval }, 1_000_000);
  const expired = applyRunEvent(waiting, { type: 'approval.resolved', approvalId: 'req_a', choice: 'deny', resolution: 'expired' }, 1_300_000);
  assert.deepEqual(expiryLines(expired), ['expired']);
  assert.ok(JSON.stringify(buildBlocks(expired, false)).includes('$ rm -rf build/'));
});

test('same-conversation refresh keeps live expiry with different SSE and Hermes call ids', () => {
  let items = applyRunEvent([start('run_1:tool:1')], { type: 'approval.request', approval: completeApproval }, 1_000_000);
  items = applyRunEvent(items, { type: 'approval.resolved', approvalId: 'req_a', choice: 'deny', resolution: 'expired' }, 1_300_000);
  const history: ChatItem[] = [{ ...start('call_hermes123'), status: 'error' }];
  const refreshed = mergeTranscript(items, history);
  assert.deepEqual(expiryLines(refreshed), ['expired']);
  assert.equal(expiryLines(mergeTranscript(refreshed, history)).length, 1);
  assert.deepEqual(expiryLines(mergeTranscript([], history)), []);
  assert.equal(refreshed.filter((it) => !it.feedbackOnly).length, 1);
});

test('a matching-id refresh still retains evidence for a later differing-id refresh', () => {
  let items = applyRunEvent([start('run_1:tool:1')], { type: 'approval.request', approval: completeApproval }, 1_000_000);
  items = applyRunEvent(items, { type: 'approval.resolved', approvalId: 'req_a', choice: 'deny', resolution: 'expired' }, 1_300_000);
  items = mergeTranscript(items, [{ ...start('run_1:tool:1'), status: 'error' }]);
  assert.equal(expiryLines(items).length, 1);
  items = mergeTranscript(items, [{ ...start('call_hermes123'), status: 'error' }]);
  assert.equal(expiryLines(items).length, 1);
});

test('conversation reload retains only feedback observed in the currently mounted conversation', () => {
  let items = applyRunEvent([], { type: 'approval.request', approval: completeApproval }, 1_000_000);
  items = applyRunEvent(items, { type: 'approval.resolved', approvalId: 'req_a', choice: 'deny', resolution: 'expired' }, 1_300_000);
  const itemsFromHermes = [{ ...start('call_hermes123'), status: 'error' as const }];
  assert.equal(expiryLines(reloadTranscript(items, 'session1', { sessionId: 'session1', items: itemsFromHermes })).length, 1);
  assert.equal(expiryLines(reloadTranscript(items, 'session1', { sessionId: 'session2', items: itemsFromHermes })).length, 0);
  assert.equal(expiryLines(reloadTranscript([], null, { sessionId: 'session1', items: itemsFromHermes })).length, 0);
});

const terminalEvents = [
  { type: 'run.cancelled' }, { type: 'run.failed', error: 'Stopped' }, { type: 'run.completed', output: '' },
] as const;
for (const event of terminalEvents) {
  test(`${event.type} clears unresolved feedback before and after history refresh without inventing expiry`, () => {
    const waiting = applyRunEvent([], { type: 'approval.request', approval: completeApproval }, 1_000_000);
    const ended = applyRunEvent(waiting, event, 1_000_001);
    assert.equal(ended.some((item) => item.kind === 'tool' && item.status === 'waiting'), false);
    assert.equal(ended.filter((item) => item.feedbackOnly).length, 0);
    const refreshed = reloadTranscript(ended, 'session1', { sessionId: 'session1', items: [] });
    assert.equal(refreshed.some((item) => item.kind === 'tool' && item.status === 'waiting'), false);
    assert.deepEqual(buildBlocks(refreshed, false), []);
    assert.deepEqual(expiryLines(ended), []);
  });
  test(`${event.type} preserves an observed expiry across history refresh`, () => {
    let items = applyRunEvent([], { type: 'approval.request', approval: completeApproval }, 1_000_000);
    items = applyRunEvent(items, { type: 'approval.resolved', approvalId: 'req_a', choice: 'deny', resolution: 'expired' }, 1_300_000);
    items = applyRunEvent(items, event, 1_300_001);
    const refreshed = reloadTranscript(items, 'session1', { sessionId: 'session1', items: [] });
    assert.deepEqual(expiryLines(refreshed), ['expired']);
  });
}

test('terminal cleanup belongs to the ending run and settles its associated waiting tool', () => {
  let items = applyRunEvent([start('run_1:tool:1')], { type: 'approval.request', approval: completeApproval }, 1_000_000);
  const other = { ...completeApproval, id: 'req_b', runId: 'run_2' };
  items = applyRunEvent(items, { type: 'approval.request', approval: other }, 1_000_001);
  items = applyRunEvent(items, { type: 'run.cancelled' }, 1_000_002, 'run_1');
  const associated = items.find((item) => item.id === 'run_1:tool:1');
  assert.equal(associated?.kind === 'tool' && associated.status, 'error');
  assert.deepEqual(items.filter((item) => item.feedbackOnly).map((item) => item.approval?.id), ['req_b']);
  assert.deepEqual(expiryLines(items), []);
});

test('non-expired decisions release retained records through repeated requests and refreshes while keeping expiry', () => {
  let items = applyRunEvent([], { type: 'approval.request', approval: completeApproval }, 1_000_000);
  items = applyRunEvent(items, { type: 'approval.resolved', approvalId: 'req_a', choice: 'deny', resolution: 'expired' }, 1_300_000);
  for (let index = 0; index < 1000; index++) {
    const request = { ...completeApproval, id: `decided_${index}` };
    items = applyRunEvent(items, { type: 'approval.request', approval: request }, 1_300_001 + index);
    items = applyRunEvent(items, { type: 'approval.resolved', approvalId: request.id, choice: 'once', resolution: 'decision' }, 1_300_002 + index);
    assert.equal(items.filter((item) => item.feedbackOnly).length, 1);
    items = reloadTranscript(items, 'session1', { sessionId: 'session1', items: [] });
    assert.deepEqual(items.filter((item) => item.feedbackOnly).map((item) => item.approval?.id), ['req_a']);
  }
  assert.equal(expiryLines(items).length, 1);
});

test('non-expired rejection and legacy decisions release their independent records', () => {
  for (const choice of ['deny', 'once', 'session'] as const) {
    for (const resolution of ['decision', undefined] as const) {
      const waiting = applyRunEvent([], { type: 'approval.request', approval: completeApproval }, 1_000_000);
      const decided = applyRunEvent(waiting, { type: 'approval.resolved', approvalId: 'req_a', choice, resolution }, 1_000_001);
      assert.deepEqual(decided, []);
    }
  }
});

test('text blocks preserve raw Markdown and only confirmed user instructions carry redirected evidence', () => {
  const raw = '\n```js\n  **literal**\n```\n';
  const blocks = buildBlocks([
    { kind: 'user', id: 'normal', text: '**literal input**', at: 0 },
    { kind: 'assistant', id: 'reply', text: raw, at: 1 },
    { kind: 'user', id: 'steer', text: 'Cambia el enfoque', at: 2, redirected: true },
  ], false);
  assert.equal(blocks[0].kind === 'user' && blocks[0].text, '**literal input**');
  assert.equal(blocks[0].kind === 'user' && blocks[0].redirected, undefined);
  assert.equal(blocks[1].kind === 'text' && blocks[1].text, raw);
  assert.equal(blocks[2].kind === 'user' && blocks[2].redirected, true);
});

test('chat control events leave transcript content to the Turn controller', () => {
  const items: ChatItem[] = [{ kind: 'assistant', id: 'partial', text: 'Respuesta parcial', at: 1 }];
  assert.equal(applyRunEvent(items, { type: 'run.connection', connection: 'lost' }, 2), items);
  assert.equal(applyRunEvent(items, { type: 'run.steered', requestId: 'steer', accepted: true }, 3), items);
  assert.equal(applyRunEvent(items, { type: 'run.steer_pending', text: 'Texto sin entregar' }, 4), items);
  assert.equal(applyRunEvent(items, { type: 'run.resync_required', reason: 'upstream_replay_lost' }, 5), items);
});

test('history refresh retains confirmed steering only by message or request identity, never matching prose', () => {
  const previous: ChatItem[] = [{ kind: 'user', id: 'local-steer', clientMessageId: 'request-1', redirected: true, text: 'Mismo texto', at: 1 }];
  const loaded: ChatItem[] = [
    { kind: 'user', id: 'wire-steer', clientMessageId: 'request-1', text: 'Mismo texto', at: 2 },
    { kind: 'user', id: 'local-steer', text: 'Mismo texto', at: 3 },
    { kind: 'user', id: 'unrelated', text: 'Mismo texto', at: 4 },
  ];
  assert.deepEqual(mergeTranscript(previous, loaded).map((item) => item.kind === 'user' ? item.redirected : undefined), [true, true, undefined]);
  assert.ok(reloadTranscript(previous, 'old', { sessionId: 'new', items: loaded }).every((item) => item.kind !== 'user' || !item.redirected));
});
