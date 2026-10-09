import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localFileName, fileSize, fileBadge } from './files.ts';
test('local artifact filenames cannot escape a scoped private directory', () => {
  for (const name of ['../private', '/tmp/file.pdf', '..\\private', '\u0000bad', '...']) {
    const local = localFileName(name); assert.doesNotMatch(local, /[\\/\x00-\x1f\x7f]/); assert.ok(!local.startsWith('.')); assert.ok(local.length > 0);
  }
  assert.equal(localFileName('informe.md'), 'informe.md'); assert.equal(fileSize(null), 'TAMAÑO DESCONOCIDO'); assert.equal(fileSize(1024), '1 KB'); assert.equal(fileBadge('test.zip'), 'ZIP');
});
