import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createDecisionStore, deferredDecisionStore, type DecisionStore } from '../src/decisionStore.ts';

import type { Approval, ChatRunEvent, RunEvent } from '../../protocol/protocol.ts';
import { HermesError } from '../src/hermes.ts';
import type { AgentProfile, UpstreamEvent } from '../src/hermes.ts';
import { RunManager } from '../src/runs.ts';
import type { Timers } from '../src/runs.ts';
import { settle, eventually } from '../support/channel.ts';
import { FakeHermes } from '../support/fake_hermes.ts';

const CODING: AgentProfile = { id: 'coding', name: 'Coding', model: 'm', provider: 'p' };
const DEFAULT: AgentProfile = { id: 'default', name: 'Default', model: 'm', provider: 'p' };

class ManualTimers implements Timers {
  pending: { fn: () => void; at: number; cancelled: boolean }[] = [];
  now = 1_000_000;

  set(fn: () => void, ms: number): unknown {
    const entry = { fn, at: this.now + ms, cancelled: false };
    this.pending.push(entry);
    return entry;
  }

  clear(handle: unknown): void {
    (handle as { cancelled: boolean }).cancelled = true;
  }

  advance(ms: number): void {
    this.now += ms;
    for (const entry of this.pending) {
      if (!entry.cancelled && entry.at <= this.now) {
        entry.cancelled = true;
        entry.fn();
      }
    }
  }
}

function setup(decisionStore?: DecisionStore) {
  const hermes = new FakeHermes();
  const timers = new ManualTimers();
  const notified: Approval[] = [];
  const logs: string[] = [];
  const runs = new RunManager({
    hermes, decisionStore,
    notifier: {
      async approvalCreated(approval) {
        notified.push(approval);
      },
    },
    now: () => timers.now,
    timers,
    sleep: async () => {},
    log: (line) => logs.push(line),
  });
  return { hermes, timers, notified, logs, runs };
}

function ev(event: string, seq: number, fields: Record<string, unknown> = {}): UpstreamEvent {
  return { event, seq, run_id: 'run_1', timestamp: 1000, ...fields };
}

function approvalRequest(seq: number, fields: Record<string, unknown> = {}): UpstreamEvent {
  return ev('approval.request', seq, {
    command: 'rm -rf build/',
    description: 'recursive delete',
    pattern_key: 'recursive delete',
    pattern_keys: ['recursive delete'],
    request_id: 'req_a',
    choices: ['once', 'session', 'always', 'deny'],
    timestamp: 1000,
    ...fields,
  });
}

function collect(runs: RunManager, runId: string, afterSeq = -1) {
  const events: ChatRunEvent[] = [];
  const seqs: number[] = [];
  let closed = false;
  const unsubscribe = runs.subscribe(
    runId,
    afterSeq,
    (seq, event) => {
      seqs.push(seq);
      events.push(event);
    },
    () => {
      closed = true;
    },
  );
  return { events, seqs, isClosed: () => closed, unsubscribe };
}

test('start creates the run upstream for that profile and returns its ids', async () => {
  const { hermes, runs } = setup();
  const created = await runs.start(CODING, { input: 'run the tests', sessionId: 'sess_9' });
  assert.deepEqual(created, { runId: 'run_1', sessionId: 'sess_9' });
  assert.deepEqual(hermes.callsTo('createRun')[0].args, ['coding', { input: 'run the tests', sessionId: 'sess_9' }]);
  await settle();
  assert.deepEqual(hermes.callsTo('runEvents')[0].args, ['coding', 'run_1', null]);
});

test('maps upstream events to the protocol RunEvent shapes', async () => {
  const { hermes, runs } = setup();
  const { runId } = await runs.start(CODING, { input: 'go' });
  const seen = collect(runs, runId);
  const stream = hermes.stream(runId);

  stream.push(ev('message.delta', 0, { delta: 'Hel' }));
  stream.push(ev('message.delta', 1, { delta: 'lo' }));
  stream.push(ev('tool.started', 2, { tool: 'terminal', preview: 'npm test' }));
  stream.push(ev('message.interim', 3, { text: 'thinking out loud', already_streamed: true }));
  stream.push(ev('tool.completed', 4, { tool: 'terminal', duration: 1.25, error: false, preview: '12 passed' }));
  stream.push(ev('run.completed', 5, { output: 'Hello' }));
  stream.end();
  await settle();

  assert.deepEqual(seen.events, [
    { type: 'message.delta', text: 'Hel' },
    { type: 'message.delta', text: 'lo' },
    { type: 'tool.started', toolCallId: 'run_1:tool:1', tool: 'terminal', preview: 'npm test' },
    {
      type: 'tool.completed',
      toolCallId: 'run_1:tool:1',
      tool: 'terminal',
      durationSeconds: 1.25,
      error: false,
      preview: '12 passed',
    },
    { type: 'run.completed', output: 'Hello' },
  ]);
  assert.equal(seen.isClosed(), true);
});

test('a completed tool is paired with the oldest running call of the same tool', async () => {
  const { hermes, runs } = setup();
  const { runId } = await runs.start(CODING, { input: 'go' });
  const seen = collect(runs, runId);
  const stream = hermes.stream(runId);
  stream.push(ev('tool.started', 0, { tool: 'read_file', preview: 'a.ts' }));
  stream.push(ev('tool.started', 1, { tool: 'terminal', preview: 'ls' }));
  stream.push(ev('tool.started', 2, { tool: 'read_file', preview: 'b.ts' }));
  stream.push(ev('tool.completed', 3, { tool: 'terminal', duration: 0.1, error: true, preview: 'boom' }));
  stream.push(ev('tool.completed', 4, { tool: 'read_file', duration: 0.2, error: false, preview: 'A' }));
  stream.push(ev('tool.completed', 5, { tool: 'read_file', duration: 0.3, error: false, preview: 'B' }));
  await settle();

  const ids = seen.events.map((event) => ('toolCallId' in event ? event.toolCallId : null));
  assert.deepEqual(ids, ['run_1:tool:1', 'run_1:tool:2', 'run_1:tool:3', 'run_1:tool:2', 'run_1:tool:1', 'run_1:tool:3']);
  assert.equal((seen.events[3] as { error: boolean }).error, true);
});

test('run.failed, run.cancelled and run.interrupted end the stream', async () => {
  for (const [upstream, expected] of [
    [ev('run.failed', 0, { error: 'model timeout' }), { type: 'run.failed', error: 'model timeout' }],
    [ev('run.cancelled', 0), { type: 'run.cancelled' }],
    [
      ev('run.interrupted', 0, { error: 'Gateway shutdown interrupted the run.' }),
      { type: 'run.failed', error: 'Gateway shutdown interrupted the run.' },
    ],
  ] as [UpstreamEvent, RunEvent][]) {
    const { hermes, runs } = setup();
    const { runId } = await runs.start(CODING, { input: 'go' });
    const seen = collect(runs, runId);
    hermes.stream(runId).push(upstream);
    await settle();
    assert.deepEqual(seen.events, [expected]);
    assert.equal(seen.isClosed(), true);
    assert.equal(runs.busy('coding'), false);
  }
});

test('a late subscriber gets the whole backlog, and can resume after a given seq', async () => {
  const { hermes, runs } = setup();
  const { runId } = await runs.start(CODING, { input: 'go' });
  const stream = hermes.stream(runId);
  stream.push(ev('message.delta', 0, { delta: 'a' }));
  stream.push(ev('message.delta', 1, { delta: 'b' }));
  await settle();

  const all = collect(runs, runId);
  assert.deepEqual(all.seqs, [0, 1]);
  const resumed = collect(runs, runId, 0);
  assert.deepEqual(resumed.events, [{ type: 'message.delta', text: 'b' }]);

  stream.push(ev('message.delta', 2, { delta: 'c' }));
  await settle();
  assert.deepEqual(all.seqs, [0, 1, 2]);
  assert.deepEqual(resumed.seqs, [1, 2]);

  all.unsubscribe?.();
  stream.push(ev('message.delta', 3, { delta: 'd' }));
  await settle();
  assert.deepEqual(all.seqs, [0, 1, 2], 'an unsubscribed listener receives nothing more');
  assert.deepEqual(resumed.seqs, [1, 2, 3]);
});

