import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REMOTE_LIMITS } from '../../../protocol/protocol.ts';
import { encodeText, type TextFormat } from '../../../protocol/textCodec.ts';
import { editorPieces, editorText, openText, prepareSave, storedText, type TextDocument } from './textDocument.ts';

const UTF8: TextFormat = { encoding: 'utf-8', bom: false };
const LATIN1: TextFormat = { encoding: 'iso-8859-1', bom: false };
const bytesOf = (text: string, format: TextFormat) => encodeText(text, format) as Uint8Array;

function opened(bytes: Uint8Array, chosen?: TextFormat): TextDocument {
  const result = openText(bytes, chosen);
  assert.equal(result.kind, 'opened');
  return result.document;
}

test('an unchanged document saves exactly the bytes it was opened from', () => {
  // A UTF-16 file with BOM and mixed line endings, and a Latin-1 one with C1 bytes.
  for (const [text, format] of [['a\r\nb\nc\rd🎉', { encoding: 'utf-16le', bom: true }], ['año\u0085\r\nfin\n', LATIN1]] as const) {
    const bytes = bytesOf(text, format);
    const document = opened(bytes, format);
    assert.equal(document.text, text);
    const save = prepareSave(document, document.text);
    assert.equal(save.kind, 'ready');
    assert.deepEqual([save.bytes, save.format], [bytes, format]);
  }
});

test('an edit keeps the encoding, the BOM and every original line ending', () => {
  const format: TextFormat = { encoding: 'utf-8', bom: true };
  const document = opened(bytesOf('uno\r\ndos\ntres\r', format));
  const save = prepareSave(document, `${document.text}cuatro ñ\r\n`);
  assert.equal(save.kind, 'ready');
  assert.deepEqual([Buffer.from(save.bytes).toString('hex'), save.format], [Buffer.from('\ufeffuno\r\ndos\ntres\rcuatro ñ\r\n').toString('hex'), format]);
});

test('a character the encoding cannot hold blocks the save; UTF-8 only with explicit intent', () => {
  const document = opened(bytesOf('precio: 5', LATIN1), LATIN1);
  const blocked = prepareSave(document, 'precio: 5€');
  assert.deepEqual(blocked, { kind: 'unrepresentable', index: 9, character: '€' });
  const emoji = prepareSave(document, 'ok 🎉 fin');
  assert.deepEqual(emoji, { kind: 'unrepresentable', index: 3, character: '🎉' });
  const converted = prepareSave(document, 'precio: 5€', { convertToUtf8: true });
  assert.equal(converted.kind, 'ready');
  assert.deepEqual([converted.bytes, converted.format], [bytesOf('precio: 5€', UTF8), UTF8]);
  // A lone surrogate is not text in any encoding, UTF-8 included.
  assert.deepEqual(prepareSave(document, 'x\ud800', { convertToUtf8: true }), { kind: 'unrepresentable', index: 1, character: '\ud800' });
});

test('5 MiB is measured on the encoded bytes, opening and saving', () => {
  const limit = REMOTE_LIMITS.editableTextBytes;
  assert.equal(openText(new Uint8Array(limit + 1).fill(0x61)).kind, 'too_large');
  const document = opened(new Uint8Array(limit).fill(0x61));
  assert.equal(prepareSave(document, document.text).kind, 'ready');
  // One more character is fine as text but not as bytes; in UTF-16 the same text is twice the bytes.
  assert.deepEqual(prepareSave(document, `${document.text}a`), { kind: 'too_large' });
  const utf16 = opened(bytesOf('a'.repeat(limit / 2 - 1), { encoding: 'utf-16le', bom: true }));
  assert.equal(prepareSave(utf16, `${utf16.text}a`).kind, 'too_large');
});

