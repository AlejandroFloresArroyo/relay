import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunManager } from '../src/runs.ts';
import { FakeHermes } from '../support/fake_hermes.ts';
import { HermesError } from '../src/hermes.ts';
import type { RunStartPorts } from '../src/chatPorts.ts';

test('prepare reserves through registration and decoration reaches the upstream creation slot', async (t) => {
  const hermes = new FakeHermes();
  const order: string[] = [];
  const context = { agentId: 'default', conversationId: 'root', sessionId: 'tip' };
  const ports: RunStartPorts = {
    async prepare(_agent, _request, operation) {
      order.push('reserve');
      const created = await operation(context);
      assert.equal(runs.has((created as { runId: string }).runId), true);
      order.push('release');
      return created;
    },
    async decorateRequest(actual, request) { assert.deepEqual(actual, context); order.push('decorate'); return { ...request, sessionId: 'tip' }; },
    async createUpstreamRun(agentId, request, actual) {
      assert.deepEqual(actual, context); order.push('create'); return hermes.createRun(agentId, request);
    },
  };
  const runs = new RunManager({ hermes, notifier: { approvalCreated: async () => {} }, startPorts: ports });
  t.after(() => runs.close());
  await runs.start(hermes.profilesList[0], { input: 'Fixture' });
  assert.deepEqual(order, ['reserve', 'decorate', 'create', 'release']);
  assert.deepEqual(hermes.callsTo('createRun')[0].args, ['default', { input: 'Fixture', sessionId: 'tip' }]);
});

test('an unavailable prepare port prevents upstream creation', async (t) => {
  const hermes = new FakeHermes();
  const runs = new RunManager({ hermes, notifier: { approvalCreated: async () => {} }, startPorts: { async prepare() { throw new HermesError('unavailable', 'Fixture unavailable'); } } });
  t.after(() => runs.close());
  await assert.rejects(runs.start(hermes.profilesList[0], { input: 'Fixture' }), { code: 'unavailable' });
  assert.equal(hermes.callsTo('createRun').length, 0);
});

test('prepared conversation context supplies the upstream session before model decoration is installed', async (t) => {
  const hermes = new FakeHermes();
  const runs = new RunManager({ hermes, notifier: { approvalCreated: async () => {} }, startPorts: {
    prepare: (_agent, _request, operation) => operation({ agentId: 'default', conversationId: 'root', sessionId: 'tip' }),
  } });
  t.after(() => runs.close());
  await runs.start(hermes.profilesList[0], { input: 'Fixture', sessionId: null });
  assert.deepEqual(hermes.callsTo('createRun')[0].args, ['default', { input: 'Fixture', sessionId: 'tip' }]);
});
