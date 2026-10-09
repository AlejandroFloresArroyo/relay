import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInline, parseMarkdown, safeMarkdownUrl, type Inline, type MarkdownBlock } from './markdown.ts';

function text(nodes: Inline[]): string {
  return nodes.map((node) => 'text' in node ? node.text : text(node.children)).join('');
}
function blocksOfKind<K extends MarkdownBlock['kind']>(blocks: MarkdownBlock[], kind: K): Extract<MarkdownBlock, { kind: K }>[] {
  return blocks.flatMap((block) => [
    ...(block.kind === kind ? [block as Extract<MarkdownBlock, { kind: K }>] : []),
    ...(block.kind === 'quote' ? blocksOfKind(block.blocks, kind) : block.kind === 'list' ? block.items.flatMap((item) => blocksOfKind(item, kind)) : []),
  ]);
}

test('fences retain whitespace, blank lines, markup, CRLF and longer inner fences for exact copy', () => {
  for (const code of ['  **literal** | `code`\n\tfin\n', '  a\r\n\r\n\tb\r\n', '```\n<unsafe>\n']) {
    const blocks = parseMarkdown('````txt\n' + code + '````');
    assert.equal(blocksOfKind(blocks, 'code')[0].text, code);
  }
  assert.equal(blocksOfKind(parseMarkdown('~~~sh\nx\n~~~'), 'code')[0].text, 'x\n');
  assert.equal(blocksOfKind(parseMarkdown('```sh\nx\n```not-a-close\ny'), 'code')[0].text, 'x\n```not-a-close\ny');
});

test('streaming incomplete constructs stay literal and unfinished code retains all available bytes', () => {
  for (const value of ['**sin terminar', '*abierto', '`abierto', '[sin destino](https://exa', '[etiqueta', '<https://exa']) {
    assert.equal(text(parseInline(value)), value);
    assert.ok(parseInline(value).every((node) => node.kind === 'text'));
  }
  for (const code of ['  const a = "**literal**";', 'a\n', 'a\n\n']) {
    assert.equal(blocksOfKind(parseMarkdown('```js\n' + code), 'code')[0].text, code);
  }
});

test('indented code removes only its structural indentation and preserves literal contents', () => {
  const blocks = parseMarkdown('Antes\n\n    const x = "*sin énfasis*";\n\t  siguiente\n\nDespués');
  assert.equal(blocksOfKind(blocks, 'code')[0].text, 'const x = "*sin énfasis*";\n  siguiente\n');
  assert.equal(blocksOfKind(blocks, 'paragraph').map((block) => text(block.children)).join('|'), 'Antes|Después');
});

test('table cells do not split escaped pipes or pipes within variable-length code spans', () => {
  const block = blocksOfKind(parseMarkdown('| Literal | Código |\n| :--- | ---: |\n| a\\|b | ``x|`y`` |\n| c | `z|q` |'), 'table')[0];
  assert.deepEqual(block.rows.map((row) => row.map(text)), [['a|b', 'x|`y'], ['c', 'z|q']]);
  assert.deepEqual(block.align, ['left', 'right']);
  assert.equal(block.rows[0][1][0].kind, 'code');
  assert.equal(blocksOfKind(parseMarkdown('| A | B |\n| --- | incompleto'), 'table').length, 0);
});

test('nested lists retain ordered starts and nested quote content', () => {
  const blocks = parseMarkdown('3. Principal\n   - Hijo\n     7. Nieto\n        > Cita\n4. Siguiente');
  const lists = blocksOfKind(blocks, 'list');
  assert.equal(lists[0].start, 3);
  assert.equal(lists[0].items.length, 2);
  assert.equal(lists[1].ordered, false);
  assert.equal(lists[2].start, 7);
  assert.equal(text(blocksOfKind(blocksOfKind(blocks, 'quote')[0].blocks, 'paragraph')[0].children), 'Cita');
});

