import assert from 'node:assert/strict';
import test from 'node:test';
import { clampWidth, FRAME, forgetWidth, listBounds, listDefault, listWidth, parseWidths, relayLayout, rememberWidth } from './relayLayout.ts';

test('window width chooses useful panes without locking a device class or orientation', () => {
  assert.equal(relayLayout(390).kind, 'compact');
  assert.equal(relayLayout(759).kind, 'compact');
  assert.equal(relayLayout(800).kind, 'rail');
  assert.equal(relayLayout(1000).kind, 'split');
  assert.equal(relayLayout(600).kind, 'compact');
  assert.equal(relayLayout(1200, 1.6).kind, 'compact');
  assert.equal(relayLayout(1200, 1.3).kind, 'rail');
  assert.equal(relayLayout(3000).contentMaxWidth, 820);
});

test('the list lives between 280 and 560 and always leaves the detail 390', () => {
  assert.deepEqual(FRAME.rail, { collapsed: 72, expanded: 240 });
  assert.deepEqual(listBounds(1180, 72), { min: 280, max: 560 });
  assert.deepEqual(listBounds(1180, 240), { min: 280, max: 494 });
  assert.deepEqual(listBounds(800, 72), { min: 280, max: 282 });
  // The expanded rail pushes: a list that no longer fits goes away instead of being covered.
  assert.equal(listBounds(800, 240), null);
  assert.deepEqual(listBounds(1000, 240), { min: 280, max: 314 });
  for (const [window, rail] of [[1180, 72], [1180, 240], [1000, 240], [800, 72]]) {
    const bounds = listBounds(window, rail)!;
    const detail = window - 2 * FRAME.edge - rail - 2 * FRAME.gutter - bounds.max;
    assert.ok(detail >= FRAME.detailMin, `${window}/${rail} leaves ${detail}`);
  }
  assert.equal(clampWidth(100, { min: 280, max: 560 }), 280);
  assert.equal(clampWidth(900, { min: 280, max: 560 }), 560);
  assert.equal(clampWidth(320, { min: 280, max: 314 }), 314);
});

test('each section remembers its own width, and forgetting it brings back that section default', () => {
  assert.equal(listDefault('agents'), 294);
  assert.equal(listDefault('servers'), 320);
  let widths = rememberWidth({}, 'agents', 401.6);
  widths = rememberWidth(widths, 'servers', 300);
  assert.deepEqual(widths, { agents: 402, servers: 300 });
  assert.equal(listWidth(widths, 'agents'), 402);
  widths = forgetWidth(widths, 'agents');
  assert.equal(listWidth(widths, 'agents'), 294);
  assert.equal(listWidth(widths, 'servers'), 300);
});

test('stored widths are read without trusting them', () => {
  assert.deepEqual(parseWidths(JSON.stringify({ agents: 400, servers: 320 })), { agents: 400, servers: 320 });
  assert.deepEqual(parseWidths(JSON.stringify({ agents: 100, servers: 'wide', other: 900, ok: 300 })), { ok: 300 });
  for (const raw of [null, '', 'nope', '[]', '42', 'null', '{"agents":null}']) assert.deepEqual(parseWidths(raw), {});
});
