import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewWithoutNotes, splitFileNotes, withFileNotes } from '../../protocol/chatFiles.ts';

test('file notes go first, one line each, then a blank line, and parse back', () => {
  const input = withFileNotes('Resume esto', ['/home/user/notas.txt', '/srv/a b.md']);
  assert.equal(input, '[The user attached a file that is on this machine: /home/user/notas.txt. Its content is not included; read it from that path yourself when the request involves it.]\n'
    + '[The user attached a file that is on this machine: /srv/a b.md. Its content is not included; read it from that path yourself when the request involves it.]\n\nResume esto');
  assert.deepEqual(splitFileNotes(input), { paths: ['/home/user/notas.txt', '/srv/a b.md'], text: 'Resume esto' });
  assert.equal(withFileNotes('Solo texto', []), 'Solo texto');
  assert.deepEqual(splitFileNotes(withFileNotes('', ['/a'])), { paths: ['/a'], text: '' });
});

test('a path may contain ] and the note sentence itself', () => {
  const odd = '/tmp/x]. Its content is not included; y/z]';
  assert.deepEqual(splitFileNotes(withFileNotes('hola', [odd])), { paths: [odd], text: 'hola' });
});

test('only a leading run of exact notes followed by a blank line or the end is parsed', () => {
  const note = withFileNotes('', ['/a']).trimEnd();
  assert.deepEqual(splitFileNotes(note), { paths: ['/a'], text: '' }, 'a note alone');
  assert.deepEqual(splitFileNotes(`${note}\ntexto`), { paths: [], text: `${note}\ntexto` }, 'no blank line');
  assert.deepEqual(splitFileNotes(`hola\n\n${note}`), { paths: [], text: `hola\n\n${note}` }, 'not leading');
  assert.deepEqual(splitFileNotes('[The user attached a file that is on this machine: relative. Its content is not included; read it from that path yourself when the request involves it.]'), { paths: [], text: '[The user attached a file that is on this machine: relative. Its content is not included; read it from that path yourself when the request involves it.]' }, 'not absolute');
  assert.deepEqual(splitFileNotes('[The user attached something]\n\nx'), { paths: [], text: '[The user attached something]\n\nx' });
  assert.deepEqual(splitFileNotes(''), { paths: [], text: '' });
});

test('a preview shows the text without notes, or the file names when there is no text', () => {
  assert.equal(previewWithoutNotes(withFileNotes('  Resume esto ', ['/home/user/notas.txt'])), 'Resume esto');
  assert.equal(previewWithoutNotes(withFileNotes('', ['/home/user/notas.txt', '/srv/b.md'])), 'notas.txt, b.md');
  assert.equal(previewWithoutNotes('Hola'), 'Hola');
});
