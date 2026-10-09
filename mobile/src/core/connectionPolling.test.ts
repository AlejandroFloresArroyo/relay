import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RelayError, type RelayClient } from './client.ts';
import { pollConnection } from './connection.ts';
import { classifyConnectionError } from './connectionStatus.ts';
import { planConnectionPolls, recordConnectionPoll, retryConnectionPoll, type ConnectionPollState } from './connectionPolling.ts';

test('another server approval refresh preserves suspension until that server is explicitly retried', async () => {
  const servers = [
    { id: 'atlas', url: 'http://atlas.example.ts.net:8650', key: 'synthetic-atlas' },
    { id: 'homelab', url: 'http://homelab.example.ts.net:8650', key: 'synthetic-homelab' },
  ];
  const calls = { atlas: 0, homelab: 0 };
  const clients = Object.fromEntries(servers.map((server) => [server.id, {
    health: async () => ({ ok: true, service: 'relayd', version: '1', protocolVersion: 2, minAppProtocolVersion: 2 }),
    agents: async () => {
      calls[server.id as keyof typeof calls]++;
      if (server.id === 'homelab') throw new RelayError('rate_limited', 'synthetic', 429);
      return [];
    },
    approvals: async () => [],
  } as unknown as RelayClient]));
  let state: ConnectionPollState = new Map();
  const refresh = async (retryServerId?: string) => {
    if (retryServerId) state = retryConnectionPoll(state, retryServerId);
    const plan = planConnectionPolls(state, servers);
    state = plan.state;
    for (const server of plan.connections) {
      const result = await pollConnection(clients[server.id], server.url);
      state = recordConnectionPoll(state, server, result.down);
    }
  };

  await refresh();
  assert.deepEqual(calls, { atlas: 1, homelab: 1 });
  await refresh(); // interval
  await refresh(); // atlas approval.request -> ordinary refresh
  await refresh('atlas'); // explicit retry of the other server
  assert.deepEqual(calls, { atlas: 4, homelab: 1 });
  await refresh('homelab');
  assert.deepEqual(calls, { atlas: 5, homelab: 2 });
});

test('only replacing a suspended server connection or credential resumes it automatically', () => {
  const atlas = { id: 'atlas', url: 'http://atlas.example.ts.net:8650', key: 'synthetic-atlas', deviceId: 'device-atlas', name: 'atlas' };
  const homelab = { id: 'homelab', url: 'http://homelab.example.ts.net:8650', key: 'synthetic-homelab', deviceId: 'device-homelab' };
  let state = planConnectionPolls(new Map(), [atlas, homelab]).state;
  state = recordConnectionPoll(state, atlas, classifyConnectionError(new RelayError('device_revoked', 'synthetic', 403)));
  state = recordConnectionPoll(state, homelab, classifyConnectionError(new RelayError('key_unknown', 'synthetic', 401)));
  assert.deepEqual(planConnectionPolls(state, [{ ...atlas, name: 'renamed' }, homelab]).connections, []);
  for (const replacement of [
    { ...atlas, key: 'synthetic-replacement' },
    { ...atlas, deviceId: 'replacement-device' },
    { ...atlas, url: 'http://other.example.ts.net:8650' },
  ]) {
    const plan = planConnectionPolls(state, [replacement, homelab]);
    assert.deepEqual(plan.connections.map((s) => s.id), ['atlas']);
    // A late result from the old connection must not suspend its replacement.
    const next = recordConnectionPoll(plan.state, atlas, classifyConnectionError(new RelayError('rate_limited', 'synthetic', 429)));
    assert.deepEqual(planConnectionPolls(next, [replacement, homelab]).connections.map((s) => s.id), ['atlas']);
  }
  assert.deepEqual(planConnectionPolls(retryConnectionPoll(state, 'atlas'), [atlas, homelab]).connections.map((s) => s.id), ['atlas']);
  assert.deepEqual(planConnectionPolls(state, [atlas]).state.size, 1);
});