test('subscribing to an unknown run returns null', () => {
  const { runs } = setup();
  assert.equal(runs.subscribe('run_nope', -1, () => {}, () => {}), null);
  assert.equal(runs.has('run_nope'), false);
});

test('records an approval in the inbox with no client attached, and notifies', async () => {
  const { hermes, runs, notified } = setup();
  const { runId } = await runs.start(CODING, { input: 'clean up' });
  hermes.stream(runId).push(approvalRequest(0));
  await settle();

  const expected: Approval = {
    id: 'req_a',
    runId: 'run_1',
    agentId: 'coding',
    agentName: 'Coding',
    command: 'rm -rf build/',
    cwd: null,
    reason: null,
    affects: null,
    risk: { level: 3, label: 'RIESGO MEDIO', summary: 'recursive delete' },
    createdAt: 1_000_000,
    expiresAt: 1_300_000,
    choices: ['once', 'session', 'always', 'deny'],
  };
  assert.deepEqual(runs.approvals(), [expected]);
  assert.deepEqual(notified, [expected]);
  assert.equal(runs.pendingFor('coding'), 1);
  assert.equal(runs.pendingFor('default'), 0);
  assert.equal(runs.busy('coding'), true);

  const seen = collect(runs, runId);
  assert.deepEqual(seen.events, [{ type: 'approval.request', approval: expected }]);
});

test('an approval with an unknown pattern has risk null and uses only the choices Hermes offered', async () => {
  const { hermes, runs } = setup();
  const { runId } = await runs.start(CODING, { input: 'x' });
  hermes.stream(runId).push(
    approvalRequest(0, { pattern_key: 'mcp trust gate', description: 'untrusted server', choices: ['once', 'deny', 'bogus'] }),
  );
  await settle();
  const [approval] = runs.approvals();
  assert.equal(approval.risk, null);
  assert.deepEqual(approval.choices, ['once', 'deny']);
});

test('an approval without request_id gets a bridge id and is relayed without one', async () => {
  const { hermes, runs } = setup();
  const { runId } = await runs.start(CODING, { input: 'x' });
  hermes.stream(runId).push(approvalRequest(0, { request_id: undefined }));
  await settle();
  const [approval] = runs.approvals();
  assert.equal(approval.id, 'run_1:approval:1');
  await runs.decide(approval.id, 'once');
  assert.deepEqual(hermes.callsTo('resolveApproval')[0].args, ['coding', 'run_1', 'once', null]);
});

test('lists pending approvals across agents, oldest first', async () => {
  const { hermes, runs } = setup();
  const first = await runs.start(CODING, { input: 'a' });
  const second = await runs.start(DEFAULT, { input: 'b' });
  hermes.stream(second.runId).push(approvalRequest(0, { request_id: 'req_new', timestamp: 2000, run_id: second.runId }));
  await settle();
  hermes.stream(first.runId).push(approvalRequest(0, { request_id: 'req_old', timestamp: 1500, run_id: first.runId }));
  await settle();
  assert.deepEqual(
    runs.approvals().map((approval) => [approval.id, approval.agentId]),
    [
      ['req_old', 'coding'],
      ['req_new', 'default'],
    ],
  );
});

test('decide relays the choice to the run and profile that own the approval', async () => {
  const { hermes, runs } = setup();
  const coding = await runs.start(CODING, { input: 'a' });
  const other = await runs.start(DEFAULT, { input: 'b' });
  hermes.stream(coding.runId).push(approvalRequest(0, { request_id: 'req_coding' }));
  hermes.stream(other.runId).push(approvalRequest(0, { request_id: 'req_default' }));
  await settle();
  const seen = collect(runs, other.runId);

  await runs.decide('req_default', 'session');

  assert.deepEqual(
    hermes.callsTo('resolveApproval').map((call) => call.args),
    [['default', 'run_2', 'session', 'req_default']],
  );
  assert.deepEqual(runs.approvals().map((approval) => approval.id), ['req_coding']);
  assert.deepEqual(seen.events.at(-1), { type: 'approval.resolved', approvalId: 'req_default', choice: 'session', resolution: 'decision' });
});

test('the upstream approval.responded event after a decision does not emit a second resolution', async () => {
  const { hermes, runs } = setup();
  const { runId } = await runs.start(CODING, { input: 'a' });
  const stream = hermes.stream(runId);
  stream.push(approvalRequest(0));
  await settle();
  const seen = collect(runs, runId);
  await runs.decide('req_a', 'deny');
  stream.push(ev('approval.responded', 1, { choice: 'deny', request_id: 'req_a', resolved: 1 }));
  await settle();
  assert.equal(seen.events.filter((event) => event.type === 'approval.resolved').length, 1);
});

test('decide rejects an unknown id, and a choice Hermes did not offer, without calling upstream', async () => {
  const { hermes, runs } = setup();
  const { runId } = await runs.start(CODING, { input: 'a' });
  hermes.stream(runId).push(approvalRequest(0, { choices: ['once', 'deny'] }));
  await settle();

  await assert.rejects(runs.decide('req_missing', 'once'), (err: unknown) => err instanceof HermesError && err.code === 'not_found');
  await assert.rejects(runs.decide('req_a', 'always'), (err: unknown) => err instanceof HermesError && err.code === 'bad_request');
  assert.equal(hermes.callsTo('resolveApproval').length, 0);
  assert.equal(runs.approvals().length, 1);
});

test('when Hermes says the approval is no longer pending, it leaves the inbox and the error is a conflict', async () => {
  const { hermes, runs } = setup();
  const { runId } = await runs.start(CODING, { input: 'a' });
  hermes.stream(runId).push(approvalRequest(0));
  await settle();
  hermes.failWith.resolveApproval = new HermesError('conflict', 'Run has no pending approval');
  await assert.rejects(runs.decide('req_a', 'once'), (err: unknown) => err instanceof HermesError && err.code === 'conflict');
  assert.deepEqual(runs.approvals(), []);
});

test('an unconfirmed upstream decision is withheld instead of automatically retried or expired', async () => {
  const { hermes, runs } = setup();
  const { runId } = await runs.start(CODING, { input: 'a' });
  hermes.stream(runId).push(approvalRequest(0));
  await settle();
  hermes.failWith.resolveApproval = new HermesError('unavailable', 'Hermes API server is not reachable');
  await assert.rejects(runs.decide('req_a', 'once'), (err: unknown) => err instanceof HermesError && err.code === 'decision_uncertain');
  assert.equal(runs.approvals().length, 0);
});

test('an approval resolved elsewhere (approval.responded) leaves the inbox', async () => {
  const { hermes, runs } = setup();
  const { runId } = await runs.start(CODING, { input: 'a' });
  const stream = hermes.stream(runId);
  stream.push(approvalRequest(0, { request_id: 'req_1', timestamp: 1000 }));
  stream.push(approvalRequest(1, { request_id: 'req_2', timestamp: 1001 }));
  await settle();
  const seen = collect(runs, runId);

  stream.push(ev('approval.responded', 2, { choice: 'once', request_id: 'req_2', resolved: 1 }));
  await settle();
  assert.deepEqual(runs.approvals().map((approval) => approval.id), ['req_1']);
  assert.deepEqual(seen.events.at(-1), { type: 'approval.resolved', approvalId: 'req_2', choice: 'once', resolution: 'decision' });

  // Without a request_id Hermes resolves FIFO: the oldest pending approval of that run.
  stream.push(ev('approval.responded', 3, { choice: 'deny', resolved: 1 }));
  await settle();
  assert.deepEqual(runs.approvals(), []);
  assert.deepEqual(seen.events.at(-1), { type: 'approval.resolved', approvalId: 'req_1', choice: 'deny', resolution: 'decision' });
});

