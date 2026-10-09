import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ago, countdown, plainPreview, hostOf, maskKey, nextRun, relTime, toolLabel, uptime, nearEnd } from './format.ts';

const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

test('relTime follows the agent-row labels of the design', () => {
  const now = at(2026, 10, 2, 14, 30);
  assert.equal(relTime(now - 20_000, now), 'ahora');
  assert.equal(relTime(at(2026, 10, 2, 14, 2), now), '14:02');
  assert.equal(relTime(at(2026, 10, 1, 23, 59), now), 'ayer');
  assert.equal(relTime(at(2026, 9, 28, 9, 0), now), '28/09');
});

test('uptime shows days only past 24h and 00:00 when stopped', () => {
  assert.equal(uptime(6 * 86400 + 4 * 3600 + 12 * 60), '6D 04:12');
  assert.equal(uptime(4 * 3600 + 12 * 60 + 59), '04:12');
  assert.equal(uptime(null), '00:00');
  assert.equal(uptime(0), '00:00');
});

test('countdown is M:SS and never negative', () => {
  assert.equal(countdown(272_000), '4:32');
  assert.equal(countdown(9_100), '0:10');
  assert.equal(countdown(-5_000), '0:00');
});

test('nextRun matches the scheduled-task labels', () => {
  const now = at(2026, 10, 2, 9, 41); // a Friday
  assert.equal(nextRun(at(2026, 10, 3, 9, 0), true, now), 'MAÑ 09:00');
  assert.equal(nextRun(at(2026, 10, 5, 10, 0), true, now), 'LUN 10:00');
  assert.equal(nextRun(at(2026, 10, 2, 18, 0), true, now), 'HOY 18:00');
  assert.equal(nextRun(at(2026, 10, 3, 3, 0), false, now), 'PAUSADA');
  assert.equal(nextRun(null, true, now), 'PAUSADA');
  assert.equal(nextRun(at(2026, 10, 20, 8, 5), true, now), '20/10 08:05');
});

test('maskKey keeps only the last four characters', () => {
  assert.equal(maskKey('abcdef0123456789aaaa3f9a'), '••••••••••••••3f9a');
  assert.equal(maskKey(''), '');
});

test('toolLabel maps Hermes tools to the four verbs and abbreviates the rest', () => {
  assert.equal(toolLabel('read_file'), 'LEER');
  assert.equal(toolLabel('terminal'), 'EJEC');
  assert.equal(toolLabel('web_search'), 'WEB');
  assert.equal(toolLabel('patch'), 'EDIT');
  assert.equal(toolLabel('delegate_task'), 'DELE');
});

test('hostOf strips scheme and trailing slash', () => {
  assert.equal(hostOf('https://atlas.tailnet-7f2c.ts.net/'), 'atlas.tailnet-7f2c.ts.net');
  assert.equal(hostOf('http://arch:8650'), 'arch:8650');
});

test('ago words the time since last contact', () => {
  const now = at(2026, 10, 2, 9, 41);
  assert.equal(ago(now - 9 * 3_600_000, now), 'hace 9 h');
  assert.equal(ago(now - 5 * 60_000, now), 'hace 5 min');
  assert.equal(ago(now - 3 * 86_400_000, now), 'hace 3 d');
});

test('plainPreview flattens markdown and newlines for one-line previews', () => {
  assert.equal(plainPreview('Listo: **SOUL.md** en `default`\n\n- hecho'), 'Listo: SOUL.md en default - hecho');
  assert.equal(plainPreview('## Título\ntexto'), 'Título texto');
});

test('nearEnd says whether a list is close enough to its end to keep following it', () => {
  // viewport 600 tall, content 2000: the end is at offset 1400
  assert.equal(nearEnd({ offset: 1400, viewport: 600, content: 2000 }), true);
  assert.equal(nearEnd({ offset: 1330, viewport: 600, content: 2000 }), true);
  assert.equal(nearEnd({ offset: 900, viewport: 600, content: 2000 }), false);
  // content shorter than the viewport is always "at the end"
  assert.equal(nearEnd({ offset: 0, viewport: 600, content: 300 }), true);
});
