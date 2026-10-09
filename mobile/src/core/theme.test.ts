import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DARK_PALETTE, LIGHT_PALETTE } from '../theme/tokens.ts';
import { parseThemePreference, resolveTheme } from './theme.ts';

test('stored theme accepts only explicit preferences and defaults to the existing light theme', () => {
  for (const value of ['light', 'dark', 'system'] as const) assert.equal(parseThemePreference(JSON.stringify(value)), value);
  for (const value of [null, '', 'dark', '{}', 'null', '"automatic"']) assert.equal(parseThemePreference(value), 'light');
});
test('system follows native changes with a light fallback; explicit preferences ignore the system', () => {
  assert.equal(resolveTheme('system', 'dark'), 'dark');
  assert.equal(resolveTheme('system', 'light'), 'light');
  assert.equal(resolveTheme('system', null), 'light');
  assert.equal(resolveTheme('dark', 'light'), 'dark');
  assert.equal(resolveTheme('light', 'dark'), 'light');
});

// Measure foreground/background roles rather than snapshotting individual token values.
function luminance(hex: string) {
  const channels = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (values[1] + 0.05) / (values[0] + 0.05);
}
test('K-1 palettes keep body, inverse, primary and recessed text legible', () => {
  for (const { K } of [LIGHT_PALETTE, DARK_PALETTE]) {
    for (const [foreground, background] of [[K.ink, K.background], [K.inkSecondary, K.background], [K.onInk, K.ink], [K.onAccent, K.accent], [K.onScreen, K.screen]])
      assert.ok(contrast(foreground, background) >= 4.5, `${foreground} on ${background}`);
  }
  const { K } = DARK_PALETTE;
  for (const foreground of [K.ink, K.inkSecondary, K.inkTertiary, K.accentText, K.dangerText, K.okText])
    for (const background of [K.background, K.block, K.field]) assert.ok(contrast(foreground, background) >= 4.5, `${foreground} on ${background}`);
  assert.ok(contrast(K.onDanger, K.danger) >= 4.5);
  assert.ok(contrast(K.inkSecondary, K.dangerSurface) >= 4.5);
  assert.ok(contrast(K.dangerText, K.diffRemoved) >= 4.5);
  assert.ok(contrast(K.okText, K.diffAdded) >= 4.5);
});
