import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridgeClient } from './bridgeClient.ts';
import { RelayError } from './client.ts';

const tools = { platform: 'api_server', appliesTo: 'next_turn', observedAt: 1791028800000,
  toolsets: [{ name: 'terminal', label: 'Terminal', description: 'Synthetic tool', enabled: false, configured: true, tools: ['terminal'] }] };

test('Tools read and change retain api_server next-Turn metadata and the existing authenticated protocol', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const saved = { ...tools, toolsets: [{ ...tools.toolsets[0], enabled: true }] };
  const client = createBridgeClient({ baseUrl: 'http://fixture.example.ts.net:17651', key: 'fixture-key', fetch: (async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return Response.json(init?.method === 'POST' ? saved : tools);
  }) as typeof fetch });
  assert.deepEqual(await client.agentTools!('a /?'), tools);
  assert.deepEqual(await client.setToolset!('a /?', 'terminal /?', true), saved);
  assert.deepEqual(calls.map(call => [call.url, call.init.method, call.init.body]), [
    ['http://fixture.example.ts.net:17651/v1/agents/a%20%2F%3F/tools', 'GET', undefined],
    ['http://fixture.example.ts.net:17651/v1/agents/a%20%2F%3F/tools/terminal%20%2F%3F', 'POST', '{"enabled":true}'],
  ]);
  for (const call of calls) {
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get('Authorization'), 'Bearer fixture-key');
    assert.equal(headers.get('X-Relay-Protocol'), '2');
  }
});

test('unsupported Tools application claims fail closed on GET and POST with a safe fixed error', async () => {
  for (const appliesTo of ['new_conversations', 'current_turn', 'all_channels', 'private-fixture-claim', null, undefined]) {
    const client = createBridgeClient({ baseUrl: 'http://fixture.example.ts.net:17651', key: 'fixture-key',
      fetch: (async () => Response.json({ ...tools, appliesTo })) as typeof fetch });
    for (const operation of [() => client.agentTools!('default'), () => client.setToolset!('default', 'terminal', false)]) {
      await assert.rejects(operation(), failure => {
        assert.ok(failure instanceof RelayError);
        assert.equal(failure.code, 'agent_tools_unavailable');
        assert.equal(failure.status, 503);
        assert.doesNotMatch(failure.message, /private-fixture|current_turn|all_channels|new_conversations/);
        return true;
      });
    }
  }
});
