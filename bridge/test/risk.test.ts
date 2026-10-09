import assert from 'node:assert/strict';
import { test } from 'node:test';

import { riskFor } from '../src/risk.ts';

test('a recursive delete is medium risk, with the Hermes description as summary', () => {
  assert.deepEqual(riskFor('recursive delete', 'recursive delete'), {
    level: 3,
    label: 'RIESGO MEDIO',
    summary: 'recursive delete',
  });
});

test('every variant of a pattern family maps to the same level', () => {
  assert.equal(riskFor('recursive delete (long flag)', 'x')?.level, 3);
  assert.equal(riskFor('recursive delete (flags after operands)', 'x')?.level, 3);
  assert.equal(riskFor('force kill processes (killall -KILL)', 'x')?.level, 3);
});

test('destroying a disk or the root path is critical', () => {
  for (const key of ['delete in root path', 'format filesystem', 'write to block device', 'fork bomb']) {
    const risk = riskFor(key, key);
    assert.equal(risk?.level, 5, key);
    assert.equal(risk?.label, 'RIESGO CRÍTICO', key);
  }
});

test('remote code execution and SQL data loss are high risk', () => {
  for (const key of ['pipe remote content to shell', 'SQL DROP', 'SQL DELETE without WHERE', 'overwrite system config']) {
    assert.equal(riskFor(key, key)?.level, 4, key);
    assert.equal(riskFor(key, key)?.label, 'RIESGO ALTO', key);
  }
});

test('delete in root path wins over the generic recursive delete rule', () => {
  assert.equal(riskFor('delete in root path', 'x')?.level, 5);
});

test('an unknown or missing pattern has no risk: the bridge does not invent one', () => {
  assert.equal(riskFor('some brand new hermes pattern', 'whatever'), null);
  assert.equal(riskFor(null, 'whatever'), null);
  assert.equal(riskFor('', ''), null);
});

test('the summary falls back to the pattern when Hermes sends no description', () => {
  assert.equal(riskFor('SQL TRUNCATE', null)?.summary, 'SQL TRUNCATE');
});
