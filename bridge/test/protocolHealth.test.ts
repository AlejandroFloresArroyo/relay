import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHealth } from '../src/protocolHealth.ts';

test('health declares protocol compatibility and capabilities independently of the product version', () => {
  assert.deepEqual(createHealth('9.9.9', { files: { version: 1, minAppVersion: 1 } }), {
    ok: true, service: 'relayd', version: '9.9.9', protocolVersion: 2, minAppProtocolVersion: 2,
    capabilities: { files: { version: 1, minAppVersion: 1 } },
  });
});
