// The editor's text codecs (#86, especificación §4), shared by the app and the Puente. Pure and
// without platform APIs: TextDecoder('latin1') is Windows-1252 and TextEncoder writes U+FFFD for a
// lone surrogate, so neither is used. Decoding is strict and encoding never substitutes: what is
// decoded and not changed encodes back to the same bytes.

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'iso-8859-1' | 'windows-1252';
export const TEXT_ENCODINGS: readonly TextEncodingName[] = ['utf-8', 'utf-16le', 'utf-16be', 'iso-8859-1', 'windows-1252'];

/** How a file's text is stored. Only the Unicode encodings have a BOM. */
export interface TextFormat { encoding: TextEncodingName; bom: boolean }

/** Formats that decode the bytes, most likely first. Empty: binary. `certain` only with a BOM or plain ASCII. */
export interface TextDetection { candidates: TextFormat[]; certain: boolean }

/** The UTF-16 index of the first character the encoding cannot hold. */
export interface Unrepresentable { unrepresentable: number }

// Windows-1252 0x80–0x9F; 0 marks its five undefined bytes.
const CP1252 = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
];
const CP1252_BYTES = new Map(CP1252.flatMap((code, index) => code ? [[code, 0x80 + index] as const] : []));

const BOMS: Partial<Record<TextEncodingName, readonly number[]>> = { 'utf-8': [0xef, 0xbb, 0xbf], 'utf-16le': [0xff, 0xfe], 'utf-16be': [0xfe, 0xff] };

export function validTextFormat(value: unknown): value is TextFormat {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const { encoding, bom } = value as Record<string, unknown>;
  return Object.keys(value).length === 2 && TEXT_ENCODINGS.includes(encoding as TextEncodingName) && typeof bom === 'boolean'
    && (!bom || Object.hasOwn(BOMS, encoding as string));
}

/** Code units into a string in slices, so a 5 MiB file never hits the argument limit. */
class Units {
  private parts: string[] = [];
  private units: number[] = [];
  push(unit: number): void {
    this.units.push(unit);
    if (this.units.length === 8192) { this.parts.push(String.fromCharCode(...this.units)); this.units = []; }
  }
  done(): string { return this.parts.join('') + String.fromCharCode(...this.units); }
}

function decodeUtf8(bytes: Uint8Array, start: number): string | null {
  const out = new Units();
  for (let index = start; index < bytes.length;) {
    const lead = bytes[index]!;
    if (lead < 0x80) { out.push(lead); index++; continue; }
    // WHATWG ranges: no overlong forms, no surrogates, nothing above U+10FFFF.
    const [length, low, high] = lead >= 0xc2 && lead <= 0xdf ? [2, 0x80, 0xbf]
      : lead === 0xe0 ? [3, 0xa0, 0xbf] : lead === 0xed ? [3, 0x80, 0x9f] : lead >= 0xe1 && lead <= 0xef ? [3, 0x80, 0xbf]
      : lead === 0xf0 ? [4, 0x90, 0xbf] : lead === 0xf4 ? [4, 0x80, 0x8f] : lead >= 0xf1 && lead <= 0xf3 ? [4, 0x80, 0xbf] : [0, 0, 0];
    if (!length || index + length > bytes.length) return null;
    let code = lead & (0xff >> (length + 1));
    for (let next = 1; next < length; next++) {
      const byte = bytes[index + next]!;
      if (byte < (next === 1 ? low : 0x80) || byte > (next === 1 ? high : 0xbf)) return null;
      code = (code << 6) | (byte & 0x3f);
    }
    if (code > 0xffff) { out.push(0xd800 + ((code - 0x10000) >> 10)); out.push(0xdc00 + ((code - 0x10000) & 0x3ff)); } else out.push(code);
    index += length;
  }
  return out.done();
}

function decodeUtf16(bytes: Uint8Array, start: number, little: boolean): string | null {
  if ((bytes.length - start) % 2) return null;
  const out = new Units();
  let pending = false; // a high surrogate waiting for its pair
  for (let index = start; index < bytes.length; index += 2) {
    const unit = little ? bytes[index]! | (bytes[index + 1]! << 8) : (bytes[index]! << 8) | bytes[index + 1]!;
    const high = unit >= 0xd800 && unit <= 0xdbff;
    const low = unit >= 0xdc00 && unit <= 0xdfff;
    if (pending !== low) return null;
    pending = high;
    out.push(unit);
  }
  return pending ? null : out.done();
}