test('#37 snapshots never show a denied or expired command as executing', async (t) => {
  for (const decision of ['once', 'deny', 'expired'] as const) {
    const { hermes, runs, timers } = setup();
    t.after(() => runs.close());
    hermes.approvalTimeout = 1;
    const { runId } = await runs.start(CODING, { input: 'Entrada' });
    const stream = hermes.stream(runId);
    stream.push(ev('tool.started', 0, { tool: 'terminal', preview: 'rm -rf build/' }));
    stream.push(approvalRequest(1, { request_id: 'req_a', timestamp: timers.now / 1000 }));
    await settle();
    if (decision === 'expired') timers.advance(1000);
    else stream.push(ev('approval.responded', 2, { choice: decision, request_id: 'req_a', resolved: 1 }));
    await settle();
    const command = runs.snapshot(runId).items.find((item) => item.kind === 'tool');
    assert.equal(command?.kind === 'tool' && command.status, decision === 'once' ? 'running' : 'error');
  }
});

test('an approval expires after the Hermes approval timeout and is reported as a deny', async () => {
  const { hermes, runs, timers } = setup();
  hermes.approvalTimeout = 120;
  const { runId } = await runs.start(CODING, { input: 'a' });
  hermes.stream(runId).push(approvalRequest(0, { timestamp: timers.now / 1000 }));
  await settle();
  const seen = collect(runs, runId);
  assert.equal(runs.approvals()[0].expiresAt, timers.now + 120_000);

  timers.advance(119_000);
  assert.equal(runs.approvals().length, 1);
  timers.advance(1_000);
  await settle();
  assert.deepEqual(runs.approvals(), []);
  assert.deepEqual(seen.events.at(-1), { type: 'approval.resolved', approvalId: 'req_a', choice: 'deny', resolution: 'expired' });
  await assert.rejects(runs.decide('req_a', 'once'), (err: unknown) => err instanceof HermesError && err.code === 'conflict');
  const history = await runs.decisionHistory();
  assert.deepEqual(history.map(record => [record.actor,record.outcome,record.choice,record.at]), [['expired','expired','deny',1120000]]);
});

for (const choice of ['deny', 'once'] as const) {
  test(`an explicit ${choice} is reported as a decision`, async () => {
    const { hermes, runs } = setup();
    const { runId } = await runs.start(CODING, { input: 'a' });
    hermes.stream(runId).push(approvalRequest(0));
    await settle();
    const seen = collect(runs, runId);

    await runs.decide('req_a', choice);

    assert.deepEqual(seen.events.at(-1), {
      type: 'approval.resolved', approvalId: 'req_a', choice, resolution: 'decision',
    });
    assert.deepEqual(hermes.callsTo('resolveApproval')[0].args, ['coding', runId, choice, 'req_a']);
  });
}

test('an overdue approval expires when read before its timer fires', async () => {
  const { hermes, runs, timers } = setup();
  const { runId } = await runs.start(CODING, { input: 'a' });
  hermes.stream(runId).push(approvalRequest(0));
  await settle();
  const seen = collect(runs, runId);

  timers.now += 300_000;

  assert.deepEqual(runs.approvals(), []);
  await settle();
  assert.deepEqual(seen.events.at(-1), {
    type: 'approval.resolved', approvalId: 'req_a', choice: 'deny', resolution: 'expired',
  });
});

for (const expiryFirst of [true, false]) {
  test(`a decision racing expiry emits one resolution (${expiryFirst ? 'expiry' : 'decision'} first)`, async () => {
    const { hermes, runs, timers } = setup();
    const { runId } = await runs.start(CODING, { input: 'a' });
    const stream = hermes.stream(runId);
    stream.push(approvalRequest(0));
    await settle();
    const seen = collect(runs, runId);
    const expiry = timers.pending[0].fn;
    const originalResolve = hermes.resolveApproval.bind(hermes);
    let complete!: () => void;
    hermes.resolveApproval = async (...args) => {
      await originalResolve(...args);
      await new Promise<void>((resolve) => { complete = resolve; });
    };

    const decision = runs.decide('req_a', 'once');
    await settle();
    if (expiryFirst) timers.advance(300_000);
    complete();
    await decision;
    if (!expiryFirst) expiry(); // A timer callback already queued when clear ran.
    stream.push(ev('approval.responded', 1, { choice: 'once', request_id: 'req_a', resolved: 1 }));
    await settle();

    assert.deepEqual(seen.events.filter((event) => event.type === 'approval.resolved'), [{
      type: 'approval.resolved', approvalId: 'req_a',
      choice: 'once', resolution: 'decision',
    }]);
    assert.deepEqual(runs.approvals(), []);
  });
}

test('pending approvals are dropped when their run ends', async () => {
  const { hermes, runs } = setup();
  const { runId } = await runs.start(CODING, { input: 'a' });
  const stream = hermes.stream(runId);
  stream.push(approvalRequest(0));
  await settle();
  assert.equal(runs.approvals().length, 1);
  stream.push(ev('run.cancelled', 1));
  await settle();
  assert.deepEqual(runs.approvals(), []);
  assert.equal(runs.pendingFor('coding'), 0);
});

test('a failing notifier does not break the run or the inbox', async () => {
  const hermes = new FakeHermes();
  const logs: string[] = [];
  const runs = new RunManager({
    hermes,
    notifier: {
      async approvalCreated() {
        throw new Error('ntfy is down');
      },
    },
    sleep: async () => {},
    log: (line) => logs.push(line),
  });
  const { runId } = await runs.start(CODING, { input: 'a' });
  hermes.stream(runId).push(approvalRequest(0, { timestamp: Date.now() / 1000 }));
  await settle();
  assert.equal(runs.approvals().length, 1);
  assert.ok(logs.some((line) => line.includes('ntfy is down')));
  runs.close();
});

test('reconnects from the last seq when the upstream stream drops mid-run', async () => {
  const { hermes, runs } = setup();
  const { runId } = await runs.start(CODING, { input: 'a' });
  const seen = collect(runs, runId);
  const first = hermes.stream(runId, 0);
  first.push(ev('message.delta', 0, { delta: 'a' }));
  first.push(ev('message.delta', 1, { delta: 'b' }));
  first.fail(new Error('socket hang up'));
  await settle();

  assert.deepEqual(hermes.callsTo('runEvents').map((call) => call.args), [
    ['coding', 'run_1', null],
    ['coding', 'run_1', 1],
  ]);
  hermes.stream(runId, 1).push(ev('run.completed', 2, { output: 'ab' }));
  await settle();
  assert.deepEqual(seen.events.map((event) => event.type), ['message.delta', 'message.delta', 'run.connection', 'run.connection', 'run.completed']);
});

test('when the stream closes without a terminal event, the run status decides how it ended', async () => {
  const { hermes, runs } = setup();
  const { runId } = await runs.start(CODING, { input: 'a' });
  const seen = collect(runs, runId);
  hermes.statuses.set(runId, { status: 'completed', output: 'final answer', error: null });
  hermes.stream(runId).end();
  await settle();
  assert.deepEqual(seen.events, [
    { type: 'run.resync_required', reason: 'upstream_replay_lost' },
    { type: 'run.connection', connection: 'reconnecting' },
    { type: 'run.connection', connection: 'connected' },
    { type: 'run.completed', output: 'final answer' },
  ]);
  assert.equal(seen.isClosed(), true);
});