test('inline escapes, variable backticks, nested emphasis and intraword underscores are not mangled', () => {
  assert.equal(text(parseInline('\\*literal\\* y \\[texto\\]')), '*literal* y [texto]');
  assert.equal(text(parseInline('`` a`b **literal** ``')), 'a`b **literal**');
  assert.equal(text(parseInline('snake_case_name')), 'snake_case_name');
  const strong = parseInline('**0 procesos `pw-play`**')[0];
  assert.equal(strong.kind, 'strong');
  assert.ok('children' in strong && strong.children.some((node) => node.kind === 'code'));
  const nested = parseInline('**negrita *énfasis***')[0];
  assert.ok(nested.kind === 'strong' && nested.children.some((node) => node.kind === 'emphasis'));
  assert.equal(text(parseInline('2 ** 3 = 8')), '2 ** 3 = 8');
});

test('safe external link destinations include balanced parentheses and hostile protocols remain inert', () => {
  for (const value of ['https://example.com/a_(b)', 'http://example.com/path?q=1#fragment']) assert.equal(safeMarkdownUrl(value), value);
  for (const value of ['javascript:alert(1)', 'file:///tmp/private', 'data:text/html,x', '//example.com', 'https://user:secret@example.com', 'https://example.com\\@host', 'https://example.com\n/path', 'https://']) assert.equal(safeMarkdownUrl(value), null, value);
  const safe = parseInline('[detalle](https://example.com/a_(b))')[0];
  assert.ok(safe.kind === 'link' && safe.url === 'https://example.com/a_(b)');
  const unsafe = parseInline('[inert](javascript:alert(1))')[0];
  assert.ok(unsafe.kind === 'link' && unsafe.url === null);
  assert.equal(text(parseInline('<script>alert(1)</script>')), '<script>alert(1)</script>');
});

test('ATX and setext headings preserve literal trailing hashes unless separated by whitespace', () => {
  assert.equal(text(blocksOfKind(parseMarkdown('## C#'), 'heading')[0].children), 'C#');
  assert.equal(text(blocksOfKind(parseMarkdown('## Título ##'), 'heading')[0].children), 'Título');
  assert.equal(blocksOfKind(parseMarkdown('Título\n===='), 'heading')[0].level, 1);
});

test('reference links resolve case and whitespace normalized definitions but leave missing references and code literal', () => {
  const blocks = parseMarkdown('[Detalle][ REF ] y [Resumen][] y [Atajo] y [Inerte][bad] y [Ausente][missing]\n\n[ref]: https://example.com/a_(b) "Título"\n[Resumen]: https://example.com/resumen\n[Atajo]: http://example.com\n[bad]: javascript:alert(1)\n\n```txt\n[ref]: https://changed.example\n```');
  const paragraph = blocksOfKind(blocks, 'paragraph')[0];
  const links = paragraph.children.filter((node) => node.kind === 'link');
  assert.deepEqual(links.map((node) => [text(node.children), node.url]), [
    ['Detalle', 'https://example.com/a_(b)'], ['Resumen', 'https://example.com/resumen'],
    ['Atajo', 'http://example.com'], ['Inerte', null],
  ]);
  assert.ok(text(paragraph.children).includes('[Ausente][missing]'));
  assert.equal(blocksOfKind(blocks, 'paragraph').length, 1);
  assert.equal(blocksOfKind(blocks, 'code')[0].text, '[ref]: https://changed.example\n');
});

test('lazy paragraph continuations stay inside their list item without swallowing separated paragraphs or headings', () => {
  const blocks = parseMarkdown('- Primera línea\ncontinuación\n- Segunda\n\nFuera\n\n- Tercera\n# Título');
  assert.deepEqual(blocks.map((block) => block.kind), ['list', 'paragraph', 'list', 'heading']);
  const first = blocksOfKind(blocks, 'list')[0];
  assert.equal(first.items.length, 2);
  assert.equal(text(blocksOfKind(first.items[0], 'paragraph')[0].children), 'Primera línea\ncontinuación');
  assert.equal(text(blocksOfKind(first.items[1], 'paragraph')[0].children), 'Segunda');
  assert.equal(text(blocksOfKind(blocks, 'heading')[0].children), 'Título');
});