test('a guess is never presented as certain: the alternatives that read differently come with a preview', () => {
  const utf8 = openText(bytesOf('café\n'.repeat(200), UTF8));
  assert.equal(utf8.kind, 'opened');
  assert.deepEqual([utf8.document.format, utf8.certain], [UTF8, false]);
  assert.deepEqual(utf8.alternatives.map((option) => option.format.encoding), ['windows-1252', 'iso-8859-1']);
  assert.equal(utf8.alternatives[0]!.preview, 'cafÃ©\n'.repeat(200).slice(0, 400));

  // Windows-1252 and Latin-1 read the same without bytes 0x80–0x9F: nothing to choose.
  const same = openText(bytesOf('año', LATIN1));
  assert.deepEqual(same.kind === 'opened' && [same.document.format.encoding, same.certain, same.alternatives], ['windows-1252', false, []]);
  const quotes = openText(Uint8Array.from([0x93, 0x61, 0x94]));
  assert.deepEqual(quotes.kind === 'opened' && [quotes.document.text, quotes.alternatives.map((option) => option.preview)], ['“a”', ['\u0093a\u0094']]);

  const bom = openText(bytesOf('café', { encoding: 'utf-16be', bom: true }));
  assert.deepEqual(bom.kind === 'opened' && [bom.certain, bom.alternatives], [true, []]);
  // Choosing another reading keeps the bytes and changes only how they are read.
  const chosen = opened(bytesOf('café', UTF8), LATIN1);
  assert.equal(chosen.text, 'cafÃ©');
  assert.deepEqual(prepareSave(chosen, chosen.text), { kind: 'ready', bytes: bytesOf('café', UTF8), format: LATIN1 });
});

test('binary content and a reading the bytes do not admit are refused, not opened', () => {
  assert.equal(openText(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x00])).kind, 'binary');
  assert.equal(openText(Uint8Array.from([0x61, 0x81]), { encoding: 'windows-1252', bom: false }).kind, 'not_this_format');
  assert.equal(openText(Uint8Array.from([0xc3]), UTF8).kind, 'not_this_format');
});

test('the editor shows uniform line endings as «\\n» and stores them back exactly; mixed ones are not editable', () => {
  for (const [text, endings] of [['a\r\nb\r\n', 'crlf'], ['a\rb', 'cr'], ['a\nb\n', 'lf'], ['ab', 'none']] as const) {
    const shown = editorText(text);
    assert.deepEqual(shown, { text: text.replace(/\r\n?/g, '\n'), endings });
    assert.equal(storedText(shown.text, endings), text, endings);
    const document = opened(bytesOf(text, UTF8));
    const save = prepareSave(document, storedText(shown.text, endings));
    assert.ok(save.kind === 'ready' && save.bytes === document.bytes, `${endings}: unchanged saves the original bytes`);
  }
  // A new line typed in a CRLF file is CRLF on disk.
  assert.equal(storedText('a\nnueva\nb\n', 'crlf'), 'a\r\nnueva\r\nb\r\n');
  for (const mixed of ['a\r\nb\nc', 'a\rb\nc', 'progreso\r50%\n']) assert.deepEqual(editorText(mixed), { text: mixed, endings: 'mixed' });
});

test('a long text is edited in pieces that join back to exactly the same text, never splitting a character', () => {
  const lines = Array.from({ length: 500 }, (_, index) => `línea ${index} 😀`).join('\n') + '\n';
  const long = '😀'.repeat(5000);
  for (const text of ['', 'corto', lines, long, `${long}\n${lines}`]) {
    const pieces = editorPieces(text, 1000);
    assert.equal(pieces.join(''), text);
    assert.ok(pieces.every((piece) => piece.length <= 1000 && !/[\ud800-\udbff]$/.test(piece)), 'within the size, no lone high surrogate at an end');
    assert.ok(text === '' ? pieces.length === 1 : pieces.every((piece) => piece !== ''));
  }
  // Pieces end at a line break whenever the line fits.
  assert.ok(editorPieces(lines, 1000).slice(0, -1).every((piece) => piece.endsWith('\n')));
});