test('gives up with run.failed when Hermes no longer knows the run', async () => {
  const { hermes, runs } = setup();
  const { runId } = await runs.start(CODING, { input: 'a' });
  const seen = collect(runs, runId);
  hermes.stream(runId).push(approvalRequest(0));
  await settle();
  hermes.statuses.set(runId, null);
  hermes.stream(runId).end();
  await settle();
  assert.equal(seen.events.at(-1)?.type, 'run.failed');
  assert.deepEqual(runs.approvals(), [], 'its approvals go with it');
  assert.equal(runs.snapshot(runId).complete, false, 'an unknown terminal status cannot establish complete replay');
});

test('keeps the partial Turn lost and recoverable after the bounded automatic reconnect budget', async () => {
  const { hermes, runs } = setup();
  const { runId } = await runs.start(CODING, { input: 'a' });
  const seen = collect(runs, runId);
  for (let i = 0; i < 6; i++) hermes.stream(runId, i).fail(new Error('connection refused'));
  await settle(20);
  assert.deepEqual(seen.events.at(-1), { type: 'run.connection', connection: 'lost' });
  assert.equal(seen.isClosed(), false);
  assert.equal(runs.snapshot(runId).terminal, null);
  runs.reconnect(runId);
  const connection = hermes.callsTo('runEvents').length - 1;
  hermes.stream(runId, connection).push(ev('run.completed', 0, { output: 'Recovered' }));
  await settle();
  assert.equal(runs.snapshot(runId).phase, 'completed');
  assert.equal(hermes.callsTo('createRun').length, 1);
  assert.ok(hermes.callsTo('runEvents').length <= 7, 'the automatic retry budget plus one explicit retry is bounded');
});

test('stop relays to the owning profile; an unknown run is not_found', async () => {
  const { hermes, runs } = setup();
  const { runId } = await runs.start(CODING, { input: 'a' });
  await runs.stop(runId);
  assert.deepEqual(hermes.callsTo('stopRun')[0].args, ['coding', 'run_1']);
  await assert.rejects(runs.stop('run_nope'), (err: unknown) => err instanceof HermesError && err.code === 'not_found');
});

test('a failed run creation propagates and tracks nothing', async () => {
  const { hermes, runs } = setup();
  hermes.chatStatus = { available: false, reason: 'Hermes API server is off' };
  await assert.rejects(runs.start(CODING, { input: 'a' }), (err: unknown) => err instanceof HermesError && err.code === 'unavailable');
  assert.equal(runs.busy('coding'), false);
});

test('#37 snapshot freezes input, ordered text and tool state exactly at its replay cursor', async (t) => {
  const { hermes, runs, timers } = setup();
  t.after(() => runs.close());
  const { runId } = await runs.start(CODING, { input: 'Entrada' }, { agentId: 'coding', conversationId: 'conversation', sessionId: 'tip' });
  const stream = hermes.stream(runId);
  stream.push(ev('message.delta', 0, { delta: 'Antes' }));
  stream.push(ev('tool.started', 1, { tool: 'terminal', preview: 'comando' }));
  stream.push(ev('message.delta', 2, { delta: 'Después' }));
  await settle();
  const snapshot = runs.snapshot(runId);
  assert.equal(snapshot.lastEventId, 2); assert.equal(snapshot.conversationId, 'conversation'); assert.equal(snapshot.sessionId, 'tip');
  assert.deepEqual(snapshot.items, [
    { kind: 'user', id: 'run_1:input', text: 'Entrada', at: 1_000_000, runId },
    { kind: 'assistant', id: 'run_1:message:1', text: 'Antes', at: 1_000_000, runId },
    { kind: 'tool', id: 'run_1:tool:1', tool: 'terminal', preview: 'comando', status: 'running', durationSeconds: null, result: null, at: 1_000_000 },
    { kind: 'assistant', id: 'run_1:message:2', text: 'Después', at: 1_000_000, runId },
  ]);
  const resumed = collect(runs, runId, snapshot.lastEventId);
  stream.push(ev('tool.completed', 3, { tool: 'terminal', duration: 2, preview: 'salida' }));
  stream.push(ev('message.delta', 4, { delta: ' final' }));
  stream.push(ev('run.completed', 5, { output: 'Después final', pending_steer: 'Pendiente' }));
  await settle();
  assert.deepEqual(resumed.seqs, [3, 4, 5]);
  assert.equal(snapshot.items[2].kind === 'tool' && snapshot.items[2].status, 'running');
  const final = runs.snapshot(runId);
  assert.equal(final.lastEventId, 5); assert.equal(final.phase, 'completed');
  assert.equal(final.items[2].kind === 'tool' && final.items[2].status, 'done');
  assert.deepEqual(final.terminal, { type: 'run.completed', output: 'Después final', pendingSteer: 'Pendiente' });
  assert.equal(hermes.callsTo('transcript').length, 0, 'snapshot never reads an asynchronous conversation transcript');
  timers.advance(599_999); assert.equal(runs.has(runId), true);
  timers.advance(1); assert.equal(runs.has(runId), false, 'finished retention remains ten minutes');
});

test('#37 replay duplicates are ignored and a missing upstream sequence remains an honest gap', async (t) => {
  const { hermes, runs } = setup();
  t.after(() => runs.close());
  const { runId } = await runs.start(CODING, { input: 'Entrada' });
  const first = hermes.stream(runId);
  first.push(ev('message.delta', 0, { delta: 'a' }));
  first.fail(new Error('private transport detail'));
  await settle();
  const resumed = hermes.stream(runId, 1);
  resumed.push(ev('message.delta', 0, { delta: 'a' }));
  resumed.push(ev('message.delta', 1, { delta: 'b' }));
  resumed.push(ev('message.delta', 1, { delta: 'b' }));
  resumed.push(ev('message.delta', 3, { delta: 'd' }));
  await settle();
  const snapshot = runs.snapshot(runId);
  assert.equal(snapshot.items[1].kind === 'assistant' && snapshot.items[1].text, 'abd');
  assert.equal(snapshot.complete, false);
  const seen = collect(runs, runId);
  assert.equal(seen.events.filter((event) => event.type === 'run.resync_required').length, 1);
  resumed.push(ev('run.completed', 4, { output: 'abcd' }));
  await settle();
  const final = runs.snapshot(runId);
  assert.equal(final.items[1].kind === 'assistant' && final.items[1].text, 'abcd');
  assert.equal(final.complete, false, 'authoritative final text does not reconstruct missing tool events');
});

test('#37 sequenced status-only terminal recovery declares missing replay without inventing tool events', async (t) => {
  const { hermes, runs } = setup();
  t.after(() => runs.close());
  const { runId } = await runs.start(CODING, { input: 'Entrada' });
  const seen = collect(runs, runId);
  const stream = hermes.stream(runId);
  stream.push(ev('message.delta', 0, { delta: 'Parcial' }));
  await settle();
  hermes.statuses.set(runId, { status: 'completed', output: 'Respuesta final', error: null, pendingSteer: 'Pendiente' });
  stream.end();
  await settle();
  const snapshot = runs.snapshot(runId);
  assert.equal(snapshot.complete, false);
  assert.deepEqual(snapshot.terminal, { type: 'run.completed', output: 'Respuesta final', pendingSteer: 'Pendiente' });
  assert.equal(snapshot.items[1].kind === 'assistant' && snapshot.items[1].text, 'Respuesta final');
  assert.equal(snapshot.items.some((item) => item.kind === 'tool'), false);
  assert.ok(seen.events.some((event) => event.type === 'run.resync_required'));
});

