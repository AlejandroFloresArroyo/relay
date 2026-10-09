import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_AVATAR_KEYS, agentAvatarKey } from './agentAvatars.ts';

const assignments = [
  ['default', 'hermes'], ['dev', 'caduceus'], ['research', 'owl'],
  ['coding', 'owl'], ['agentA', 'sandal'], ['agentB', 'astrolabe'],
  ['investigación', 'lighthouse'],
] as const;

test('well-known profiles keep their pinned pictures and arbitrary profile IDs receive a local avatar', () => {
  for (const [id, expected] of assignments) assert.equal(agentAvatarKey(id), expected);
});

test('assignments remain stable after unrelated selections, reordering and reopening the module', async () => {
  for (const [id, expected] of [...assignments].reverse()) assert.equal(agentAvatarKey(id), expected);
  for (let i = 0; i < 20; i++) agentAvatarKey(`unrelated-${i}`);
  for (const [id, expected] of assignments) assert.equal(agentAvatarKey(id), expected);
  const reopenedUrl = new URL('./agentAvatars.ts', import.meta.url);
  reopenedUrl.search = 'reopened';
  const reopened = await import(reopenedUrl.href) as typeof import('./agentAvatars.ts');
  for (const [id, expected] of assignments) assert.equal(reopened.agentAvatarKey(id), expected);
});

test('every string selects a bundled key, including Unicode, inherited property names and IDs beyond signed hash range', () => {
  for (const id of ['', '机器人', '🛠️', 'agentA', 'x'.repeat(1024), 'constructor', '__proto__', 'toString']) {
    assert.ok(AGENT_AVATAR_KEYS.includes(agentAvatarKey(id)), id);
  }
});
