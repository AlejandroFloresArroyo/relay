// A Servidor file attached to a Turno travels as a note at the start of `input`: Hermes' /v1/runs has
// no attachment field, and its own gateways inject documents the same way (docs/research/chat-file-reference-114.md).
// The Puente writes the notes; the app and the Puente parse them back so the raw note is never shown.

const NOTE = /^\[The user attached a file that is on this machine: (\/.*)\. Its content is not included; read it from that path yourself when the request involves it\.\]$/;
const NOTE_HEAD = '[The user attached a file that is on this machine: ';

/** One line per file, then a blank line, then the text. The model reads it; Relay parses it back. */
export function withFileNotes(text: string, paths: string[]): string {
  if (paths.length === 0) return text;
  return `${paths.map((path) => `[The user attached a file that is on this machine: ${path}. Its content is not included; read it from that path yourself when the request involves it.]`).join('\n')}\n\n${text}`;
}

/** Leading notes become paths; anything else is left as the text. */
export function splitFileNotes(text: string): { paths: string[]; text: string } {
  const lines = text.split('\n');
  const paths: string[] = [];
  for (const line of lines) {
    const match = NOTE.exec(line);
    if (!match) break;
    paths.push(match[1]!);
  }
  if (paths.length === 0) return { paths, text };
  if (paths.length === lines.length) return { paths, text: '' };
  if (lines[paths.length] !== '') return { paths: [], text };
  return { paths, text: lines.slice(paths.length + 1).join('\n') };
}

/** A one-line summary of a message: its text without notes, or the file names when there is no text. */
export function previewWithoutNotes(message: string): string {
  const { paths, text } = splitFileNotes(message);
  return text.trim() || paths.map((path) => path.slice(path.lastIndexOf('/') + 1)).join(', ');
}

/** Hermes titles a Conversación with the first line of its first message, cut at a word and ended in «…»,
 * and numbers a colliding title « #N». A note, whole or cut, names no topic: there is no title, and the app falls back. */
export function titleWithoutNotes(title: string): string | null {
  const base = title.replace(/ #\d+$/, '');
  const stem = base.endsWith('…') ? base.slice(0, -1) : base;
  return stem.startsWith(NOTE_HEAD) || (stem !== base && NOTE_HEAD.startsWith(stem)) ? null : title;
}
