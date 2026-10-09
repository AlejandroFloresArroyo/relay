import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Approval, RunEvent } from '../../../protocol/protocol.ts';
import { createPairedBridgeClient } from './bridgeClient.ts';
import { clearChatTransportError, planChatTranscript, recordChatTransportError } from './chatConnection.ts';
import { RelayError } from './client.ts';
import { applyRunEvent, buildBlocks, reloadTranscript, type ChatItem } from './transcript.ts';

const approval: Approval = {
  id: 'synthetic-approval', runId: 'synthetic-run', agentId: 'coding', agentName: 'Coding',
  command: 'rm -rf build/', cwd: null, reason: null, affects: null, risk: null,
  createdAt: 1000, expiresAt: 2000, choices: ['once', 'session', 'deny'],
};
const completedTool = (id: string): ChatItem => ({ kind: 'tool', id, tool: 'terminal', preview: approval.command, status: 'done', durationSeconds: 1, result: null, at: 1000 });
const finalMessage: ChatItem = { kind: 'assistant', id: 'final', text: 'Trabajo terminado.', at: 3000 };

async function loseStreamAndRecover(events: RunEvent[], history: ChatItem[], pending: Approval[]) {
  const requests: string[] = [];
  const client = createPairedBridgeClient({
    baseUrl: 'http://atlas.example.ts.net:8650', key: 'synthetic-key', deviceId: 'synthetic-device',
    fetch: (async (url) => {
      const path = new URL(String(url)).pathname;
      requests.push(path);
      if (path.endsWith('/events')) {
        let index = 0;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (index < events.length) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(events[index++])}\n\n`));
            else controller.error(new Error('synthetic stream loss'));
          },
        }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (path.endsWith('/transcript')) return new Response(JSON.stringify({ sessionId: 'conversation', items: history }));
      assert.equal(path, '/v1/approvals');
      return new Response(JSON.stringify({ approvals: pending }));
    }) as typeof fetch,
  });
  let items: ChatItem[] = [];
  const context = { client, agentId: 'coding', pendingCount: 0, retry: 0, reachable: true };
  let state = planChatTranscript({ previous: null, error: null }, context, false).state;
  await assert.rejects(client.runEvents('synthetic-run', (event) => { items = applyRunEvent(items, event, 1000, 'synthetic-run'); }), (error) => {
    assert.ok(error instanceof RelayError);
    assert.equal(error.code, 'unreachable');
    state = recordChatTransportError(state, error);
    return true;
  });
  assert.equal(items.some((item) => item.approval?.id === approval.id), true);
  const offline = planChatTranscript(state, { ...context, reachable: false }, false);
  assert.equal(offline.load, false);
  const recovered = planChatTranscript(offline.state, { ...context, pendingCount: pending.length, reachable: true }, false);
  assert.equal(recovered.load, true);
  const [loaded, authoritativePending] = await Promise.all([client.transcript('coding'), client.approvals()]);
  for (let index = 0; index < 3; index++) items = reloadTranscript(items, 'conversation', loaded, authoritativePending);
  state = clearChatTransportError(recovered.state);
  assert.equal(state.error, null);
  assert.equal(planChatTranscript(state, { ...context, pendingCount: pending.length }, false).load, false);
  assert.deepEqual(requests, ['/v1/runs/synthetic-run/events', '/v1/agents/coding/transcript', '/v1/approvals']);
  const waiting = items.some((item) => item.kind === 'tool' && item.status === 'waiting');
  const busy = waiting; // The stream catch/finally has ended the local running state.
  return { items, waiting, busy, blocks: buildBlocks(items, busy) };
}

test('recovery clears waiting, busy and streaming when resolution and terminal events were lost and no approval remains pending', async () => {
  for (const toolId of [null, 'live-tool', 'hermes-tool']) {
    const events: RunEvent[] = toolId ? [{ type: 'tool.started', toolCallId: 'live-tool', tool: 'terminal', preview: approval.command }] : [];
    events.push({ type: 'approval.request', approval });
    const history: ChatItem[] = toolId ? [completedTool(toolId), finalMessage] : [finalMessage];
    const result = await loseStreamAndRecover(events, history, []);
    assert.equal(result.waiting, false);
    assert.equal(result.busy, false);
    assert.equal(result.items.some((item) => item.feedbackOnly), false);
    assert.equal(result.items.some((item) => item.approval), false);
    assert.deepEqual(result.items, history);
    assert.equal(result.blocks.some((block) => block.kind === 'text' && block.streaming), false);
    assert.equal(result.blocks.some((block) => block.kind === 'activity' && block.running), false);
    assert.doesNotMatch(JSON.stringify(result.blocks), /VENCIDA|"end":"expired"|RECHAZADO/);
  }
});

test('recovery preserves an expiry observed before stream loss even when no approval remains pending', async () => {
  const result = await loseStreamAndRecover([
    { type: 'approval.request', approval },
    { type: 'approval.resolved', approvalId: approval.id, choice: 'deny', resolution: 'expired' },
  ], [finalMessage], []);
  assert.equal(result.waiting, false);
  assert.equal(result.busy, false);
  assert.equal(result.blocks.some((block) => block.kind === 'text' && block.streaming), false);
  assert.deepEqual(result.blocks.flatMap((block) => block.kind === 'terminal' ? [block.end] : []), ['expired']);
  assert.equal(result.items.filter((item) => item.feedbackOnly && item.approval?.outcome === 'expired').length, 1);
});

test('recovery keeps an approval waiting when its ID is still pending on the server', async () => {
  const result = await loseStreamAndRecover([
    { type: 'approval.request', approval },
  ], [{ ...finalMessage, text: 'Esperando una Decisión.' }], [approval]);
  assert.equal(result.waiting, true);
  assert.equal(result.busy, true);
  assert.equal(result.blocks.some((block) => block.kind === 'text' && block.streaming), true);
  const feedback = result.items.find((item) => item.feedbackOnly);
  assert.equal(feedback?.kind === 'tool' && feedback.status, 'waiting');
  assert.equal(feedback?.approval?.id, approval.id);
  assert.equal(feedback?.approval?.outcome, undefined);
  assert.doesNotMatch(JSON.stringify(result.blocks), /VENCIDA|"end":"expired"|RECHAZADO/);
});
