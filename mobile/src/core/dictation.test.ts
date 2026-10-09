import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendDictation, hasDictationModel, updateDictationText } from './dictation.ts';

test('only the installed exact Spanish locale enables local dictation', () => {
  assert.equal(hasDictationModel(['en-US', 'es-ES', 'es']), false);
  assert.equal(hasDictationModel(['es_US']), true);
  assert.equal(hasDictationModel(['ES-us']), true);
  assert.equal(hasDictationModel([]), false);
});
test('partials replace the current phrase while final segments join pauses', () => {
  let text = { phrases: [] as string[], partial: '' };
  text = updateDictationText(text, 'Revisa', false);
  text = updateDictationText(text, 'Revisa los pagos', false);
  assert.equal(appendDictation('', text), 'Revisa los pagos');
  text = updateDictationText(text, 'Revisa los pagos.', true);
  text = updateDictationText(text, 'Y dime', false);
  text = updateDictationText(text, 'Y dime si falla.', true);
  text = updateDictationText(text, 'También la última palabra', false);
  assert.equal(appendDictation('Antes', text), 'Antes Revisa los pagos. Y dime si falla. También la última palabra');
});
test('empty results preserve the last partial and existing draft', () => {
  const text = updateDictationText({ phrases: [], partial: 'última palabra' }, ' ', false);
  assert.equal(appendDictation('Borrador ', text), 'Borrador última palabra');
  assert.equal(appendDictation('Sin cambios ', { phrases: [], partial: '' }), 'Sin cambios ');
});
