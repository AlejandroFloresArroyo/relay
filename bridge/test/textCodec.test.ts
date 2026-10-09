// The editor's text codecs (protocol/textCodec.ts): the app decodes and encodes with them and the
// Puente checks a save against them. What is read and not changed goes back byte for byte.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeText, detectText, encodeText, TEXT_ENCODINGS, validTextFormat, type TextDetection, type TextFormat } from '../../protocol/textCodec.ts';

const bytes = (...values: number[]) => Uint8Array.from(values);
const encoded = (text: string, format: TextFormat): Uint8Array => {
  const result = encodeText(text, format);
  assert.ok(result instanceof Uint8Array, `${text} encodes as ${format.encoding}`);
  return result;
};

// Mixed line endings on purpose: LF, CRLF and a lone CR.
const MIXED = 'uno\r\ndos\ntres\rcuatro\r\n';
const SAMPLES: [TextFormat, string][] = [
  [{ encoding: 'utf-8', bom: false }, `Mañana: café — 1€ 🎉\n${MIXED}`],
  [{ encoding: 'utf-8', bom: true }, `con BOM ñ\n${MIXED}`],
  [{ encoding: 'utf-16le', bom: true }, `UTF-16 LE 🎉 ñ ${MIXED}`],
  [{ encoding: 'utf-16le', bom: false }, `sin BOM ñ ${MIXED}`],
  [{ encoding: 'utf-16be', bom: true }, `UTF-16 BE 🎉 ñ ${MIXED}`],
  [{ encoding: 'utf-16be', bom: false }, `sin BOM ñ ${MIXED}`],
  [{ encoding: 'iso-8859-1', bom: false }, `año ÿ \u0080\u009f control C1 ${MIXED}`],
  [{ encoding: 'windows-1252', bom: false }, `1€ “comillas” — Ÿ œ ${MIXED}`],
];

test('every encoding goes text → bytes → text and bytes → text → bytes unchanged, BOM and mixed line endings included', () => {
  for (const [format, text] of SAMPLES) {
    const label = `${format.encoding} bom=${format.bom}`;
    const first = encoded(text, format);
    assert.equal(decodeText(first, format), text, label);
    assert.deepEqual(encoded(decodeText(first, format)!, format), first, label);
  }
  // The exact bytes of what the editor writes, against the standard ones.
  assert.deepEqual(encoded('a\r\nñ', { encoding: 'utf-8', bom: true }), bytes(0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0xc3, 0xb1));
  assert.deepEqual(encoded('a🎉', { encoding: 'utf-16le', bom: true }), bytes(0xff, 0xfe, 0x61, 0x00, 0x3c, 0xd8, 0x89, 0xdf));
  assert.deepEqual(encoded('a🎉', { encoding: 'utf-16be', bom: true }), bytes(0xfe, 0xff, 0x00, 0x61, 0xd8, 0x3c, 0xdf, 0x89));
  assert.deepEqual(encoded('€\u00ff', { encoding: 'windows-1252', bom: false }), bytes(0x80, 0xff));
  assert.deepEqual(encoded('\u0080\u00ff', { encoding: 'iso-8859-1', bom: false }), bytes(0x80, 0xff));
});

test('ISO-8859-1 is real Latin-1, not the Windows-1252 that TextDecoder calls latin1', () => {
  const all = Uint8Array.from({ length: 256 }, (_, index) => index);
  const latin1 = decodeText(all, { encoding: 'iso-8859-1', bom: false })!;
  assert.deepEqual([...latin1].map((character) => character.charCodeAt(0)), [...all]);
  assert.deepEqual(encoded(latin1, { encoding: 'iso-8859-1', bom: false }), all);
  // The WHATWG label maps 0x80 to €: using it would change every C1 byte of a Latin-1 file.
  assert.equal(new TextDecoder('latin1').decode(bytes(0x80)), '€');
  assert.equal(decodeText(bytes(0x80), { encoding: 'iso-8859-1', bom: false }), '\u0080');
  assert.deepEqual(encodeText('€', { encoding: 'iso-8859-1', bom: false }), { unrepresentable: 0 });
});

test('Windows-1252 maps 0x80–0x9F to its own characters and refuses its five undefined bytes', () => {
  const format: TextFormat = { encoding: 'windows-1252', bom: false };
  assert.equal(decodeText(bytes(0x80, 0x8a, 0x93, 0x94, 0x9f), format), '€Š“”Ÿ');
  for (const undefinedByte of [0x81, 0x8d, 0x8f, 0x90, 0x9d]) assert.equal(decodeText(bytes(0x41, undefinedByte), format), null, `0x${undefinedByte.toString(16)}`);
  const defined = Uint8Array.from({ length: 256 }, (_, index) => index).filter((value) => ![0x81, 0x8d, 0x8f, 0x90, 0x9d].includes(value));
  assert.deepEqual(encoded(decodeText(defined, format)!, format), defined);
  // A C1 control is not a Windows-1252 character, so it never becomes one of its bytes.
  assert.deepEqual(encodeText('ok\u0081', format), { unrepresentable: 2 });
});

test('a character the encoding cannot hold blocks the encoding at its position: never "?", U+FFFD or UTF-8', () => {
  assert.deepEqual(encodeText('ab🎉', { encoding: 'windows-1252', bom: false }), { unrepresentable: 2 });
  assert.deepEqual(encodeText('ñ€', { encoding: 'iso-8859-1', bom: false }), { unrepresentable: 1 });
  // A lone surrogate is not text: TextEncoder would write U+FFFD in its place.
  for (const encoding of ['utf-8', 'utf-16le', 'utf-16be'] as const) {
    assert.deepEqual(encodeText('a\ud83c', { encoding, bom: false }), { unrepresentable: 1 }, encoding);
    assert.deepEqual(encodeText('a\udf89b', { encoding, bom: false }), { unrepresentable: 1 }, encoding);
  }
  assert.deepEqual(new TextEncoder().encode('\ud83c'), bytes(0xef, 0xbf, 0xbd));
});

