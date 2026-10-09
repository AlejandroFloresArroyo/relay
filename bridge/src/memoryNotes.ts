// Hermes ea114c3 memory_tool_store.py: notes are separated by the full delimiter;
// limits count Python Unicode characters, including delimiters between nonempty notes.
const delimiter = '\n§\n';
export interface MemoryNoteText { index: number; text: string }
export interface MemoryNoteChange { index: number; previous: string; content: string | null }
const body = (raw: string) => raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
// Python str.strip includes NEL/control separators and excludes BOM inside a note.
const whitespace = '[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const strip = (text: string) => text.replace(new RegExp('^' + whitespace + '+|' + whitespace + '+$', 'gu'), '');
// Path.read_text uses universal newlines. Keep the physical separators for surgical edits.
const newlineText = (text: string) => text.replace(/\r\n|\r/g, '\n');
const physicalParts = (raw: string) => body(raw).split(/((?:\r\n|\r|\n)§(?:\r\n|\r|\n))/u);

export function memoryNotes(raw: string): MemoryNoteText[] {
  return physicalParts(raw).flatMap((segment, position) => {
    if (position % 2) return [];
    const text = strip(newlineText(segment));
    return text ? [{ index: position / 2, text }] : [];
  });
}

export function memoryCharacters(raw: string): number {
  return [...memoryNotes(raw).map((note) => note.text).join(delimiter)].length;
}

export function changeMemoryNote(raw: string, change: MemoryNoteChange, limit: number): string {
  const segments = physicalParts(raw);
  const position = change.index * 2;
  if (!Number.isSafeInteger(change.index) || change.index < 0 || position >= segments.length
    || !change.previous || strip(newlineText(segments[position])) !== change.previous) throw new Error('memory_note_conflict');
  if (change.content === null) {
    if (position + 1 < segments.length) segments.splice(position, 2);
    else if (position > 0) segments.splice(position - 1, 2);
    else segments.splice(position, 1);
  }
  else {
    const content = strip(change.content);
    if (!content || newlineText(content).includes(delimiter) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(content)) throw new Error('memory_note_invalid');
    segments[position] = content;
  }
  const joined = segments.join('');
  const result = memoryNotes(joined).length ? (raw.startsWith('\uFEFF') ? '\uFEFF' : '') + joined : '';
  if (change.content !== null && memoryCharacters(result) > limit) throw new Error('memory_limit_exceeded');
  return result;
}
