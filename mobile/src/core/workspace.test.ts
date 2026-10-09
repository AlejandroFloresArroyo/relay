import assert from 'node:assert/strict';
import test from 'node:test';
import { focusPanel, pickTool, placeTool, revealTool, splitWorkspace, WORKSPACE_START, workspacePanels } from './workspace.ts';

test('a phone shows one tool; a wide window shows two panels only when asked, and the focused one alone otherwise', () => {
  const split = splitWorkspace(WORKSPACE_START, true);
  assert.deepEqual(workspacePanels(WORKSPACE_START, true), [0]);
  assert.deepEqual(workspacePanels(split, false), [0]);
  assert.deepEqual(workspacePanels(split, true), [0, 1]);
  assert.deepEqual(placeTool(split, true, 'files'), { panel: 1, side: 'right' });
  assert.deepEqual(placeTool(split, true, 'terminal'), { panel: 0, side: 'left' });
  assert.equal(placeTool(split, true, 'web'), null);
  // Narrowed (a split window, large text): the focused panel alone, the other tool kept aside.
  const second = focusPanel(split, 1);
  assert.deepEqual(placeTool(second, false, 'files'), { panel: 1, side: 'full' });
  assert.equal(placeTool(second, false, 'terminal'), null);
  assert.deepEqual(placeTool(splitWorkspace(second, false), true, 'files'), { panel: 1, side: 'full' });
});

test('a tool lives in one panel: choosing the other panel\'s tool swaps them, and the chosen panel takes the keyboard', () => {
  const split = splitWorkspace(WORKSPACE_START, true);
  const swapped = pickTool(split, 1, 'terminal');
  assert.deepEqual(swapped.tools, ['files', 'terminal']);
  assert.equal(swapped.focus, 1);
  const web = pickTool(swapped, 0, 'web');
  assert.deepEqual(web.tools, ['web', 'terminal']);
  assert.equal(web.focus, 0);
  // One panel: the hidden one keeps a different tool, ready for two panels again.
  const single = pickTool(WORKSPACE_START, 0, 'files');
  assert.deepEqual(single.tools, ['files', 'terminal']);
  assert.equal(new Set(single.tools).size, 2);
});

test('revealing a tool focuses its panel when shown; otherwise it opens beside the panel that asked, or in place on one panel', () => {
  const split = splitWorkspace(pickTool(WORKSPACE_START, 0, 'files'), true);
  // Files in panel 0 (focused) asks for a terminal, already in panel 1: only the keyboard moves.
  assert.deepEqual(revealTool(split, true, 'terminal'), { ...split, focus: 1 });
  // Web asks for the browser: it opens in the other panel, and Web stays in view.
  const web = pickTool(split, 0, 'web');
  const browser = revealTool(web, true, 'browser');
  assert.deepEqual(browser.tools, ['web', 'browser']);
  assert.equal(browser.focus, 1);
  // On a phone the tool replaces the one shown.
  const phone = revealTool(web, false, 'browser');
  assert.deepEqual(phone.tools, ['browser', 'terminal']);
  assert.equal(phone.focus, 0);
});
