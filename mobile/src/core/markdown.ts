export type Inline =
  | { kind: 'text' | 'code'; text: string }
  | { kind: 'strong' | 'emphasis'; children: Inline[] }
  | { kind: 'link'; children: Inline[]; url: string | null };
export type MarkdownBlock =
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'heading'; level: number; children: Inline[] }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'quote'; blocks: MarkdownBlock[] }
  | { kind: 'list'; ordered: boolean; start: number; items: MarkdownBlock[][] }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][]; align: ('left' | 'center' | 'right')[] }
  | { kind: 'rule' };

/** Only explicit external web addresses may cross the native Linking boundary. */
export function safeMarkdownUrl(value: string): string | null {
  if (!/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname && !url.username && !url.password ? value : null;
  } catch { return null; }
}

const escapable = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
function closing(text: string, marker: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\' && marker[0] !== '`') { i++; continue; }
    if (text[i] === '`' && marker[0] !== '`') {
      const run = text.slice(i).match(/^`+/)![0];
      const end = closing(text, run, i + run.length);
      if (end !== -1) { i = end + run.length - 1; continue; }
    }
    if (text.startsWith(marker, i)) {
      if (marker[0] === '`' && (text[i - 1] === '`' || text[i + marker.length] === '`')) continue;
      if (marker[0] === '*' || marker[0] === '_') {
        let end = i + marker.length;
        while (text[end] === marker[0]) end++;
        return end - marker.length;
      }
      return i;
    }
  }
  return -1;
}

