import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openTailscale } from '../state/openTailscale.ts';
import { describeTailscaleButton, transitionTailscaleButton, type TailscaleButtonState } from './tailscaleButton.ts';

test('failed Tailscale launch changes the label and fallback retries detection without relaunching', async () => {
  let state: TailscaleButtonState = 'ready';
  let launches = 0;
  let retries = 0;
  const press = async () => {
    const transition = transitionTailscaleButton(state, { type: 'press' });
    state = transition.state;
    if (transition.effect === 'retry') retries++;
    if (transition.effect === 'open') {
      const opened = await openTailscale({ platform: 'android', openURL: async () => { launches++; throw new Error('synthetic rejection'); } });
      state = transitionTailscaleButton(state, { type: 'result', opened }).state;
    }
  };
  assert.deepEqual(describeTailscaleButton(state), { label: 'Abrir Tailscale', disabled: false });
  await press();
  assert.deepEqual(describeTailscaleButton(state), { label: 'Volver a detectar', disabled: false });
  await press();
  await press();
  assert.equal(retries, 2);
  assert.equal(launches, 1);
});

test('Tailscale button disables repeat launch presses while opening', () => {
  const opening = transitionTailscaleButton('ready', { type: 'press' });
  assert.deepEqual(opening, { state: 'opening', effect: 'open' });
  assert.equal(describeTailscaleButton(opening.state).disabled, true);
  assert.deepEqual(transitionTailscaleButton(opening.state, { type: 'press' }), { state: 'opening', effect: null });
});

test('successful Tailscale launch leaves the launch action available', () => {
  const next = transitionTailscaleButton('opening', { type: 'result', opened: true });
  assert.deepEqual(describeTailscaleButton(next.state), { label: 'Abrir Tailscale', disabled: false });
  assert.deepEqual(transitionTailscaleButton(next.state, { type: 'press' }), { state: 'opening', effect: 'open' });
});
