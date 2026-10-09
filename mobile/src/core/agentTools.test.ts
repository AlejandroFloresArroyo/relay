import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAgentSkills, isAgentTools } from './agentTools.ts';

const tools = { platform: 'api_server', appliesTo: 'next_turn', observedAt: 1791028800000,
  toolsets: [{ name: 'terminal', label: 'Terminal', description: 'Execute', enabled: false, configured: true, tools: ['terminal'] }] };
const skills = { scope: 'profile_installed', observedAt: 1791028800000, limited: false,
  skills: [{ name: 'review-pr', description: 'Review', category: null, availability: 'unknown' }] };

test('tools contract accepts only the Relay channel, bounded canonical rows and millisecond timestamps', () => {
  assert.equal(isAgentTools(tools), true);
  for (const value of [null, {}, { ...tools, platform: 'discord' }, { ...tools, observedAt: NaN },
    { ...tools, observedAt: 8_640_000_000_000_001 }, { ...tools, toolsets: [tools.toolsets[0], tools.toolsets[0]] },
    { ...tools, toolsets: [{ ...tools.toolsets[0], configured: 'yes' }] }, { ...tools, toolsets: Array(513).fill(tools.toolsets[0]) }]) {
    assert.equal(isAgentTools(value), false);
  }
});

test('unknown or obsolete application claims fail closed instead of becoming writable Tools metadata', () => {
  for (const appliesTo of ['new_conversations', 'nextConversation', 'current_turn', 'all_channels', '', null, undefined, 1]) {
    assert.equal(isAgentTools({ ...tools, appliesTo }), false, String(appliesTo));
  }
});

test('installed skill metadata cannot claim active runtime availability', () => {
  assert.equal(isAgentSkills(skills), true);
  assert.equal(isAgentSkills({ ...skills, skills: [{ ...skills.skills[0], availability: 'disabled' }] }), true);
  for (const value of [null, {}, { ...skills, scope: 'catalog' }, { ...skills, observedAt: -1 },
    { ...skills, skills: [{ ...skills.skills[0], availability: 'active' }] },
    { ...skills, skills: [{ ...skills.skills[0], description: 'x'.repeat(1001) }] }]) {
    assert.equal(isAgentSkills(value), false);
  }
});
