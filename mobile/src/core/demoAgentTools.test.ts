import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDemoClient, DEMO_AGENT_TOOLS_SCENARIOS, resetDemo, setDemoAgentToolsScenario } from './demo.ts';
import { RelayError } from './client.ts';

test('the skills-unavailable demo refreshes Tools while only the installed skills reading fails', async () => {
  resetDemo();
  let now = 1_000_000;
  const client = createDemoClient('atlas', () => now);
  const previous = await client.agentSkills!('dev');
  setDemoAgentToolsScenario('atlas', 'dev', 'skills-unavailable');
  now += 60_000;
  assert.ok(DEMO_AGENT_TOOLS_SCENARIOS.includes('skills-unavailable'));
  const tools = await client.agentTools!('dev');
  assert.equal(tools.observedAt, now);
  assert.equal(tools.appliesTo, 'next_turn');
  assert.equal(tools.platform, 'api_server');
  await assert.rejects(client.agentSkills!('dev'), error => error instanceof RelayError && error.code === 'agent_tools_unavailable');
  assert.equal(previous.observedAt, 1_000_000);
  const updated = await client.setToolset!('dev', 'terminal', false);
  assert.equal(updated.appliesTo, 'next_turn');
  assert.equal(updated.platform, 'api_server');
  assert.equal(updated.toolsets.find(tool => tool.name === 'terminal')?.enabled, false);
  setDemoAgentToolsScenario('atlas', 'dev', 'normal');
  resetDemo();
});
