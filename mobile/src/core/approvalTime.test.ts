import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalDeadline } from './approvalTime.ts';
test('a phone ahead or behind keeps the five-minute deadline from the Puente millisecond clock', () => {
 assert.equal(approvalDeadline(1300000,600000),1900000);
 assert.equal(approvalDeadline(1300000,-600000),700000);
 assert.equal(approvalDeadline(null,600000),null);
 assert.equal(approvalDeadline(1300000,0),1300000);
});
