import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkProtocolVersion } from './protocolVersion.ts';

const health = (fields: Record<string, unknown> = {}) => ({ ok: true, service: 'relayd', version: '9.9.9', ...fields });

test('equal protocol generations are compatible', () => {
  assert.equal(checkProtocolVersion(health({ protocolVersion: 2, minAppProtocolVersion: 2 })).kind, 'compatible');
});

test('a legacy health without protocolVersion requires updating the Puente', () => {
  assert.equal(checkProtocolVersion(health()).kind, 'update_bridge');
});

test('bridge below the app minimum requires updating the Puente before checking its minimum', () => {
  assert.equal(checkProtocolVersion(health({ protocolVersion: 0 })).kind, 'update_bridge');
  assert.equal(checkProtocolVersion(health({ protocolVersion: 1, minAppProtocolVersion: 1 })).kind, 'update_bridge');
  assert.equal(checkProtocolVersion(health({ protocolVersion: 2, minAppProtocolVersion: 2 }), 1, 3).kind, 'update_bridge');
});

test('bridge minimum above the app generation requires updating Relay', () => {
  assert.equal(checkProtocolVersion(health({ protocolVersion: 3, minAppProtocolVersion: 3 })).kind, 'update_app');
  assert.equal(checkProtocolVersion(health({ protocolVersion: 3 })).kind, 'update_app');
});

test('different generations with compatible ranges show no notice', () => {
  assert.equal(checkProtocolVersion(health({ protocolVersion: 3, minAppProtocolVersion: 1 })).kind, 'compatible');
  assert.equal(checkProtocolVersion(health({ protocolVersion: 2, minAppProtocolVersion: 1 }), 3).kind, 'compatible');
});

test('invalid fields are neither legacy nor compatible', () => {
  for (const value of [null, '1', undefined, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, true]) {
    assert.equal(checkProtocolVersion(health({ protocolVersion: value })).kind, 'invalid', `protocolVersion=${String(value)}`);
    assert.equal(checkProtocolVersion(health({ protocolVersion: 1, minAppProtocolVersion: value })).kind, 'invalid', `minimum=${String(value)}`);
  }
  assert.equal(checkProtocolVersion(health({ protocolVersion: 1, minAppProtocolVersion: 2 })).kind, 'invalid');
  assert.equal(checkProtocolVersion(health({ minAppProtocolVersion: 1 })).kind, 'invalid');
  for (const value of [null, [], {}, { ok: false }, { ok: true, service: 'other', version: '1' }]) {
    assert.equal(checkProtocolVersion(value).kind, 'invalid');
  }
});
