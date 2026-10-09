import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkProtocolVersion } from './protocolVersion.ts';
import { describeRemoteToolState, remoteToolStates, type AppRemoteCapabilities, type RemoteInputs } from './remoteCapabilities.ts';

const V1 = { version: 1, minAppVersion: 1 };
const APP: AppRemoteCapabilities = {
  environments: { version: 1, minBridgeVersion: 1 }, terminal: { version: 1, minBridgeVersion: 1 },
  files: { version: 2, minBridgeVersion: 1 }, web: { version: 1, minBridgeVersion: 1 }, browser: { version: 1, minBridgeVersion: 1 },
};
const ALL = { environments: V1, terminal: V1, files: V1, web: V1, browser: V1 };
const health = (capabilities?: unknown, protocol: Record<string, unknown> = { protocolVersion: 2, minAppProtocolVersion: 2 }) =>
  ({ ok: true, service: 'relayd', version: '9.9.9', ...protocol, ...(capabilities === undefined ? {} : { capabilities }) });
const inputs = (body: unknown, extra: Partial<RemoteInputs> = {}): RemoteInputs =>
  ({ health: { body, at: 100 }, lastConnectionFailureAt: null, bridgeChangedAt: null, status: null, app: APP, ...extra });
const states = (body: unknown, extra: Partial<RemoteInputs> = {}) => remoteToolStates(inputs(body, extra));

test('an old Puente without capabilities offers no tool, asks for its update and keeps protocol compatibility', () => {
  const result = states(health());
  for (const tool of Object.values(result.tools)) assert.deepEqual(tool, { state: 'update_bridge' });
  assert.equal(Object.keys(result.tools).length, 6);
  assert.equal(result.status, null);
  assert.equal(checkProtocolVersion(health()).kind, 'compatible');
});

test('a malformed advertisement counts as absent per entry and never touches the protocol check', () => {
  for (const capabilities of [null, [], 'files', 7, [V1]]) {
    assert.equal(checkProtocolVersion(health(capabilities)).kind, 'compatible');
    assert.equal(states(health(capabilities)).tools.files?.state, 'update_bridge', JSON.stringify(capabilities));
  }
  const result = states(health({
    files: { version: 1, minAppVersion: 2 }, web: { version: -1, minAppVersion: 0 }, browser: { version: 1.5, minAppVersion: 1 },
    environments: V1, terminal: { version: '1', minAppVersion: 1 }, unknown: 'ignored',
  }));
  assert.equal(result.tools.files?.state, 'update_bridge');
  assert.equal(result.tools.webInRelay?.state, 'update_bridge');
  assert.equal(result.tools.browserDedicated?.state, 'update_bridge');
  assert.equal(result.tools.terminal?.state, 'update_bridge');
  assert.deepEqual(result.status, { name: 'environments', version: 1 });
});

test('a partial Puente offers only what it advertises; terminal and browser need environments', () => {
  const result = states(health({ files: V1, terminal: V1, browser: V1 }));
  assert.equal(result.tools.files?.state, 'checking');
  assert.equal(result.tools.terminal?.state, 'update_bridge');
  assert.equal(result.tools.browserHabitual?.state, 'update_bridge');
  assert.equal(result.tools.webExternal?.state, 'update_bridge');
  assert.equal(states(health({ environments: { version: 9, minAppVersion: 9 }, terminal: V1 })).tools.terminal?.state, 'update_app');
});

test('an app that declares terminal without environments never offers the terminal, whatever the Puente advertises', () => {
  const status = { body: { serverNow: 1, terminal: { state: 'available' as const } }, at: 101 };
  const without = states(health(ALL), { app: { terminal: { version: 1, minBridgeVersion: 1 } }, status });
  assert.deepEqual(without.tools, {});
  assert.equal(without.status, null);
  // This build declares both, so with both advertised the terminal opens.
  assert.deepEqual(remoteToolStates({ ...inputs(health(ALL)), app: undefined, status }).tools.terminal,
    { state: 'available', capability: { name: 'terminal', version: 1 } });
});