test('UTF-8 is strict: exactly what a fatal decoder accepts, with the same text', () => {
  const format: TextFormat = { encoding: 'utf-8', bom: false };
  for (const invalid of [[0xc0, 0x80], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82], [0x80], [0xf8, 0x88, 0x80, 0x80, 0x80], [0xc3]]) {
    assert.equal(decodeText(Uint8Array.from(invalid), format), null, JSON.stringify(invalid));
  }
  const fatal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let seed = 86;
  const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) % 256;
  for (let round = 0; round < 3000; round++) {
    // Biased to multi-byte lead and continuation bytes so the edge cases come up.
    const sample = Uint8Array.from({ length: 1 + (round % 9) }, () => { const value = random(); return value < 96 ? 0x80 | (value & 0x3f) : value < 160 ? 0xc0 | (value & 0x3f) : value; });
    let expected: string | null;
    try { expected = fatal.decode(sample); } catch { expected = null; }
    assert.equal(decodeText(sample, format), expected, JSON.stringify([...sample]));
  }
});

test('UTF-16 needs whole code units, paired surrogates and the BOM it says it has', () => {
  assert.equal(decodeText(bytes(0x61, 0x00, 0x62), { encoding: 'utf-16le', bom: false }), null);
  assert.equal(decodeText(bytes(0x3c, 0xd8, 0x61, 0x00), { encoding: 'utf-16le', bom: false }), null);
  assert.equal(decodeText(bytes(0x61, 0x00), { encoding: 'utf-16le', bom: true }), null);
  assert.equal(decodeText(bytes(0xff, 0xfe, 0x61, 0x00), { encoding: 'utf-16be', bom: true }), null);
  assert.equal(decodeText(bytes(0x61), { encoding: 'utf-8', bom: true }), null);
  // Without the flag, the BOM bytes are just a U+FEFF at the start and still come back.
  const withBom = bytes(0xef, 0xbb, 0xbf, 0x61);
  assert.equal(decodeText(withBom, { encoding: 'utf-8', bom: false }), '\ufeffa');
  assert.deepEqual(encoded('\ufeffa', { encoding: 'utf-8', bom: false }), withBom);
  assert.equal(decodeText(bytes(), { encoding: 'utf-16be', bom: false }), '');
});

test('detection is certain only with a BOM or plain ASCII; otherwise it ranks what decodes and says it is a guess', () => {
  const formats = (detected: TextDetection) => detected.candidates.map((format) => `${format.encoding}${format.bom ? '+bom' : ''}`);
  const utf8 = encoded('café', { encoding: 'utf-8', bom: false });
  assert.deepEqual(detectText(encoded('café', { encoding: 'utf-8', bom: true })), { candidates: [{ encoding: 'utf-8', bom: true }], certain: true });
  assert.deepEqual(detectText(encoded('café', { encoding: 'utf-16le', bom: true })), { candidates: [{ encoding: 'utf-16le', bom: true }], certain: true });
  assert.deepEqual(detectText(encoded('café', { encoding: 'utf-16be', bom: true })), { candidates: [{ encoding: 'utf-16be', bom: true }], certain: true });
  assert.deepEqual(detectText(encoded('plain\r\nascii', { encoding: 'utf-8', bom: false })), { candidates: [{ encoding: 'utf-8', bom: false }], certain: true });
  assert.deepEqual(detectText(bytes()), { candidates: [{ encoding: 'utf-8', bom: false }], certain: true });
  assert.deepEqual([formats(detectText(utf8)), detectText(utf8).certain], [['utf-8', 'windows-1252', 'iso-8859-1'], false]);
  const cp1252 = encoded('café “x”', { encoding: 'windows-1252', bom: false });
  assert.deepEqual([formats(detectText(cp1252)), detectText(cp1252).certain], [['windows-1252', 'iso-8859-1'], false]);
  assert.deepEqual(formats(detectText(bytes(0x61, 0x81))), ['iso-8859-1']);
  // UTF-16 without BOM shows up through its zero bytes; zeros anywhere else mean binary.
  assert.deepEqual([formats(detectText(encoded('hola', { encoding: 'utf-16le', bom: false }))), detectText(encoded('hola', { encoding: 'utf-16le', bom: false })).certain], [['utf-16le', 'utf-16be'], false]);
  assert.deepEqual(formats(detectText(encoded('hola', { encoding: 'utf-16be', bom: false }))), ['utf-16be', 'utf-16le']);
  assert.deepEqual(detectText(bytes(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00)), { candidates: [], certain: false });
  assert.deepEqual(detectText(bytes(0x00, 0xd8, 0x00)), { candidates: [], certain: false });
  for (const detected of [utf8, cp1252]) for (const format of detectText(detected).candidates) assert.notEqual(decodeText(detected, format), null);
});

test('a format from the wire is one of the five encodings, and only Unicode ones carry a BOM', () => {
  assert.deepEqual(TEXT_ENCODINGS, ['utf-8', 'utf-16le', 'utf-16be', 'iso-8859-1', 'windows-1252']);
  for (const [format] of SAMPLES) assert.equal(validTextFormat(format), true);
  for (const bad of [null, {}, { encoding: 'latin1', bom: false }, { encoding: 'utf-8' }, { encoding: 'utf-8', bom: 'yes' }, { encoding: 'iso-8859-1', bom: true }, { encoding: 'utf-8', bom: false, extra: 1 }]) {
    assert.equal(validTextFormat(bad), false, JSON.stringify(bad));
  }
});
