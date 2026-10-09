import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Agent, Approval, Health } from '../../../protocol/protocol.ts';
import { createPairedBridgeClient } from './bridgeClient.ts';
import { pollConnection } from './connection.ts';
import { planConnectionPolls, recordConnectionPoll } from './connectionPolling.ts';
import { serverConnectionPresentation } from './connectionStatus.ts';

const URL = 'http://atlas.example.ts.net:8650';
const health: Health = { ok: true, service: 'relayd', version: 'test', protocolVersion: 2, minAppProtocolVersion: 2 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('legacy and key-less polling queries public health, offers pairing and suspends without private requests', async () => {
  for (const credentials of [{ key: 'synthetic-legacy' }, { key: '', deviceId: 'synthetic-device' }]) {
    const requests: { path: string; authorization: string | null }[] = [];
    const server = { id: 'atlas', url: URL, ...credentials };
    const client = createPairedBridgeClient({ baseUrl: server.url, ...credentials, fetch: (async (url, init) => {
      requests.push({ path: new globalThis.URL(String(url)).pathname, authorization: new Headers(init?.headers).get('Authorization') });
      return json(health);
    }) as typeof fetch });
    const plan = planConnectionPolls(new Map(), [server]);
    assert.deepEqual(plan.connections, [server]);
    const snapshot = await pollConnection(client, server.url);
    assert.deepEqual(requests, [{ path: '/health', authorization: null }]);
    assert.equal(snapshot.protocol?.kind, 'compatible');
    assert.equal(snapshot.protocolStale, false);
    assert.equal(snapshot.reachable, false);
    assert.equal(snapshot.down?.kind, 'known');
    assert.equal(snapshot.down?.label, 'EMPAREJAMIENTO NECESARIO');
    assert.equal(snapshot.down?.automaticRetry, false);
    assert.equal(serverConnectionPresentation(snapshot)?.diagnosis?.action, 'pair');
    const suspended = recordConnectionPoll(plan.state, server, snapshot.down);
    assert.deepEqual(planConnectionPolls(suspended, [server]).connections, []);
  }
});

test('polling revocation overrides earlier data and retains cached agents as unreachable with a pairing panel', async () => {
  const server = { id: 'atlas', url: URL, key: 'synthetic-key', deviceId: 'synthetic-device' };
  const agents: Agent[] = [{ id: 'dev', name: 'dev', model: 'test', provider: 'test', status: 'on', pendingApprovals: 1, lastMessage: null }];
  const approvals: Approval[] = [{ id: 'synthetic-approval', agentId: 'dev' } as Approval];
  let revoked = false;
  const paths: string[] = [];
  const client = createPairedBridgeClient({ baseUrl: server.url, ...server, fetch: (async (url, init) => {
    const path = new globalThis.URL(String(url)).pathname;
    paths.push(path);
    assert.equal(new Headers(init?.headers).get('Authorization'), path === '/health' ? null : 'Bearer synthetic-key');
    if (path === '/health') return json(health);
    if (path === '/v1/agents') return json({ agents });
    if (path === '/v1/server/control') return revoked ? json({ error: { code: 'device_revoked', message: 'synthetic denial' } }, 403) : json({ paused: false, hermesPaused: false, phase: 'ready', action: null });
    assert.equal(path, '/v1/approvals');
    return revoked ? json({ error: { code: 'device_revoked', message: 'synthetic denial' } }, 403) : json({ approvals });
  }) as typeof fetch });
  const initial = await pollConnection(client, server.url, undefined, () => 1000);
  assert.equal(initial.reachable, true);
  assert.deepEqual(initial.agents, agents);
  assert.deepEqual(initial.approvals, approvals);
  assert.equal(serverConnectionPresentation(initial), null);
  revoked = true;
  paths.length = 0;
  const snapshot = await pollConnection(client, server.url, initial, () => 2000);
  assert.deepEqual(paths, ['/health', '/v1/agents', '/v1/approvals', '/v1/server/control']);
  assert.equal(snapshot.reachable, false);
  assert.deepEqual(snapshot.agents, agents);
  assert.deepEqual(snapshot.approvals, []);
  assert.equal(snapshot.lastContactAt, 1000);
  assert.equal(snapshot.latencyMs, null);
  assert.equal(snapshot.protocol?.kind, 'compatible');
  assert.equal(snapshot.down?.kind, 'known');
  assert.equal(snapshot.down?.label, 'DISPOSITIVO REVOCADO');
  assert.equal(snapshot.down?.automaticRetry, false);
  const presentation = serverConnectionPresentation(snapshot);
  assert.equal(presentation?.diagnosis?.label, 'DISPOSITIVO REVOCADO');
  assert.equal(presentation?.diagnosis?.action, 'pair');
  const plan = planConnectionPolls(new Map(), [server]);
  assert.deepEqual(planConnectionPolls(recordConnectionPoll(plan.state, server, snapshot.down), [server]).connections, []);
});
