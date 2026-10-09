import { test } from 'node:test';
import assert from 'node:assert/strict';
import { widgetDestination, widgetScope, widgetTarget } from './widget.ts';
const server = { id: 'server-A', name: 'ATLAS', url: 'http://atlas.fixture.ts.net:8650', key: 'rly1_SYNTHETIC-KEY', deviceId: 'device-A' };

test('the native target names the selected Servidor and its pairing, never the key', () => {
  const raw = widgetTarget(server, 'dark', false);
  assert.deepEqual(JSON.parse(raw!), { serverId: 'server-A', deviceId: 'device-A', url: server.url, scope: widgetScope('server-A', 'device-A', server.url), label: 'ATLAS', appearance: 'dark' });
  assert.doesNotMatch(raw!, /rly1_|SYNTHETIC-KEY|key/);
});

test('no target without a Servidor, without a device identity, or once the device is revoked', () => {
  assert.equal(widgetTarget(undefined, 'light', false), null);
  assert.equal(widgetTarget({ ...server, deviceId: undefined }, 'light', false), null);
  assert.equal(widgetTarget(server, 'light', true), null);
});

test('the Servidor label is an allowed name, never free text or a credential', () => {
  for (const name of ['Bearer SYNTHETIC', 'sk-SYNTHETIC', 'a'.repeat(25), 'line\nbreak']) assert.equal(JSON.parse(widgetTarget({ ...server, name }, 'light', false)!).label, 'Servidor');
});

test('inbound intents only navigate to a read surface in the current unlocked scope without extra consent or payload', () => {
  const scope = widgetScope('server-A');
  assert.equal(widgetDestination({ scope, target: 'approvals' }, scope, true), '/approvals');
  assert.equal(widgetDestination({ scope: null, target: 'agents' }, null, true), '/agents');
  for (const request of [null, [], { scope, target: 'once' }, { scope, target: 'approvals', choice: 'once' }, { scope, target: 'approvals', command: 'SYNTHETIC' }, { scope: widgetScope('other'), target: 'approvals' }, { scope: null, target: 'approvals' }]) {
    assert.equal(widgetDestination(request, scope, true), null);
  }
  assert.equal(widgetDestination({ scope, target: 'approvals' }, scope, false), null);
});

test('credential-generation scope is distinct and stable', () => {
  assert.equal(widgetScope('A', 'device', 'http://fixture.ts.net'), widgetScope('A', 'device', 'http://fixture.ts.net'));
  assert.notEqual(widgetScope('A', 'first', 'http://fixture.ts.net'), widgetScope('A', 'second', 'http://fixture.ts.net'));
});
