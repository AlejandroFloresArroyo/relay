import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUTH_ERROR_CODES,
  AUTH_ERROR_STATUS,
  MIN_APP_PROTOCOL_VERSION,
  MIN_BRIDGE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from '../../../protocol/protocol.ts';

test('the shared protocol exports positive integer versions and a status for every auth error', () => {
  for (const version of [PROTOCOL_VERSION, MIN_BRIDGE_PROTOCOL_VERSION, MIN_APP_PROTOCOL_VERSION]) {
    assert.ok(Number.isInteger(version) && version > 0);
  }
  for (const code of Object.values(AUTH_ERROR_CODES)) {
    const status = AUTH_ERROR_STATUS[code];
    assert.ok(Number.isInteger(status) && status >= 400 && status <= 599, code);
  }
});
