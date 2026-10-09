import assert from 'node:assert/strict';
import { test } from 'node:test';

import { approvalOutcome } from './approval.ts';

test('only an explicit expired resolution produces an expired outcome', () => {
  assert.equal(approvalOutcome('deny', 'expired'), 'expired');
  assert.equal(approvalOutcome('once', 'expired'), 'expired');
});

test('decision plus deny is rejected', () => {
  assert.equal(approvalOutcome('deny', 'decision'), 'rejected');
  assert.equal(approvalOutcome('once', 'decision'), 'approved');
  assert.equal(approvalOutcome('session', 'decision'), 'approved');
});

test('a missing resolution from a legacy Puente never proves expiry', () => {
  assert.equal(approvalOutcome('deny'), 'rejected');
  assert.equal(approvalOutcome('once'), 'approved');
});
