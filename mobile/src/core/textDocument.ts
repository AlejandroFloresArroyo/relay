// The editor's document (#86, especificación §4): how a file's bytes become editable text and go
// back. Nothing is normalized: the original encoding, BOM and line endings stay as they were, an
// unchanged document saves its original bytes, and switching to UTF-8 takes an explicit intent.
import { REMOTE_LIMITS } from '../../../protocol/protocol.ts';
import { decodeText, detectText, encodeText, type TextFormat } from '../../../protocol/textCodec.ts';

export interface TextDocument { bytes: Uint8Array; format: TextFormat; text: string }

/** Another reading of the same bytes, shown before the person chooses it. */
export interface TextReading { format: TextFormat; preview: string }

export type TextOpening =
  /** `certain` only with a BOM or plain ASCII; otherwise the format is a guess and `alternatives` read differently. */
  | { kind: 'opened'; document: TextDocument; certain: boolean; alternatives: TextReading[] }
  | { kind: 'binary' } | { kind: 'too_large' } | { kind: 'not_this_format' };

export type TextSave =
  | { kind: 'ready'; bytes: Uint8Array; format: TextFormat }
  /** `index` is the UTF-16 position of the first character the format cannot hold. */
  | { kind: 'unrepresentable'; index: number; character: string }
  | { kind: 'too_large' };

const PREVIEW_CHARACTERS = 400;
const UTF8: TextFormat = { encoding: 'utf-8', bom: false };

/** `chosen` reads the bytes in a format the person picked instead of the detected one. */
export function openText(bytes: Uint8Array, chosen?: TextFormat): TextOpening {
  if (bytes.length > REMOTE_LIMITS.editableTextBytes) return { kind: 'too_large' };
  if (chosen) {
    const text = decodeText(bytes, chosen);
    return text === null ? { kind: 'not_this_format' } : { kind: 'opened', document: { bytes, format: chosen, text }, certain: true, alternatives: [] };
  }
  const { candidates, certain } = detectText(bytes);
  const [format, ...others] = candidates;
  if (!format) return { kind: 'binary' };
  const text = decodeText(bytes, format)!;
  const alternatives = others.map((other) => ({ format: other, text: decodeText(bytes, other)! }))
    .filter((other) => other.text !== text).map((other) => ({ format: other.format, preview: other.text.slice(0, PREVIEW_CHARACTERS) }));
  return { kind: 'opened', document: { bytes, format, text }, certain, alternatives };
}

/** The bytes to save for `draft`. Never substitutes a character and never changes the format unasked. */
export function prepareSave(document: TextDocument, draft: string, intent?: { convertToUtf8: true }): TextSave {
  if (draft === document.text && !intent) return { kind: 'ready', bytes: document.bytes, format: document.format };
  const format = intent && document.format.encoding !== 'utf-8' ? UTF8 : document.format;
  const encoded = encodeText(draft, format);
  if (!(encoded instanceof Uint8Array)) {
    const code = draft.codePointAt(encoded.unrepresentable)!;
    // A lone surrogate is shown as itself; a pair as the whole character.
    return { kind: 'unrepresentable', index: encoded.unrepresentable, character: code > 0xffff ? String.fromCodePoint(code) : draft[encoded.unrepresentable]! };
  }
  return encoded.length > REMOTE_LIMITS.editableTextBytes ? { kind: 'too_large' } : { kind: 'ready', bytes: encoded, format };
}

/** How a text breaks its lines: one kind throughout, none, or a mix. */
export type LineEndings = 'lf' | 'crlf' | 'cr' | 'none' | 'mixed';

/**
 * What the editor shows. A text input may turn a lone «\r» into «\n» or drop it, so uniform line
 * endings are shown as «\n» and `storedText` puts them back. A mix cannot be put back unasked: it is
 * shown as it is and the screen does not let it be edited.
 */
export function editorText(text: string): { text: string; endings: LineEndings } {
  const kinds = new Set<LineEndings>();
  for (const found of text.matchAll(/\r\n|\r|\n/g)) kinds.add(found[0] === '\r\n' ? 'crlf' : found[0] === '\r' ? 'cr' : 'lf');
  if (kinds.size > 1) return { text, endings: 'mixed' };
  const [endings = 'none'] = kinds;
  return { text: endings === 'crlf' || endings === 'cr' ? text.replace(/\r\n?/g, '\n') : text, endings };
}

/** The text to save from what the editor shows, with the file's own line endings. */
export function storedText(shown: string, endings: LineEndings): string {
  return endings === 'crlf' ? shown.replace(/\n/g, '\r\n') : endings === 'cr' ? shown.replace(/\n/g, '\r') : shown;
}

/**
 * What the editor shows as one text field each. Android lays out a text field's whole text again on
 * every keystroke, so 5 MiB in one field takes seconds per key: a long text is edited in pieces of at
 * most `size` UTF-16 units that join back to exactly the same text. A piece ends after a line break
 * when the line fits, and never between the two halves of a character.
 */
export function editorPieces(text: string, size = 4096): string[] {
  const pieces: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const brk = text.lastIndexOf('\n', end - 1);
      if (brk >= start) end = brk + 1;
      else if (/[\ud800-\udbff]/.test(text[end - 1]!)) end--;
    }
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces.length ? pieces : [''];
}