/** The text exactly as stored in that format, or null if the bytes are not that format. */
export function decodeText(bytes: Uint8Array, format: TextFormat): string | null {
  const bom = BOMS[format.encoding];
  if (format.bom && (!bom || bom.some((byte, index) => bytes[index] !== byte))) return null;
  const start = format.bom ? bom!.length : 0;
  switch (format.encoding) {
    case 'utf-8': return decodeUtf8(bytes, start);
    case 'utf-16le': return decodeUtf16(bytes, start, true);
    case 'utf-16be': return decodeUtf16(bytes, start, false);
    case 'iso-8859-1': { const out = new Units(); for (const byte of bytes) out.push(byte); return out.done(); }
    case 'windows-1252': {
      const out = new Units();
      for (const byte of bytes) {
        const code = byte >= 0x80 && byte <= 0x9f ? CP1252[byte - 0x80]! : byte;
        if (!code && byte) return null;
        out.push(code);
      }
      return out.done();
    }
  }
}

/** Bytes for the text in that format, or the first character it cannot hold. Never substitutes. */
export function encodeText(text: string, format: TextFormat): Uint8Array | Unrepresentable {
  const bom = format.bom ? BOMS[format.encoding] ?? [] : [];
  const out = new Uint8Array(bom.length + text.length * 3);
  out.set(bom);
  let length = bom.length;
  for (let index = 0; index < text.length; index++) {
    let code = text.charCodeAt(index);
    const first = index;
    if (format.encoding === 'iso-8859-1' || format.encoding === 'windows-1252') {
      const byte = code < 0x80 || (code >= 0xa0 && code <= 0xff) || (format.encoding === 'iso-8859-1' && code <= 0xff) ? code
        : format.encoding === 'windows-1252' ? CP1252_BYTES.get(code) : undefined;
      if (byte === undefined) return { unrepresentable: index };
      out[length++] = byte;
      continue;
    }
    // Unicode: a lone surrogate is not a character.
    if (code >= 0xdc00 && code <= 0xdfff) return { unrepresentable: index };
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return { unrepresentable: index };
      code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
      index++;
    }
    if (format.encoding === 'utf-8') {
      if (code < 0x80) out[length++] = code;
      else if (code < 0x800) { out[length++] = 0xc0 | (code >> 6); out[length++] = 0x80 | (code & 0x3f); }
      else if (code < 0x10000) { out[length++] = 0xe0 | (code >> 12); out[length++] = 0x80 | ((code >> 6) & 0x3f); out[length++] = 0x80 | (code & 0x3f); }
      else { out[length++] = 0xf0 | (code >> 18); out[length++] = 0x80 | ((code >> 12) & 0x3f); out[length++] = 0x80 | ((code >> 6) & 0x3f); out[length++] = 0x80 | (code & 0x3f); }
    } else {
      for (let unit = first; unit <= index; unit++) {
        const value = text.charCodeAt(unit);
        const [a, b] = format.encoding === 'utf-16le' ? [value & 0xff, value >> 8] : [value >> 8, value & 0xff];
        out[length++] = a; out[length++] = b;
      }
    }
  }
  return out.slice(0, length);
}

/** Heuristics are never certainty: the caller shows the guess and lets the person choose. */
export function detectText(bytes: Uint8Array): TextDetection {
  for (const encoding of ['utf-8', 'utf-16le', 'utf-16be'] as const) {
    if (decodeText(bytes, { encoding, bom: true }) !== null) return { candidates: [{ encoding, bom: true }], certain: true };
  }
  if (bytes.includes(0)) {
    // Zero bytes are not 8-bit text. ASCII in UTF-16 has them on one side of every unit.
    let odd = 0;
    for (let index = 1; index < bytes.length; index += 2) if (bytes[index] === 0) odd++;
    const order: TextEncodingName[] = odd * 2 >= bytes.filter((byte) => byte === 0).length ? ['utf-16le', 'utf-16be'] : ['utf-16be', 'utf-16le'];
    return { candidates: order.filter((encoding) => decodeText(bytes, { encoding, bom: false }) !== null).map((encoding) => ({ encoding, bom: false })), certain: false };
  }
  if (bytes.every((byte) => byte < 0x80)) return { candidates: [{ encoding: 'utf-8', bom: false }], certain: true };
  const candidates = (['utf-8', 'windows-1252', 'iso-8859-1'] as const).filter((encoding) => decodeText(bytes, { encoding, bom: false }) !== null);
  return { candidates: candidates.map((encoding) => ({ encoding, bom: false })), certain: false };
}
