// D-ES copy rules over every UI string the app ships: one failure phrase, one retry label, «‹ <padre>»
// returns and loading ending in «…». Walks string literals, templates and JSX text with the compiler.
// Also the floor of the type scale: no text under 9.5 px. Reads mobile/src, protocol/ and bridge/src,
// except the Puente's operator output (`cli.ts`, `setup.ts`), which a terminal shows, not the app.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = join(import.meta.dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

/** Every piece of text in the file: literals, templates and JSX children, an embedded expression reading «X». */
function texts(path: string): string[] {
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    // A literal text size (`s={9}`, `fontSize: 9`) is recorded as «SIZE <n>».
    if ((ts.isJsxAttribute(node) && node.name.getText() === 's' && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression && ts.isNumericLiteral(node.initializer.expression))
      || (ts.isPropertyAssignment(node) && node.name.getText() === 'fontSize' && ts.isNumericLiteral(node.initializer)))
      found.push(`SIZE ${ts.isJsxAttribute(node) ? (node.initializer as ts.JsxExpression).expression!.getText() : (node as ts.PropertyAssignment).initializer.getText()}`);
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push(node.text);
    else if (ts.isTemplateExpression(node)) found.push(node.head.text + node.templateSpans.map(span => `X${span.literal.text}`).join(''));
    else if ((ts.isJsxElement(node) || ts.isJsxFragment(node)) && node.children.some(ts.isJsxText)) {
      const text = node.children.map(child => ts.isJsxText(child) ? child.text : ts.isJsxExpression(child) ? 'X' : ' ').join('').replace(/\s+/g, ' ').trim();
      if (text) found.push(text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

// The shared protocol and the Puente carry messages the app shows as they are.
const OPERATOR_OUTPUT = ['../../bridge/src/cli.ts', '../../bridge/src/setup.ts'];
const all = [root, join(root, '../../protocol'), join(root, '../../bridge/src')].flatMap(dir => sources(dir)).filter(path => !OPERATOR_OUTPUT.includes(relative(root, path))).flatMap(path => texts(path).map(text => ({ at: relative(root, path), text })));
const offending = (bad: (text: string) => boolean) => all.filter(({ text }) => bad(text)).map(({ at, text }) => `${at}: ${text}`);

/** A «No se pudo…» or «No se pudieron…» that does not go on «<verbo>. Reintenta.». */
const badFailure = (text: string) => [...text.matchAll(/No se pud(?:o|ieron)/g)].some(match => !/^No se pud(?:o|ieron) [^.;]+\. Reintenta\.(?:$|\s)/.test(text.slice(match.index)));
test('every «No se pudo…» reads «No se pudo <verbo>. Reintenta.»', () => {
  // The rule itself, so a broken pattern cannot pass everything.
  for (const bad of ['No se pudo guardar.', 'No se pudieron leer los logs.', 'Listo. No se pudo guardar; revisa.']) assert.ok(badFailure(bad), bad);
  for (const good of ['No se pudo guardar. Reintenta.', 'No se pudieron leer los logs. Reintenta. Si sigue, revisa el Puente.']) assert.ok(!badFailure(good), good);
  assert.ok(all.some(({ text }) => text.includes('No se pudo X. Reintenta.')), 'the walker must see the states template');
  assert.ok(all.some(({ at }) => at.startsWith('../../bridge/')), 'the walker must see the Puente');
  assert.ok(!all.some(({ at }) => OPERATOR_OUTPUT.includes(at)), 'operator output stays out');
  assert.deepEqual(offending(badFailure), []);
});

test('a retry is always «Reintentar», never another label', () => {
  assert.deepEqual(offending(text => /reintentar\s+\S|int[eé]ntalo de nuevo|vuelve a intentar|volver a intentar|intentar de nuevo|probar de nuevo|reintentarlo/i.test(text)), []);
});

test('no bare «Volver»: returns read «‹ <padre>»', () => {
  assert.deepEqual(offending(text => /^(?:‹\s*)?volver\.?$/i.test(text.trim())), []);
});

// A text that is only work in progress («Comprobando», «CARGANDO TAREAS», «Guardando cambio») ends
// in «…». Gerunds that name an ongoing state rather than a wait (TRABAJANDO, Escribiendo, DICTANDO,
// esperando Aprobación) are states, not loading, and are not held to it. A demo picker's bare scenario
// name «Cargando» is a name. A label with its value after « · » (DESCARGANDO · 4 MB) carries the value.
const LOADING = /^(?:cargando|comprobando|consultando|calculando|actualizando|descargando|subiendo|preparando|guardando|verificando|reconectando|conectando|canjeando|moviendo|cambiando|enviando|leyendo|buscando|abriendo)\b[^.!?:…]*$/i;
test('loading ends in «…», never three dots', () => {
  assert.deepEqual(offending(text => /\p{L}\.\.\.(?!\p{L})/u.test(text) || LOADING.test(text) && !/\s·(?:\s|$)/.test(text) && text !== 'Cargando'), []);
});

test('no text under 9.5 px', () => {
  assert.ok(all.some(({ text }) => text.startsWith('SIZE ')), 'the walker must see literal sizes');
  assert.deepEqual(offending(text => text.startsWith('SIZE ') && Number(text.slice(5)) < 9.5), []);
});
