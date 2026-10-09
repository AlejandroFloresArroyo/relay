import { Ecc, QrCode, QrSegment } from './vendor/qrcodegen.ts';

const QUIET_ZONE = 4;
const BLACK_ON_WHITE = '\x1b[30;47m';
const RESET = '\x1b[0m';

/** Encode UTF-8 in one byte segment, at ECC M without boosting. No quiet zone. */
export function encodeQr(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  // Version 40 M holds 2334 data codewords minus its 20-bit segment header.
  if (bytes.length > 2331) throw new Error('Text does not fit in a QR code');
  const qr = QrCode.encodeSegments([QrSegment.makeBytes(Array.from(bytes))], Ecc.MEDIUM, 1, 40, -1, false);
  return Array.from({ length: qr.size }, (_, y) =>
    Array.from({ length: qr.size }, (_, x) => qr.getModule(x, y)));
}

/** Render two module rows per terminal line, including a four-module quiet zone. */
export function renderQrToTerminal(text: string, columns: number): string | null {
  const matrix = encodeQr(text);
  const width = matrix.length + 2 * QUIET_ZONE;
  if (width > columns) return null;

  const moduleAt = (x: number, y: number): boolean =>
    matrix[y - QUIET_ZONE]?.[x - QUIET_ZONE] ?? false;
  let output = '';
  for (let y = 0; y < width; y += 2) {
    output += BLACK_ON_WHITE;
    for (let x = 0; x < width; x++) {
      const upper = moduleAt(x, y);
      const lower = y + 1 < width && moduleAt(x, y + 1);
      output += upper ? (lower ? '█' : '▀') : (lower ? '▄' : ' ');
    }
    output += RESET + '\n';
  }
  return output;
}
