import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';

import { encodeQr, renderQrToTerminal } from '../src/qr.ts';

interface Fixture {
  name: string;
  text: string;
  utf8Bytes: number;
  version: number;
  rows: string[];
}

const fixtures: Fixture[] = JSON.parse(
  readFileSync(new URL('./fixtures/qr/matrices.json', import.meta.url), 'utf8'),
);

// QR Model 2 format words for ECC M, masks 0–7, including BCH and XOR 0x5412.
const mediumFormatWords = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];

function formatPositions(size: number): [number, number][][] {
  return [
    [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]],
    Array.from({ length: 15 }, (_, bit) => bit < 8
      ? [size - 1 - bit, 8] : [8, size - 15 + bit]),
  ];
}

function mediumMask(matrix: boolean[][]): number {
  const words = formatPositions(matrix.length).map(positions =>
    positions.reduce((word, [x, y], bit) => word | (Number(matrix[y][x]) << bit), 0));
  assert.equal(words[0], words[1], 'both copies of the format information agree');
  const mask = mediumFormatWords.indexOf(words[0]);
  assert.ok(mask >= 0, 'format information declares ECC M with a valid mask');
  return mask;
}

function maskAt(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return (x * y) % 2 + (x * y) % 3 === 0;
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
    case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    default: throw new Error('Invalid test mask');
  }
}

// libqrencode and Nayuki may select different masks. Compare every module after
// removing each declared mask and blanking only the mask-dependent format words.
// Function regions here come from the QR layout, not the encoder under test.
function canonicalMatrix(matrix: boolean[][]): boolean[][] {
  const size = matrix.length;
  const version = (size - 17) / 4;
  const centers = version === 1 ? [] : version === 2 ? [6, 18] : [6, 24, 42];
  assert.ok([1, 2, 8].includes(version), 'fixture version has a documented layout');
  const format = new Set(formatPositions(size).flat().map(([x, y]) => `${x},${y}`));
  const mask = mediumMask(matrix);
  return matrix.map((row, y) => row.map((dark, x) => {
    if (format.has(`${x},${y}`)) return false;
    const finder = (x <= 8 && y <= 8) || (x >= size - 8 && y <= 8)
      || (x <= 8 && y >= size - 8);
    const alignment = centers.some(cx => centers.some(cy =>
      !((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7)
        || (cx === size - 7 && cy === 6))
      && Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2));
    const versionInfo = version >= 7 && ((x >= size - 11 && x <= size - 9 && y <= 5)
      || (y >= size - 11 && y <= size - 9 && x <= 5));
    const functionModule = finder || x === 6 || y === 6 || alignment || versionInfo;
    return functionModule ? dark : dark !== maskAt(mask, x, y);
  }));
}

function terminalModules(output: string): boolean[][] {
  assert.ok(output.endsWith('\n'), 'last line ends with a newline');
  const rows: boolean[][] = [];
  for (const line of output.slice(0, -1).split('\n')) {
    assert.ok(line.startsWith('\x1b[30;47m'), 'explicit black foreground and white background');
    assert.ok(line.endsWith('\x1b[0m'), 'every line resets ANSI colors');
    const characters = [...line.slice('\x1b[30;47m'.length, -'\x1b[0m'.length)];
    const upper: boolean[] = [];
    const lower: boolean[] = [];
    for (const character of characters) {
      assert.ok(' ▀▄█'.includes(character), 'one cell represents exactly two modules');
      upper.push(character === '▀' || character === '█');
      lower.push(character === '▄' || character === '█');
    }
    rows.push(upper, lower);
  }
  return rows;
}

