import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseServer, selectedServer } from './selectedServer.ts';

const atlas = { id: 'atlas', isDefault: true };
const homelab = { id: 'homelab', isDefault: false };

test('the first time, the selected Servidor is the default one', () => {
  assert.equal(selectedServer([homelab, atlas], null), 'atlas');
});

test('a remembered Servidor stays selected, also when it stops answering: reachability is not an input', () => {
  assert.equal(selectedServer([atlas, homelab], 'homelab'), 'homelab');
});

test('a removed Servidor falls back to the default one, or to none when no Servidor is left', () => {
  assert.equal(selectedServer([atlas], 'homelab'), 'atlas');
  assert.equal(selectedServer([], 'homelab'), null);
  assert.equal(selectedServer([], null), null);
});

test('an entry chooses a paired Servidor and anything else keeps the current one', () => {
  assert.equal(chooseServer([atlas, homelab], 'atlas', 'homelab'), 'homelab');
  assert.equal(chooseServer([atlas, homelab], 'atlas', 'unknown'), 'atlas');
  assert.equal(chooseServer([atlas], null, 'unknown'), null);
});