test('#37 unsequenced upstream loss preserves partial text and pending steering repaired by terminal status', async (t) => {
  const { hermes, runs, logs } = setup();
  t.after(() => runs.close());
  const { runId } = await runs.start(CODING, { input: 'Entrada' });
  const first = hermes.stream(runId);
  first.push({ event: 'message.delta', seq: null, delta: 'Parcial' });
  first.fail(new Error('instruction-secret API_SERVER_KEY=secret-value'));
  await settle();
  const partial = runs.snapshot(runId);
  assert.equal(partial.items[1].kind === 'assistant' && partial.items[1].text, 'Parcial');
  assert.equal(partial.complete, false);
  hermes.statuses.set(runId, { status: 'completed', output: 'Respuesta completa', error: null, pendingSteer: 'No entregada' });
  hermes.stream(runId, 1).end();
  await settle();
  const snapshot = runs.snapshot(runId);
  assert.equal(snapshot.items[1].kind === 'assistant' && snapshot.items[1].text, 'Respuesta completa');
  assert.deepEqual(snapshot.terminal, { type: 'run.completed', output: 'Respuesta completa', pendingSteer: 'No entregada' });
  assert.equal(snapshot.complete, false);
  assert.doesNotMatch(logs.join('\n'), /instruction-secret|secret-value/);
});

test('#37 bounded event retention signals snapshot limit and still retains the terminal', async (t) => {
  const { hermes, runs } = setup();
  t.after(() => runs.close());
  const { runId } = await runs.start(CODING, { input: 'Entrada' });
  const stream = hermes.stream(runId);
  for (let seq = 0; seq < 5100; seq++) stream.push(ev('message.delta', seq, { delta: 'x' }));
  stream.push(ev('run.completed', 5100, { output: 'Respuesta final', pending_steer: 'No entregada' }));
  await settle(20);
  const seen = collect(runs, runId);
  assert.ok(seen.events.length <= 5000);
  assert.deepEqual(seen.events.filter((event) => event.type === 'run.resync_required'), [{ type: 'run.resync_required', reason: 'snapshot_limit' }]);
  const snapshot = runs.snapshot(runId);
  assert.equal(snapshot.complete, false); assert.equal(snapshot.phase, 'completed');
  assert.equal(snapshot.items[1].kind === 'assistant' && snapshot.items[1].text, 'Respuesta final');
  assert.equal(snapshot.terminal?.pendingSteer, 'No entregada');
});

test('#37 revocation during request preparation prevents the delayed new Turn write', async (t) => {
  const hermes = new FakeHermes();
  let entered!: () => void; let release!: () => void;
  const begun = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let allowed = true;
  const runs = new RunManager({
    hermes, notifier: { async approvalCreated() {} },
    startPorts: { async decorateRequest(_context, request) { entered(); await waiting; return request; } },
  });
  t.after(() => runs.close());
  const pending = runs.start(CODING, { input: 'Entrada' }, undefined, () => {
    if (!allowed) throw new Error('device_revoked');
  });
  await begun; allowed = false; release();
  await assert.rejects(pending, /device_revoked/);
  assert.equal(hermes.callsTo('createRun').length, 0);
  assert.equal(runs.busy('coding'), false);
});


test('actual runtime labels only the terminal assistant and never uses the requested model or earlier tool text', async (t) => {
  const hermes = new FakeHermes();
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} } });
  t.after(() => runs.close());
  const created = await runs.start(hermes.profilesList[0], { input: 'Fixture' });
  hermes.stream(created.runId).push({ event: 'message.delta', seq: 0, delta: 'Before tool' });
  hermes.stream(created.runId).push({ event: 'tool.started', seq: 1, tool: 'read_file' });
  hermes.stream(created.runId).push({ event: 'tool.completed', seq: 2, tool: 'read_file' });
  hermes.stream(created.runId).push({ event: 'message.delta', seq: 3, delta: 'Final' });
  hermes.stream(created.runId).push({ event: 'run.completed', seq: 4, output: 'Final', model: 'request-echo', runtime: { model: 'served', provider: 'fallback', requested: { model: 'asked', provider: 'primary' } } });
  await eventually(() => assert.equal(runs.busy('default'), false));
  const items = runs.snapshot(created.runId).items.filter((item) => item.kind === 'assistant');
  assert.equal(items[0].runtime, undefined); assert.deepEqual(items[1].runtime, { provider: 'fallback', model: 'served' });
  assert.deepEqual(runs.snapshot(created.runId).terminal?.runtime, { provider: 'fallback', model: 'served' });
});


test('terminal-only final output follows tools without replacing preliminary assistant text or its unknown runtime', async (t) => {
  const hermes = new FakeHermes();
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} } });
  t.after(() => runs.close());
  const created = await runs.start(hermes.profilesList[0], { input: 'Fixture' });
  hermes.stream(created.runId).push({ event: 'message.delta', seq: 0, delta: 'Preliminary' });
  hermes.stream(created.runId).push({ event: 'tool.started', seq: 1, tool: 'read_file' });
  hermes.stream(created.runId).push({ event: 'tool.completed', seq: 2, tool: 'read_file' });
  hermes.stream(created.runId).push({ event: 'run.completed', seq: 3, output: 'Final only at terminal', runtime: { model: 'served', provider: 'fallback' } });
  await eventually(() => assert.equal(runs.busy('default'), false));
  const snapshot = runs.snapshot(created.runId);
  assert.deepEqual(snapshot.items.map((item) => item.kind), ['user', 'assistant', 'tool', 'assistant']);
  const preliminary = snapshot.items[1];
  assert.equal(preliminary.kind === 'assistant' && preliminary.text, 'Preliminary');
  assert.equal(preliminary.kind === 'assistant' && preliminary.runtime, undefined);
  const final = snapshot.items[3];
  assert.equal(final.kind === 'assistant' && final.text, 'Final only at terminal');
  assert.deepEqual(final.kind === 'assistant' && final.runtime, { provider: 'fallback', model: 'served' });
  assert.notEqual(final.id, preliminary.id);
});