test('a future capability negotiates down or asks for Relay; an older one asks for the Puente', () => {
  const later = states(health({ ...ALL, files: { version: 7, minAppVersion: 1 } }), { status: { body: { serverNow: 1, files: { state: 'available' } }, at: 101 } });
  assert.deepEqual(later.tools.files, { state: 'available', capability: { name: 'files', version: 2 } });
  assert.equal(states(health({ files: { version: 7, minAppVersion: 3 } })).tools.files?.state, 'update_app');
  assert.equal(states(health({ files: V1 }), { app: { files: { version: 3, minBridgeVersion: 2 } } }).tools.files?.state, 'update_bridge');
});

test('a network failure is never shown as a missing capability or an old version', () => {
  for (const extra of [{ health: null }, { lastConnectionFailureAt: 100 }, { lastConnectionFailureAt: 150 }]) {
    const result = states(health(ALL), { status: { body: { serverNow: 1, files: { state: 'available' } }, at: 101 }, ...extra });
    for (const tool of Object.values(result.tools)) assert.deepEqual(tool, { state: 'no_response' });
    assert.equal(result.status, null);
  }
  for (const tool of Object.values(states(health(), { lastConnectionFailureAt: 150 }).tools)) assert.deepEqual(tool, { state: 'no_response' });
});

test('an incompatible protocol hides every tool behind its notice', () => {
  const result = states(health(ALL, { protocolVersion: 3, minAppProtocolVersion: 3 }));
  for (const tool of Object.values(result.tools)) assert.deepEqual(tool, { state: 'protocol', message: 'Actualiza Relay' });
  assert.equal(result.status, null);
});

test('the authenticated status decides availability; an advertised tool missing from it is not_reported', () => {
  const status = { serverNow: 1, files: { state: 'available' }, terminal: { state: 'unavailable', reason: 'helper_missing' }, web: { inRelay: { state: 'available' }, external: { state: 'unavailable', reason: 'not_configured' } } } as const;
  const result = states(health(ALL), { status: { body: status, at: 101 } });
  assert.deepEqual(result.tools.files, { state: 'available', capability: { name: 'files', version: 1 } });
  assert.deepEqual(result.tools.terminal, { state: 'unavailable', reason: 'helper_missing' });
  assert.deepEqual(result.tools.webExternal, { state: 'unavailable', reason: 'not_configured' });
  assert.deepEqual(result.tools.browserDedicated, { state: 'unavailable', reason: 'not_reported' });
  assert.equal(describeRemoteToolState(result.tools.terminal!).label, 'No disponible en este Servidor');
  // A status from before the last connection failure is not current, even after /health came back.
  assert.equal(states(health(ALL), { health: { body: health(ALL), at: 300 }, lastConnectionFailureAt: 200, status: { body: status, at: 101 } }).tools.files?.state, 'checking');
});

test('an advertisement contradicted by a remote response stops counting until /health is read again', () => {
  const result = states(health(ALL), { bridgeChangedAt: 100, status: { body: { serverNow: 1, files: { state: 'available' } }, at: 101 } });
  for (const tool of Object.values(result.tools)) assert.deepEqual(tool, { state: 'checking' });
  assert.equal(result.status, null);
  assert.equal(states(health(ALL), { health: { body: health(ALL), at: 200 }, bridgeChangedAt: 100 }).status?.name, 'environments');
  // A status read before the Puente changed is not current either, even after /health came back.
  const stale = states(health(ALL), { health: { body: health(ALL), at: 200 }, bridgeChangedAt: 100, status: { body: { serverNow: 1, files: { state: 'available' } }, at: 50 } });
  assert.equal(stale.tools.files?.state, 'checking');
});

test('a tool the app does not implement is not offered and asks nothing of the Puente', () => {
  const result = states(health(ALL), { app: {} });
  assert.deepEqual(result, { tools: {}, status: null });
});

test('each state has its own words', () => {
  assert.equal(describeRemoteToolState({ state: 'update_bridge' }).label, 'Actualiza el Puente');
  assert.equal(describeRemoteToolState({ state: 'update_app' }).label, 'Actualiza Relay');
  assert.equal(describeRemoteToolState({ state: 'no_response' }).label, 'Sin respuesta');
  assert.match(describeRemoteToolState({ state: 'unavailable', reason: 'dependency_missing' }).hint ?? '', /instal/i);
});
