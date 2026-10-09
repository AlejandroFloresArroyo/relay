import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Health } from '../../../protocol/protocol.ts';
import { RelayError, type RelayClient } from './client.ts';
import { pollConnection } from './connection.ts';

const URL = 'http://atlas.example.ts.net:8650';
const healthy: Health = { ok: true, service: 'relayd', version: '9.9.9', protocolVersion: 2, minAppProtocolVersion: 2 };
const client = (overrides: Partial<RelayClient> = {}): RelayClient => ({
  health: async () => healthy, agents: async () => [], approvals: async () => [], ...overrides,
} as RelayClient);

test('health notice survives a 401 from authenticated operations', async () => {
  let queried = false;
  const snap = await pollConnection(client({
    health: async () => { queried = true; return { ok: true, service: 'relayd', version: 'old' }; },
    agents: async () => { throw new RelayError('unauthorized', 'x', 401); },
  }), URL);
  assert.equal(queried, true);
  assert.equal(snap.protocol?.kind, 'update_bridge');
  assert.equal(snap.protocolStale, false);
  assert.equal(snap.down?.label, 'LLAVE RECHAZADA');
});

test('compatible operations remain available with a version notice', async () => {
  const snap = await pollConnection(client({ health: async () => ({ ...healthy, protocolVersion: 3, minAppProtocolVersion: 3 }) }), URL);
  assert.equal(snap.reachable, true);
  assert.equal(snap.protocol?.kind, 'update_app');
  assert.equal(snap.down, null);
});

test('timeout retains the last version as stale and recovery refreshes it', async () => {
  const old = await pollConnection(client({ health: async () => ({ ok: true, service: 'relayd', version: 'old' }) }), URL);
  const offline = client({
    health: async () => { throw new RelayError('timeout', 'x'); },
    agents: async () => { throw new RelayError('timeout', 'x'); },
  });
  const snap = await pollConnection(offline, URL, old);
  assert.equal(snap.protocol?.kind, 'update_bridge');
  assert.equal(snap.protocolStale, true);
  assert.equal(snap.down?.label, 'SIN RESPUESTA');
  assert.equal((await pollConnection(offline, URL)).protocol, null);
  const recovered = await pollConnection(client(), URL, snap);
  assert.equal(recovered.protocol?.kind, 'compatible');
  assert.equal(recovered.protocolStale, false);
  assert.equal(recovered.reachable, true);
});

test('protocol state is isolated by server URL', async () => {
  const old = await pollConnection(client({ health: async () => ({ ok: true, service: 'relayd', version: 'old' }) }), URL);
  const next = await pollConnection(client({ health: async () => { throw new RelayError('timeout', 'x'); } }), 'http://other.example.ts.net:8650', old);
  assert.equal(next.protocol, null);
});

test('revoked approvals override earlier successful agents and clear pending approvals', async () => {
  const snap = await pollConnection(client({ approvals: async () => { throw new RelayError('device_revoked', 'x', 403); } }), URL);
  assert.equal(snap.reachable, false);
  assert.equal(snap.down?.label, 'DISPOSITIVO REVOCADO');
  assert.deepEqual(snap.approvals, []);
  assert.equal(snap.protocol?.kind, 'compatible');
  assert.equal(snap.down?.automaticRetry, false);
});

test('invalid health is explicit and does not pretend to match', async () => {
  const snap = await pollConnection(client({ health: async () => ({ ...healthy, protocolVersion: NaN }) }), URL);
  assert.equal(snap.protocol?.kind, 'invalid');
});

const pausedControl = { paused: true, hermesPaused: true, phase: 'ready', action: null } as const;

test('the shared snapshot carries the Pausa general so every screen can show it', async () => {
  const snap = await pollConnection(client({ serverControl: async () => pausedControl }), URL);
  assert.equal(snap.reachable, true);
  assert.deepEqual(snap.serverControl, pausedControl);
});

test('a Puente without pause control stays reachable and reports no pause', async () => {
  const old = await pollConnection(client({ serverControl: async () => pausedControl }), URL);
  const snap = await pollConnection(client({ serverControl: async () => { throw new RelayError('http', 'Not found', 404); } }), URL, old);
  assert.equal(snap.reachable, true);
  assert.equal(snap.down, null);
  assert.equal(snap.serverControl, null);
});

test('a transient failure of the control route keeps the last known pause', async () => {
  const old = await pollConnection(client({ serverControl: async () => pausedControl }), URL);
  const snap = await pollConnection(client({ serverControl: async () => { throw new RelayError('timeout', 'x'); } }), URL, old);
  assert.equal(snap.reachable, true);
  assert.deepEqual(snap.serverControl, pausedControl);
  const failed = await pollConnection(client({ serverControl: async () => { throw new RelayError('http', 'x', 500); } }), URL, old);
  assert.deepEqual(failed.serverControl, pausedControl);
});

test('an unreachable Servidor keeps its last known pause instead of claiming it resumed', async () => {
  const old = await pollConnection(client({ serverControl: async () => pausedControl }), URL);
  const offline = async () => { throw new RelayError('timeout', 'x'); };
  const snap = await pollConnection(client({ health: offline, agents: offline, serverControl: offline }), URL, old);
  assert.equal(snap.reachable, false);
  assert.deepEqual(snap.serverControl, pausedControl);
  assert.equal((await pollConnection(client({ serverControl: async () => pausedControl }), 'http://other.example.ts.net:8650', old)).serverControl?.paused, true);
  assert.equal((await pollConnection(client({ health: offline, agents: offline, serverControl: offline }), 'http://other.example.ts.net:8650', old)).serverControl, null);
});