test('#39 an image input binds only to a new user row and resolves a delayed stable identity before the terminal event', async (t) => {
  const hermes = new FakeHermes();
  let visible = false;
  const older = { kind: 'user' as const, id: 'older-same-text', text: 'Imagen privada', at: 1000 };
  // The boundary fake simulates the database committing after POST /v1/runs returns.
  hermes.transcript = async () => ({ sessionId: 'image-session', items: visible ? [older, { ...older, id: 'new-image-message', at: 2000 }] : [older] });
  const runs = new RunManager({ hermes, notifier: { async approvalCreated() {} } }); t.after(() => runs.close());
  const created = await runs.start(CODING, { input: 'Imagen privada', sessionId: 'image-session', clientMessageId: 'image-client-id', images: [{ attachmentId: 'image-fixture', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=', width: 1, height: 1 }] });
  assert.equal(created.inputMessageId, null);
  assert.notEqual(runs.snapshot(created.runId).items[0].id, older.id);
  const seen = collect(runs, created.runId); visible = true;
  hermes.stream(created.runId).push(ev('run.completed', 0, { output: 'Descrita' }));
  await eventually(() => assert.equal(runs.snapshot(created.runId).phase, 'completed'));
  assert.deepEqual(seen.events.slice(-2), [{ type: 'run.input', clientMessageId: 'image-client-id', messageId: 'new-image-message', sessionId: 'image-session' }, { type: 'run.completed', output: 'Descrita' }]);
  assert.equal(runs.snapshot(created.runId).items[0].id, 'new-image-message');
  assert.doesNotMatch(JSON.stringify(runs.snapshot(created.runId)), /dataBase64|iVBORw0KGgo/);
});

test('#42 records exactly the selected session decision durably, including replay, and refuses a second in-flight decision', async () => {
  const { hermes, runs } = setup();
  await runs.start(CODING,{input:'test'}); hermes.stream('run_1').push(approvalRequest(0));
  await eventually(() => assert.equal(runs.approvals().length,1));
  const first = runs.decide('req_a','session');
  await assert.rejects(runs.decide('req_a','once'), (error: unknown) => error instanceof HermesError && error.code === 'conflict');
  await first;
  hermes.stream('run_1').push(ev('approval.responded',1,{request_id:'req_a',choice:'session'})); await settle();
  const history = await runs.decisionHistory();
  assert.equal(history.length,1); assert.equal(history[0].choice,'session'); assert.equal(history[0].actor,'person'); assert.equal(history[0].outcome,'approved');
  runs.close();
});

test('#42 an approval request replay after its decision cannot recreate an actionable approval',async()=>{
 const {hermes,runs}=setup();await runs.start(CODING,{input:'test'});hermes.stream('run_1').push(approvalRequest(0));await settle();
 await runs.decide('req_a','deny');hermes.stream('run_1').push(approvalRequest(1));await settle();
 assert.deepEqual(runs.approvals(),[]);assert.equal((await runs.decisionHistory()).length,1);runs.close();
});
test('#42 unknown approval response choices do not invent a human denial or expiration',async()=>{
 const {hermes,runs}=setup();await runs.start(CODING,{input:'test'});hermes.stream('run_1').push(approvalRequest(0));await settle();
 hermes.stream('run_1').push(ev('approval.responded',1,{request_id:'req_a',choice:'invalid'}));await settle();
 assert.equal(runs.approvals().length,1);assert.deepEqual(await runs.decisionHistory(),[]);runs.close();
});


async function durableSetup(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-decision-lifecycle-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await createDecisionStore({ directory });
  const fixture = setup(store); t.after(() => fixture.runs.close());
  return { ...fixture, store, directory };
}

test('#42 a late ACK confirms the captured decision after responded, completion and Turn cleanup', async t => {
  const { hermes, runs, timers, directory } = await durableSetup(t);
  await runs.start(CODING, { input: 'test', sessionId: 'stable-session' });
  hermes.stream('run_1').push(approvalRequest(0));
  await eventually(() => assert.equal(runs.approvals().length, 1));
  const resolve = hermes.resolveApproval.bind(hermes);
  let release!: () => void;
  hermes.resolveApproval = async (...args) => { await resolve(...args); await new Promise<void>(done => { release = done; }); };
  const deciding = runs.decide('req_a', 'once');
  await eventually(() => assert.equal(hermes.callsTo('resolveApproval').length, 1));
  hermes.stream('run_1').push(ev('approval.responded', 1, { request_id: 'req_a', choice: 'once' }));
  hermes.stream('run_1').push(ev('run.completed', 2, { output: 'done' }));
  await eventually(() => assert.equal(runs.snapshot('run_1').phase, 'completed'));
  timers.advance(600000); assert.equal(runs.has('run_1'), false);
  release(); await deciding;
  const reloaded = await createDecisionStore({ directory });
  assert.deepEqual(reloaded.list().map(record => [record.sessionId, record.choice, record.actor, record.outcome, record.at]), [['stable-session', 'once', 'person', 'approved', 1000000]]);
  assert.deepEqual(reloaded.pending(), []);
  assert.equal(hermes.callsTo('resolveApproval').length, 1);
});

test('#42 conflicting SSE evidence wins over the submitted choice after Turn cleanup', async t => {
  const { hermes, runs, timers, directory } = await durableSetup(t);
  await runs.start(CODING, { input: 'test', sessionId: 'observed-session' });
  hermes.stream('run_1').push(approvalRequest(0));
  await eventually(() => assert.equal(runs.approvals().length, 1));
  const resolve = hermes.resolveApproval.bind(hermes); let release!: () => void;
  hermes.resolveApproval = async (...args) => { await resolve(...args); await new Promise<void>(done => { release = done; }); };
  const deciding = runs.decide('req_a', 'session');
  await eventually(() => assert.equal(hermes.callsTo('resolveApproval').length, 1));
  hermes.stream('run_1').push(ev('approval.responded', 1, { request_id: 'req_a', choice: 'deny' }));
  hermes.stream('run_1').push(ev('run.completed', 2, { output: 'done' }));
  await eventually(() => assert.equal(runs.snapshot('run_1').phase, 'completed'));
  timers.advance(600000); release(); await deciding;
  const reloaded = await createDecisionStore({ directory });
  assert.deepEqual(reloaded.list().map(record => [record.sessionId, record.choice, record.actor, record.outcome, record.at]), [['observed-session', 'deny', 'person', 'rejected', 1000000]]);
  assert.deepEqual(reloaded.pending(), []); assert.equal(reloaded.list().length, 1);
});

test('#42 confirming an old captured entry cannot remove a new approval reusing its request id', async t => {
  const { hermes, runs, timers, store } = await durableSetup(t);
  await runs.start(CODING, { input: 'old', sessionId: 'old-session' });
  hermes.stream('run_1').push(approvalRequest(0));
  await eventually(() => assert.equal(runs.approvals().length, 1));
  const resolve = hermes.resolveApproval.bind(hermes); let release!: () => void;
  hermes.resolveApproval = async (...args) => { await resolve(...args); await new Promise<void>(done => { release = done; }); };
  const deciding = runs.decide('req_a', 'once');
  await eventually(() => assert.equal(hermes.callsTo('resolveApproval').length, 1));
  hermes.stream('run_1').push(ev('approval.responded', 1, { request_id: 'req_a', choice: 'once' }));
  hermes.stream('run_1').push(ev('run.completed', 2));
  await eventually(() => assert.equal(runs.snapshot('run_1').phase, 'completed'));
  timers.advance(600000);
  await runs.start(CODING, { input: 'new', sessionId: 'new-session' });
  hermes.stream('run_2').push(approvalRequest(0, { timestamp: timers.now / 1000, command: 'echo new' }));
  await eventually(() => assert.equal(runs.approvals()[0]?.runId, 'run_2'));
  release(); await deciding;
  assert.deepEqual(runs.approvals().map(approval => [approval.id, approval.runId, approval.command]), [['req_a', 'run_2', 'echo new']]);
  assert.deepEqual(store.list().map(record => [record.sessionId, record.runId]), [['old-session', 'run_1']]);
  assert.deepEqual(store.pending(), []);
});


for (const recovery of ['live', 'shared', 'reloaded'] as const) {
  test(`#42 durable ${recovery} replay ACKs the exact confirmed choice without another Hermes POST`, async t => {
    const { hermes, runs, store, directory } = await durableSetup(t);
    await runs.start(CODING, { input: 'test', sessionId: 'replay-session' });
    hermes.stream('run_1').push(approvalRequest(0));
    await eventually(() => assert.equal(runs.approvals().length, 1));
    await runs.decide('req_a', 'session');
    const recovered = recovery === 'live' ? { runs, hermes } : setup(recovery === 'shared' ? store : await createDecisionStore({ directory }));
    t.after(() => recovered.runs.close());
    await recovered.runs.decide('req_a', 'session');
    await assert.rejects(recovered.runs.decide('req_a', 'once'), error => error instanceof HermesError && error.code === 'conflict');
    await assert.rejects(recovered.runs.decide('req_unknown', 'session'), error => error instanceof HermesError && error.code === 'not_found');
    assert.equal(hermes.callsTo('resolveApproval').length, 1);
    if (recovery !== 'live') assert.equal(recovered.hermes.callsTo('resolveApproval').length, 0);
    assert.equal((await recovered.runs.decisionHistory()).length, 1);
    assert.deepEqual(await recovered.runs.uncertainDecisions(), []);
  });
}

test('#42 an unconfirmed attempt remains uncertain after Turn cleanup and restart without another upstream effect', async t => {
  const { hermes, runs, timers, directory } = await durableSetup(t);
  await runs.start(CODING, { input: 'test', sessionId: 'uncertain-session' });
  hermes.stream('run_1').push(approvalRequest(0));
  await eventually(() => assert.equal(runs.approvals().length, 1));
  const resolve = hermes.resolveApproval.bind(hermes); let release!: () => void;
  hermes.resolveApproval = async (...args) => { await resolve(...args); await new Promise<void>(done => { release = done; }); throw new Error('Synthetic lost ACK'); };
  const deciding = runs.decide('req_a', 'once');
  const result = assert.rejects(deciding, error => error instanceof HermesError && error.code === 'decision_uncertain');
  await eventually(() => assert.equal(hermes.callsTo('resolveApproval').length, 1));
  hermes.stream('run_1').push(ev('run.completed', 1));
  await eventually(() => assert.equal(runs.snapshot('run_1').phase, 'completed'));
  timers.advance(600000); release(); await result;
  const store = await createDecisionStore({ directory }); const recovered = setup(store); t.after(() => recovered.runs.close());
  assert.deepEqual(store.list(), []); assert.equal(store.pending()[0].sessionId, 'uncertain-session');
  for (const manager of [runs, recovered.runs]) {
    for (const choice of ['once', 'deny'] as const) await assert.rejects(manager.decide('req_a', choice), error => error instanceof HermesError && error.code === 'decision_uncertain');
  }
  assert.equal(hermes.callsTo('resolveApproval').length, 1); assert.equal(recovered.hermes.callsTo('resolveApproval').length, 0);
});

test('#42 an expired denial cannot be replayed as a confirmed person choice', async t => {
  const { hermes, runs, timers, directory } = await durableSetup(t);
  hermes.approvalTimeout = 1;
  await runs.start(CODING, { input: 'test' }); hermes.stream('run_1').push(approvalRequest(0));
  await eventually(() => assert.equal(runs.approvals().length, 1));
  timers.advance(1000); await runs.decisionHistory();
  const recovered = setup(await createDecisionStore({ directory })); t.after(() => recovered.runs.close());
  for (const manager of [runs, recovered.runs]) await assert.rejects(manager.decide('req_a', 'deny'), error => error instanceof HermesError && error.code === 'conflict');
  assert.equal(hermes.callsTo('resolveApproval').length, 0); assert.equal(recovered.hermes.callsTo('resolveApproval').length, 0);
});

test('#42 replay waits for ledger readiness and rechecks authorization before reading its ACK', async t => {
  const { hermes, runs, store } = await durableSetup(t);
  await runs.start(CODING, { input: 'test' }); hermes.stream('run_1').push(approvalRequest(0));
  await eventually(() => assert.equal(runs.approvals().length, 1)); await runs.decide('req_a', 'once');
  let release!: (store: DecisionStore) => void;
  const startup = new Promise<DecisionStore>(resolve => { release = resolve; });
  const recovered = setup(deferredDecisionStore(startup)); t.after(() => recovered.runs.close());
  const denied = new Error('Synthetic authorization changed'); let authorized = true; let guards = 0; let settled = false;
  const replay = recovered.runs.decide('req_a', 'once', () => { guards++; if (!authorized) throw denied; });
  const result = assert.rejects(replay, error => error === denied).finally(() => { settled = true; });
  await settle(); assert.equal(settled, false); assert.equal(guards, 1);
  authorized = false; release(store); await result;
  assert.equal(guards, 2); assert.equal(recovered.hermes.callsTo('resolveApproval').length, 0);
});

test('#42 a confirmed denial replays successfully and durable identity matching is exact and Relay-only', async t => {
  const { hermes, runs, store, directory } = await durableSetup(t);
  await runs.start(CODING, { input: 'test' }); hermes.stream('run_1').push(approvalRequest(0));
  await eventually(() => assert.equal(runs.approvals().length, 1)); await runs.decide('req_a', 'deny');
  const record = store.list()[0];
  await store.append({ ...record, id: JSON.stringify(['relay', 'coding', 'run_2', 'prefix-request-long']), runId: 'run_2', approvalId: 'prefix-request-long' });
  await store.append({ ...record, id: 'foreign-record', origin: 'other', source: 'discord', originLabel: 'Discord', approvalId: 'foreign-request' });
  await store.append({ ...record, id: 'unverified-identity', approvalId: 'broken-request' });
  const recovered = setup(await createDecisionStore({ directory })); t.after(() => recovered.runs.close());
  await recovered.runs.decide('req_a', 'deny');
  await assert.rejects(recovered.runs.decide('req_a', 'once'), error => error instanceof HermesError && error.code === 'conflict');
  for (const id of ['prefix-request', 'foreign-request']) await assert.rejects(recovered.runs.decide(id, 'deny'), error => error instanceof HermesError && error.code === 'not_found');
  await assert.rejects(recovered.runs.decide('broken-request', 'deny'), error => error instanceof HermesError && error.code === 'decision_store_unavailable');
  assert.equal(hermes.callsTo('resolveApproval').length, 1); assert.equal(recovered.hermes.callsTo('resolveApproval').length, 0);
});

test('#42 confirmed and replayed decisions use one atomic confirmation write', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-decision-atomic-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let writes = 0;
  const io = { ...fs, async rename(from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) { if (String(to).endsWith('/decisions.json')) writes++; return fs.rename(from, to); } };
  const store = await createDecisionStore({ directory, io }); const { hermes, runs } = setup(store); t.after(() => runs.close());
  await runs.start(CODING, { input: 'test' }); hermes.stream('run_1').push(approvalRequest(0));
  await eventually(() => assert.equal(runs.approvals().length, 1));
  const original = hermes.resolveApproval.bind(hermes); let release!: () => void;
  hermes.resolveApproval = async (...args) => { await original(...args); await new Promise<void>(resolve => { release = resolve; }); };
  const deciding = runs.decide('req_a', 'once');
  await eventually(() => assert.equal(hermes.callsTo('resolveApproval').length, 1));
  assert.equal(writes, 2, 'initial ledger and durable attempt');
  hermes.stream('run_1').push(ev('approval.responded', 1, { request_id: 'req_a', choice: 'once' }));
  hermes.stream('run_1').push(ev('run.completed', 2));
  await eventually(() => assert.equal(runs.snapshot('run_1').phase, 'completed'));
  release(); await deciding; await runs.decide('req_a', 'once');
  assert.equal(writes, 3, 'one atomic confirmation; replay writes nothing');
  assert.equal(store.list().length, 1); assert.deepEqual(store.pending(), []);
});


test('#42 an uncertain live approval cannot retry either choice upstream', async t => {
  const { hermes, runs, store } = await durableSetup(t);
  await runs.start(CODING, { input: 'test' }); hermes.stream('run_1').push(approvalRequest(0));
  await eventually(() => assert.equal(runs.approvals().length, 1));
  hermes.failWith.resolveApproval = new Error('Synthetic lost ACK');
  for (const choice of ['once', 'once', 'deny'] as const) await assert.rejects(runs.decide('req_a', choice), error => error instanceof HermesError && error.code === 'decision_uncertain');
  assert.equal(hermes.callsTo('resolveApproval').length, 1); assert.deepEqual(store.list(), []);
  assert.equal(store.pending().length, 1); assert.equal(store.pending()[0].choice, 'once');
});

test('#42 failed confirmation persistence retains the durable attempt and gates every replay', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-decision-confirmation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let fail = false;
  const io = { ...fs, async rename(from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) { if (fail && String(to).endsWith('/decisions.json')) throw new Error('Synthetic persistence failure'); return fs.rename(from, to); } };
  const store = await createDecisionStore({ directory, io }); const { hermes, runs } = setup(store); t.after(() => runs.close());
  await runs.start(CODING, { input: 'test' }); hermes.stream('run_1').push(approvalRequest(0));
  await eventually(() => assert.equal(runs.approvals().length, 1));
  const original = hermes.resolveApproval.bind(hermes);
  hermes.resolveApproval = async (...args) => { await original(...args); fail = true; };
  await assert.rejects(runs.decide('req_a', 'once'), error => error instanceof HermesError && error.code === 'decision_uncertain');
  const reloaded = await createDecisionStore({ directory }); const recovered = setup(reloaded); t.after(() => recovered.runs.close());
  assert.deepEqual(reloaded.list(), []); assert.equal(reloaded.pending()[0].choice, 'once');
  await assert.rejects(recovered.runs.decide('req_a', 'once'), error => error instanceof HermesError && error.code === 'decision_uncertain');
  assert.equal(hermes.callsTo('resolveApproval').length, 1); assert.equal(recovered.hermes.callsTo('resolveApproval').length, 0);
});

test('#42 a refused pre-send attempt does not lend its timestamp to a later authorized decision', async t => {
  const { hermes, runs, timers, store } = await durableSetup(t);
  await runs.start(CODING, { input: 'test' }); hermes.stream('run_1').push(approvalRequest(0));
  await eventually(() => assert.equal(runs.approvals().length, 1));
  const refused = new Error('Synthetic authorization changed'); let guards = 0;
  await assert.rejects(runs.decide('req_a', 'once', () => { if (++guards === 3) throw refused; }), error => error === refused);
  assert.equal(hermes.callsTo('resolveApproval').length, 0); assert.deepEqual(store.pending(), []);
  timers.advance(1000); await runs.decide('req_a', 'once');
  assert.equal(store.list()[0].at, 1001000); assert.equal(hermes.callsTo('resolveApproval').length, 1);
});


test('#42 a durable decision colliding with a new active request id fails closed before sending', async t => {
  const { hermes, runs, store } = await durableSetup(t);
  await runs.start(CODING, { input: 'old', sessionId: 'old-session' });
  hermes.stream('run_1').push(approvalRequest(0, { request_id: 'reused-id' }));
  await eventually(() => assert.equal(runs.approvals().length, 1));
  await runs.decide('reused-id', 'once');
  hermes.stream('run_1').push(ev('run.completed', 1));
  await eventually(() => assert.equal(runs.snapshot('run_1').phase, 'completed'));
  await runs.start(CODING, { input: 'new', sessionId: 'new-session' });
  hermes.stream('run_2').push(approvalRequest(0, { request_id: 'reused-id', command: 'echo new' }));
  await eventually(() => assert.equal(runs.approvals()[0]?.runId, 'run_2'));
  for (const choice of ['once', 'deny'] as const) {
    await assert.rejects(runs.decide('reused-id', choice), error => error instanceof HermesError && error.code === 'conflict');
    assert.equal(hermes.callsTo('resolveApproval').length, 1, 'a replay must never decide the new Turn');
    assert.deepEqual(runs.approvals().map(approval => [approval.id, approval.runId, approval.command]), [['reused-id', 'run_2', 'echo new']]);
  }
  assert.deepEqual(store.list().map(record => [record.runId, record.choice]), [['run_1', 'once']]);
  assert.deepEqual(store.pending(), []);
});


for (const initial of ['active', 'absent'] as const) {
  test(`#42 ${initial} approval snapshot during ledger readiness cannot lend its decision to another Agent`, async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-decision-snapshot-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let blocked = false; let entered = false; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); t.after(release);
    const io = { ...fs, async rename(from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) {
      if (blocked && String(to).endsWith('/decisions.json')) { blocked = false; entered = true; await gate; }
      return fs.rename(from, to);
    } };
    const store = await createDecisionStore({ directory, io });
    const { hermes, runs } = setup(store); t.after(() => runs.close());
    await runs.start(DEFAULT, { input: 'old' });
    await runs.start(CODING, { input: 'new' });
    if (initial === 'active') {
      hermes.stream('run_1').push(approvalRequest(0, { request_id: 'snapshot-id', command: 'echo old' }));
      await eventually(() => assert.equal(runs.approvals()[0]?.runId, 'run_1'));
    }
    blocked = true;
    const write = store.append({ id: '["relay","default","unrelated-run","unrelated"]', agentId: 'default', agentName: 'Default', sessionId: 'unrelated-session', runId: 'unrelated-run', approvalId: 'unrelated', toolCallId: null, command: 'echo unrelated', actor: 'person', outcome: 'rejected', choice: 'deny', at: 1000000, timeKind: 'decision', origin: 'relay', source: 'api_server', originLabel: 'Relay' });
    await eventually(() => assert.ok(entered));
    const deciding = runs.decide('snapshot-id', 'once');
    const rejected = assert.rejects(deciding, error => error instanceof HermesError && error.code === 'conflict');
    await settle(); assert.equal(hermes.callsTo('resolveApproval').length, 0);
    if (initial === 'active') {
      hermes.stream('run_1').push(ev('run.completed', 1));
      await eventually(() => assert.equal(runs.snapshot('run_1').phase, 'completed'));
    }
    hermes.stream('run_2').push(approvalRequest(0, { request_id: 'snapshot-id', command: 'echo new' }));
    await eventually(() => assert.equal(runs.approvals()[0]?.runId, 'run_2'));
    release(); await write; await rejected;
    assert.equal(hermes.callsTo('resolveApproval').length, 0);
    assert.deepEqual(runs.approvals().map(approval => [approval.agentId, approval.runId, approval.command]), [['coding', 'run_2', 'echo new']]);
    assert.deepEqual(store.list().map(record => record.approvalId), ['unrelated']);
    assert.deepEqual(store.pending(), []);
  });
}

