import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeChangeRecord, StateError } from '../src/changeLog.ts';

const actor = { kind: 'device' as const, id: '00000000-0000-4000-8000-000000000002', name: 'fixture-phone' };
const newId = () => '00000000-0000-4000-8000-000000000001';
const actions = [
  'conversation.create.requested', 'conversation.create.succeeded', 'conversation.create.failed', 'conversation.create.uncertain',
  'conversation.rename.requested', 'conversation.rename.succeeded', 'conversation.rename.failed', 'conversation.rename.uncertain',
  'conversation.delete.requested', 'conversation.delete.succeeded', 'conversation.delete.failed', 'conversation.delete.uncertain',
  'conversation.model.changed', 'run.steer.requested', 'run.steer.accepted', 'run.steer.rejected', 'run.steer.uncertain',
  'run.stop.requested', 'run.stop.succeeded', 'run.stop.uncertain',
];
const input = (action: string) => ({ actor, action, target: { kind: (action.startsWith('conversation.') ? 'conversation' : 'run') as 'conversation' | 'run', id: '["default","fixture-id"]' } });
test('chat audit accepts exactly the A4 actions with device actor and paired identity only', () => {
  for (const action of actions) {
    const value = input(action);
    assert.deepEqual(makeChangeRecord(value, 1791000000000, newId), { ...value, id: newId(), at: '2026-10-03T04:00:00.000Z' });
    for (const invalid of [
      { ...value, details: { blockedUntil: 1791000000000 } }, { ...value, actor: { kind: 'server' as const } },
      { ...value, target: { ...value.target, kind: 'agent' as const } },
      { ...value, target: { ...value.target, id: '["default","../other"]' } },
      { ...value, target: { ...value.target, id: '["default","fixture-id","content"]' } },
      { ...value, target: { ...value.target, id: 'message-content' } },
    ]) assert.throws(() => makeChangeRecord(invalid, 1791000000000, newId), StateError, action);
  }
});
test('chat audit rejects action prefixes, extra suffixes and outcomes outside the closed list', () => {
  for (const action of [...actions.map((a) => `${a}.extra`), 'conversation.', 'conversation.create', 'conversation.model.requested', 'run.stop.failed', 'run.steer.succeeded', 'run.arbitrary']) {
    assert.throws(() => makeChangeRecord(input(action), 1791000000000, newId), StateError, action);
  }
});
