import assert from 'node:assert/strict';
import test from 'node:test';
import { DEMO_TABLET_WINDOWS } from './demoTablet.ts';
import { relayLayout } from './relayLayout.ts';

test('demo windows cover phone, portrait rail, landscape split, multi-window and large text using normal layout rules', () => {
  assert.deepEqual(DEMO_TABLET_WINDOWS.map(window => relayLayout(window.width, window.fontScale).kind),
    ['compact', 'rail', 'split', 'compact', 'compact']);
  assert.ok(DEMO_TABLET_WINDOWS.every(window => window.label.length > 0 && window.height > 0));
});
