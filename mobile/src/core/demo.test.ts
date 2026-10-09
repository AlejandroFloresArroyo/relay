import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoClient, demoApprovalDecision, DEMO_LOCK_NOTICE, resetDemo } from './demo.ts';
import { pollConnection } from './connection.ts';
import { setDemoServerControlScenario } from './demoServerControl.ts';
import { buildBlocks } from './transcript.ts';

test('demo keeps a pending approval and a separate expired decision visible in a chat', async () => {
  resetDemo();
  const client = createDemoClient('atlas', () => 1_000_000);
  assert.equal((await client.approvals()).length, 2);
  const blocks = buildBlocks((await client.transcript('research')).items, false);
  assert.ok(blocks.some((b) => b.kind === 'terminal' && b.end === 'expired'));
  assert.deepEqual(DEMO_LOCK_NOTICE, { seconds: 8, minutes: 1 });
});

test('rejecting the demo approval shows a decision, never an expiry', async () => {
  resetDemo();
  const client = createDemoClient('atlas', () => 1_000_000);
  const [approval] = await client.approvals();
  await client.decide(approval.id, 'deny');
  const blocks = buildBlocks((await client.transcript('dev')).items, false);
  assert.ok(blocks.some((b) => b.kind === 'activity' && b.steps.some((s) => s.outcome === 'RECHAZADO' && s.status === 'error')));
  assert.ok(blocks.some((b) => b.kind === 'terminal' && b.lines.some((line) => line.some((s) => s.text === 'RECHAZADO' && s.tone === 'fail'))));
  assert.ok(!JSON.stringify(blocks).includes('VENCIDA'));
});

test('the rejected demo event carries the Puente decision cause', () => {
  assert.equal(demoApprovalDecision('ap-demo-1', 'deny').resolution, 'decision');
});

test('the demo has one Aprobación with «Para la sesión» and one without it that lapses a minute in', async () => {
  resetDemo();
  let now = 1_000_000;
  const client = createDemoClient('atlas', () => now);
  const [withSession, withoutSession] = await client.approvals();
  assert.ok(withSession.choices.includes('session'));
  assert.ok(!withoutSession.choices.includes('session'));
  assert.ok(withoutSession.expiresAt! - now < 60_000);
  now = withoutSession.expiresAt!;
  assert.deepEqual((await client.approvals()).map((approval) => approval.id), [withSession.id]);
  resetDemo();
  now = 1_000_000;
  const fresh = createDemoClient('atlas', () => now);
  await fresh.decide(withoutSession.id, 'once');
  assert.deepEqual((await fresh.approvals()).map((approval) => approval.id), [withSession.id]);
});

test('the expired demo includes approval feedback without a preceding tool.started', async () => {
  const client = createDemoClient('atlas', () => 1_000_000);
  const items = (await client.transcript('research')).items;
  assert.equal(items.filter((item) => item.kind === 'tool' && !('feedbackOnly' in item && item.feedbackOnly)).length, 0);
  const blocks = buildBlocks(items, false);
  assert.ok(JSON.stringify(blocks).includes('$ rm -rf ./papers/tmp'));
  assert.ok(blocks.some((b) => b.kind === 'terminal' && b.end === 'expired'));
});


test('the paused demo preserves a queued mode until the next admitted Turn', async () => {
  resetDemo();
  const client = createDemoClient('atlas', () => 1_000_000);
  const conversation = await client.createConversation('dev', { requestId: 'pause-mode-composition' });
  const security = (await client.agentDetails('dev')).security;
  await client.setApprovalMode('dev', { mode: 'off', revision: security.revision });
  setDemoServerControlScenario('atlas', 'paused');
  await assert.rejects(client.startRun('dev', { input: 'Preserve this draft', sessionId: conversation.id }), { code: 'server_paused' });
  const pending = (await client.agentDetails('dev')).security;
  assert.equal(pending.mode, 'smart');
  assert.equal(pending.pendingMode?.mode, 'off');
  setDemoServerControlScenario('atlas', 'ready');
  await client.startRun('dev', { input: 'Preserve this draft', sessionId: conversation.id });
  const applied = (await client.agentDetails('dev')).security;
  assert.equal(applied.mode, 'off');
  assert.equal(applied.pendingMode, null);
  resetDemo();
});

test('the paused demo reaches the shared snapshot behind the strip, Agentes and chat', async () => {
  resetDemo();
  const client = createDemoClient('atlas', () => 1_000_000);
  setDemoServerControlScenario('atlas', 'paused');
  assert.equal((await pollConnection(client, 'http://atlas.demo')).serverControl?.paused, true);
  setDemoServerControlScenario('atlas', 'ready');
  assert.equal((await pollConnection(client, 'http://atlas.demo')).serverControl?.paused, false);
  resetDemo();
});

test('normal demo logs treat DEBUG, INFO, WARN and ERROR as minimum severity', async () => {
  resetDemo();
  const client = createDemoClient('atlas', () => 1_000_000);
  const normal = ['INFO', 'INFO', 'WARN', 'INFO', 'INFO', 'WARN', 'INFO', 'ERROR', 'INFO', 'WARN', 'INFO', 'INFO'];
  assert.deepEqual((await client.logs('DEBUG', 100)).map(line => line.level), normal);
  assert.deepEqual((await client.logs('INFO', 100)).map(line => line.level), normal);
  assert.deepEqual((await client.logs('WARN', 100)).map(line => line.level), ['WARN', 'WARN', 'ERROR', 'WARN']);
  assert.deepEqual((await client.logs('ERROR', 100)).map(line => line.level), ['ERROR']);
});