test('#42 an approval confirmed during ledger readiness still ACKs its exact choice after removal', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-decision-snapshot-ack-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let blocked = false; let entered = false; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); t.after(release);
  const io = { ...fs, async rename(from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) {
    if (blocked && String(to).endsWith('/decisions.json')) { blocked = false; entered = true; await gate; }
    return fs.rename(from, to);
  } };
  const store = await createDecisionStore({ directory, io });
  const { hermes, runs } = setup(store); t.after(() => runs.close());
  await runs.start(CODING, { input: 'synthetic' });
  hermes.stream('run_1').push(approvalRequest(0));
  await eventually(() => assert.equal(runs.approvals().length, 1));
  blocked = true;
  hermes.stream('run_1').push(ev('approval.responded', 1, { request_id: 'req_a', choice: 'session' }));
  await eventually(() => assert.ok(entered));
  const replay = runs.decide('req_a', 'session');
  await settle(); assert.equal(hermes.callsTo('resolveApproval').length, 0);
  release(); await replay;
  assert.deepEqual(runs.approvals(), []);
  hermes.stream('run_1').push(ev('run.completed', 2));
  await eventually(() => assert.equal(runs.snapshot('run_1').phase, 'completed'));
  await runs.decide('req_a', 'session');
  await assert.rejects(runs.decide('req_a', 'once'), error => error instanceof HermesError && error.code === 'conflict');
  assert.equal(hermes.callsTo('resolveApproval').length, 0);
  assert.deepEqual(store.list().map(record => [record.runId, record.choice]), [['run_1', 'session']]);
  assert.deepEqual(store.pending(), []);
});

test('Kanban terminal evidence requires the complete local Agente, Conversación and Turno identity',async t=>{
 const {runs,hermes}=setup();t.after(()=>runs.close());
 const created=await runs.start(CODING,{input:'Synthetic'}, {agentId:'coding',conversationId:'relay_recorded',sessionId:'session_recorded'});
 hermes.stream(created.runId).push(ev('run.completed',0,{output:'Synthetic completed'}));await eventually(()=>assert.equal(runs.snapshot(created.runId).phase,'completed'));
 assert.equal(runs.phaseForConversation('coding','relay_recorded',created.runId),'completed');
 assert.equal(runs.phaseForConversation('default','relay_recorded',created.runId),null,'A matching Conversation and Turno cannot substitute another Agente');
 assert.equal(runs.phaseForConversation('coding','relay_other',created.runId),null,'A matching Agente and Turno cannot substitute another Conversación');
 assert.equal(runs.phaseForConversation('coding','relay_recorded','unrecorded'),null);
 const unscoped=await runs.start(CODING,{input:'Synthetic unscoped',sessionId:'session_unscoped'});
 assert.equal(runs.phaseForConversation('coding','session_unscoped',unscoped.runId),null,'A session string without recorded Relay ownership is not Conversation evidence');
});