for (const fixture of fixtures) {
  test(`encodeQr matches independent byte/M matrix: ${fixture.name}`, () => {
    assert.equal(Buffer.byteLength(fixture.text), fixture.utf8Bytes);
    const expected = fixture.rows.map(row => [...row].map(module => module === '1'));
    const actual = encodeQr(fixture.text);
    assert.equal(actual.length, fixture.version * 4 + 17);
    assert.ok(actual.every(row => row.length === actual.length
      && row.every(module => typeof module === 'boolean')));
    assert.deepEqual(canonicalMatrix(actual), canonicalMatrix(expected));
  });

  test(`terminal quiet zone, polarity and final white padding: ${fixture.name}`, () => {
    const matrix = encodeQr(fixture.text);
    const width = matrix.length + 8;
    const output = renderQrToTerminal(fixture.text, width);
    assert.notEqual(output, null);
    const reconstructed = terminalModules(output!);
    assert.equal(reconstructed.length, width + 1, 'odd height adds exactly one white row');
    assert.ok(reconstructed.every(row => row.length === width), 'each line fits without wrapping');
    const expected = Array.from({ length: width + 1 }, (_, y) =>
      Array.from({ length: width }, (_, x) =>
        x >= 4 && x < width - 4 && y >= 4 && y < width - 4
          ? matrix[y - 4][x - 4] : false));
    assert.deepEqual(reconstructed, expected, 'exactly four white modules on every side plus padding');
    assert.deepEqual(reconstructed.slice(4, -5).map(row => row.slice(4, -4)), matrix);
    assert.ok(reconstructed.at(-1)!.every(module => !module), 'last padded row is entirely white');
  });

  test(`terminal refuses insufficient columns: ${fixture.name}`, () => {
    const width = fixture.version * 4 + 17 + 8;
    for (const columns of [0, width - 1]) {
      assert.equal(renderQrToTerminal(fixture.text, columns), null);
    }
    assert.notEqual(renderQrToTerminal(fixture.text, width), null);
    assert.equal(renderQrToTerminal(fixture.text, width + 1), renderQrToTerminal(fixture.text, width));
  });
}

test('encodeQr uses smallest M version by UTF-8 byte capacity, without ECC boost', () => {
  // M has 16/28/124/154 data codewords in versions 1/2/7/8. Versions 1–9
  // need 4 mode bits + 8 count bits; floor((8 * codewords - 12) / 8).
  for (const [text, version] of [
    ['', 1], ['a'.repeat(14), 1], ['a'.repeat(15), 2],
    ['é'.repeat(7), 1], ['é'.repeat(8), 2],
    ['a'.repeat(122), 7], ['a'.repeat(123), 8],
  ] as const) {
    const matrix = encodeQr(text);
    assert.equal(matrix.length, version * 4 + 17);
    mediumMask(matrix);
  }
});

test('encodeQr selects masks automatically for different payloads', () => {
  const masks = new Set(fixtures.map(fixture => mediumMask(encodeQr(fixture.text))));
  assert.ok(masks.size > 1, 'different payloads do not use a single fixed mask');
});

test('encodeQr accepts the M version 40 limit and rejects overflow with a static plain Error', () => {
  // Version 40 M: 2334 data codewords, 4 mode + 16 count bits => 2331 bytes.
  const matrix = encodeQr('a'.repeat(2331));
  assert.equal(matrix.length, 177);
  mediumMask(matrix);
  for (const text of ['a'.repeat(2332), 'é'.repeat(1166), 'SYNTHETIC-OVERFLOW'.repeat(300)]) {
    assert.throws(() => encodeQr(text), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.constructor, Error);
      assert.equal(error.message, 'Text does not fit in a QR code');
      return true;
    });
  }
});

function pngFromModules(rows: boolean[][]): Buffer {
  const scale = 8;
  const width = rows[0].length * scale;
  const height = rows.length * scale;
  const scanlines = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      scanlines[y * (width + 1) + x + 1] = rows[Math.floor(y / scale)][Math.floor(x / scale)] ? 0 : 255;
    }
  }
  function chunk(type: string, data: Buffer): Buffer {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8-bit grayscale, no interlacing.
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}

const decoderAvailable = spawnSync('zbarimg', ['--version']).status === 0;
test('independent zbarimg decodes all terminal-rendered QR fixtures', {
  skip: decoderAvailable ? false : 'zbarimg is an optional development reference, not a runtime dependency',
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-qr-decode-'));
  try {
    for (const fixture of fixtures) {
      const path = join(directory, `${fixture.name}.png`);
      const output = renderQrToTerminal(fixture.text, 1000)!;
      writeFileSync(path, pngFromModules(terminalModules(output)));
      const decoded = spawnSync('zbarimg', ['--quiet', '--raw', '-Sdisable', '-Sqrcode.enable', path], {
        encoding: 'utf8',
      });
      assert.equal(decoded.status, 0, decoded.stderr);
      assert.equal(decoded.stdout, fixture.text + '\n', fixture.name);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