export function parseInline(text: string, depth = 0, references?: ReadonlyMap<string, string>): Inline[] {
  if (depth > 24) return [{ kind: 'text', text }];
  const out: Inline[] = [];
  const plain = (value: string) => {
    const last = out[out.length - 1];
    if (last?.kind === 'text') last.text += value;
    else out.push({ kind: 'text', text: value });
  };
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\' && escapable.test(text[i + 1] ?? '')) { plain(text[i + 1]); i += 2; continue; }
    if (text[i] === '`') {
      const marker = text.slice(i).match(/^`+/)![0];
      const end = closing(text, marker, i + marker.length);
      if (end !== -1) {
        let value = text.slice(i + marker.length, end).replace(/\r?\n/g, ' ');
        if (value.startsWith(' ') && value.endsWith(' ') && value.trim()) value = value.slice(1, -1);
        out.push({ kind: 'code', text: value }); i = end + marker.length; continue;
      }
      plain(marker); i += marker.length; continue;
    }
    if (text[i] === '[' && text[i - 1] !== '!') {
      let end = i + 1; let nesting = 1;
      for (; end < text.length; end++) {
        if (text[end] === '\\') { end++; continue; }
        if (text[end] === '[') nesting++;
        if (text[end] === ']' && --nesting === 0) break;
      }
      if (nesting === 0 && text[end + 1] === '(') {
        let stop = end + 2; let parens = 1;
        for (; stop < text.length; stop++) {
          if (text[stop] === '\\') { stop++; continue; }
          if (text[stop] === '(') parens++;
          if (text[stop] === ')' && --parens === 0) break;
        }
        if (parens === 0) {
          const destination = text.slice(end + 2, stop).trim().match(/^(?:<([^<>]*)>|(\S+?))(?:\s+["'].*["'])?$/);
          const url = (destination?.[1] ?? destination?.[2] ?? '').replace(/\\([()\\])/g, '$1');
          out.push({ kind: 'link', children: parseInline(text.slice(i + 1, end), depth + 1, references), url: safeMarkdownUrl(url) });
          i = stop + 1; continue;
        }
      }
      if (nesting === 0 && references) {
        const suffix = /^\[([^\]]*)\]/.exec(text.slice(end + 1));
        const label = (suffix?.[1] || text.slice(i + 1, end)).trim().replace(/\s+/g, ' ').toLowerCase();
        const destination = references.get(label);
        if (destination !== undefined) {
          out.push({ kind: 'link', children: parseInline(text.slice(i + 1, end), depth + 1, references), url: safeMarkdownUrl(destination) });
          i = end + 1 + (suffix?.[0].length ?? 0); continue;
        }
      }
    }
    if (text[i] === '<') {
      const end = text.indexOf('>', i + 1);
      const url = end !== -1 ? safeMarkdownUrl(text.slice(i + 1, end)) : null;
      if (url) { out.push({ kind: 'link', url, children: [{ kind: 'text', text: url }] }); i = end + 1; continue; }
    }
    if (text[i] === '*' || text[i] === '_') {
      const char = text[i];
      const marker = text.startsWith(char.repeat(3), i) ? char.repeat(3) : text.startsWith(char.repeat(2), i) ? char.repeat(2) : char;
      const insideWord = char === '_' && /[\p{L}\p{N}]/u.test(text[i - 1] ?? '');
      const end = insideWord || /\s/.test(text[i + marker.length] ?? ' ') ? -1 : closing(text, marker, i + marker.length);
      if (end > i + marker.length && !/\s/.test(text[end - 1])) {
        const children = parseInline(text.slice(i + marker.length, end), depth + 1, references);
        out.push(marker.length === 3 ? { kind: 'strong', children: [{ kind: 'emphasis', children }] } : { kind: marker.length === 2 ? 'strong' : 'emphasis', children });
        i = end + marker.length; continue;
      }
      plain(marker); i += marker.length; continue;
    }
    plain(text[i]); i++;
  }
  return out;
}

/** Table pipes inside escaped text or a matched code span are cell content. */
export function tableCells(line: string): string[] {
  const cells: string[] = []; let cell = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && i + 1 < line.length) { cell += line[i] + line[++i]; continue; }
    if (line[i] === '`') {
      const run = line.slice(i).match(/^`+/)![0];
      const end = closing(line, run, i + run.length);
      if (end !== -1) { cell += line.slice(i, end + run.length); i = end + run.length - 1; continue; }
    }
    if (line[i] === '|') { cells.push(cell.trim()); cell = ''; }
    else cell += line[i];
  }
  cells.push(cell.trim());
  if (line.trimStart().startsWith('|')) cells.shift();
  if (line.trimEnd().endsWith('|') && cells[cells.length - 1] === '') cells.pop();
  return cells;
}
const fence = (line: string) => /^ {0,3}(`{3,}|~{3,})([^\r]*)\r?$/.exec(line);
const list = (line: string) => /^( *)([-+*]|\d+[.)]) +(.*)\r?$/.exec(line);
const rule = (line: string) => /^ {0,3}(?:(?:\* *){3,}|(?:- *){3,}|(?:_ *){3,})\r?$/.test(line);
const heading = (line: string) => /^ {0,3}(#{1,6}) +(.+?)\s*$/.exec(line);
const delimiter = (line: string) => {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell)) ? cells : null;
};
const begins = (line: string) => !!(fence(line) || heading(line) || list(line) || rule(line) || /^ {0,3}>/.test(line) || /^( {4}|\t)/.test(line));

export function parseMarkdown(source: string, depth = 0): MarkdownBlock[] {
  const references = new Map<string, string>();
  const deferred = new Map<Inline[], string>();
  const inline = (text: string): Inline[] => {
    const children: Inline[] = [];
    deferred.set(children, text);
    return children;
  };
  const blocks = parseBlocks(source, depth, references, inline);
  // Resolve once all block-level definitions are known; never scan or rewrite literal code.
  for (const [children, text] of deferred) {
    for (const node of parseInline(text, 0, references)) children.push(node);
  }
  return blocks;
}

function parseBlocks(source: string, depth: number, references: Map<string, string>, inline: (text: string) => Inline[]): MarkdownBlock[] {
  if (depth > 24) return [{ kind: 'paragraph', children: inline(source) }];
  const lines = source.split('\n'); const blocks: MarkdownBlock[] = [];
  const raw = (start: number, end: number) => lines.slice(start, end).join('\n') + (end > start && end < lines.length ? '\n' : '');
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const opening = fence(line);
    if (opening && (opening[1][0] !== '`' || !opening[2].includes('`'))) {
      const start = ++i;
      const endPattern = new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}\\s*$`);
      while (i < lines.length && !endPattern.test(lines[i])) i++;
      blocks.push({ kind: 'code', language: opening[2].trim().split(/\s/)[0], text: raw(start, i) });
      if (i < lines.length) i++;
      continue;
    }
    if (/^( {4}|\t)/.test(line)) {
      const start = i;
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || !lines[i].trim())) i++;
      let end = i;
      while (end > start && !lines[end - 1].trim()) end--;
      blocks.push({ kind: 'code', language: '', text: lines.slice(start, end).map((value) => value.replace(/^( {4}|\t)/, '')).join('\n') + (end < lines.length ? '\n' : '') });
      continue;
    }
    const definition = /^ {0,3}\[([^\[\]]+)\]:[ \t]*(?:<([^<>]*)>|(\S+))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*\r?$/.exec(line);
    if (definition) {
      const label = definition[1].trim().replace(/\s+/g, ' ').toLowerCase();
      if (!references.has(label)) references.set(label, definition[2] ?? definition[3]);
      i++; continue;
    }
    const title = heading(line);
    if (title) { blocks.push({ kind: 'heading', level: title[1].length, children: inline(title[2].replace(/\s+#+$/, '')) }); i++; continue; }
    if (i + 1 < lines.length && /^ {0,3}(=+|-+)\s*$/.test(lines[i + 1])) {
      blocks.push({ kind: 'heading', level: lines[i + 1].trim()[0] === '=' ? 1 : 2, children: inline(line.trim()) }); i += 2; continue;
    }
    if (rule(line)) { blocks.push({ kind: 'rule' }); i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) quote.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      blocks.push({ kind: 'quote', blocks: parseBlocks(quote.join('\n'), depth + 1, references, inline) }); continue;
    }
    const first = list(line);
    if (first) {
      const base = first[1].length; const ordered = /^\d/.test(first[2]); const items: MarkdownBlock[][] = [];
      while (i < lines.length) {
        const item = list(lines[i]);
        if (!item || item[1].length !== base || /^\d/.test(item[2]) !== ordered) break;
        const indent = item[1].length + item[2].length + 1; const content = [item[3]]; i++;
        while (i < lines.length) {
          const next = list(lines[i]);
          if (next && next[1].length <= base) break;
          if (!lines[i].trim()) {
            if (i + 1 >= lines.length || (lines[i + 1].search(/\S/) <= base && !list(lines[i + 1]))) break;
            content.push(''); i++; continue;
          }
          const spaces = lines[i].search(/\S/);
          if (spaces <= base && begins(lines[i])) break;
          content.push(lines[i].slice(Math.min(indent, spaces))); i++;
        }
        items.push(parseBlocks(content.join('\n'), depth + 1, references, inline));
      }
      blocks.push({ kind: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items }); continue;
    }
    const separators = i + 1 < lines.length ? delimiter(lines[i + 1]) : null;
    const cells = tableCells(line);
    if (separators && cells.length === separators.length && (line.includes('|') || separators.length === 1)) {
      const rows: Inline[][][] = []; i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !begins(lines[i])) {
        const row = tableCells(lines[i++]);
        rows.push(cells.map((_, j) => inline(row[j] ?? '')));
      }
      blocks.push({ kind: 'table', header: cells.map(inline), rows, align: separators.map((cell) => cell.endsWith(':') ? cell.startsWith(':') ? 'center' : 'right' : 'left') }); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !begins(lines[i]) && !(i + 1 < lines.length && delimiter(lines[i + 1]))) paragraph.push(lines[i++]);
    blocks.push({ kind: 'paragraph', children: inline(paragraph.join('\n')) });
  }
  return blocks;
}
