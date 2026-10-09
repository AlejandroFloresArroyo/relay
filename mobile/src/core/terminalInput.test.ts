import assert from 'node:assert/strict';
import test from 'node:test';
import { attachIme, attachTouchSelection, createKeyBar, type KeyActions, type Mods } from './terminalInput.ts';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

type Listener = (event: FakeEvent) => void;
type FakeEvent = Record<string, any> & { type: string; target: FakeNode; defaultPrevented: boolean };

/** Just enough DOM: capture on the ancestors, then the target, then bubbling; stopPropagation holds. */
class FakeNode {
  listeners: { type: string; listener: Listener; capture: boolean }[] = [];
  parent?: FakeNode;
  constructor(parent?: FakeNode) { this.parent = parent; }
  addEventListener(type: string, listener: Listener, options?: boolean | { capture?: boolean }) {
    this.listeners.push({ type, listener, capture: options === true || (typeof options === 'object' && !!options.capture) });
  }
  removeEventListener(type: string, listener: Listener, options?: boolean | { capture?: boolean }) {
    const capture = options === true || (typeof options === 'object' && !!options.capture);
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.listener === listener && l.capture === capture));
  }
}
class FakeTextarea extends FakeNode {
  value = '';
  attributes: Record<string, string> = {};
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
}

function dispatch(target: FakeNode, type: string, init: Record<string, unknown> = {}): FakeEvent {
  let stopped = false;
  const event: FakeEvent = {
    type, target, defaultPrevented: false, ...init,
    stopPropagation() { stopped = true; },
    preventDefault() { event.defaultPrevented = true; },
  };
  const ancestors: FakeNode[] = [];
  for (let node = target.parent; node; node = node.parent) ancestors.unshift(node);
  const run = (node: FakeNode, phase: 'capture' | 'target' | 'bubble') => {
    for (const l of [...node.listeners]) if (l.type === type && (phase === 'target' || l.capture === (phase === 'capture'))) l.listener(event);
  };
  for (const node of ancestors) { run(node, 'capture'); if (stopped) return event; }
  run(target, 'target');
  if (stopped) return event;
  for (const node of ancestors.reverse()) { run(node, 'bubble'); if (stopped) return event; }
  return event;
}

/**
 * The host with xterm's textarea inside, xterm's own listeners on it, and an IME that types like
 * Gboard (events captured on the emulator, review-v3-84 B1). Everything the shell would get lands in
 * `out`, from xterm and from the adapter alike.
 */
function page() {
  const host = new FakeNode();
  const textarea = new FakeTextarea(host);
  const out: string[] = [];
  // CoreBrowserTerminal._keyDown: a key xterm handles is sent and cancelled, which stops it at the
  // textarea; Enter and Ctrl-C also empty the textarea.
  textarea.addEventListener('keydown', (event) => {
    if (event.keyCode === 229) { out.push('<xterm saw an IME key>'); return; }
    const data = event.ctrlKey && event.key === 'c' ? '\x03' : ({ 13: '\r', 8: '\x7f', 9: '\t', 27: '\x1b' } as Record<number, string>)[event.keyCode];
    if (!data) return;
    if (data === '\r' || data === '\x03') textarea.value = '';
    out.push(data);
    event.preventDefault();
    event.stopPropagation();
  }, true);
  // xterm's own guess at IME input: it would send every letter a second time.
  textarea.addEventListener('input', (event) => { if (event.inputType === 'insertText') out.push(event.data); }, true);
  textarea.addEventListener('compositionend', (event) => out.push(`<xterm composed ${event.data}>`));
  const detach = attachIme(host as unknown as HTMLElement, textarea as unknown as HTMLTextAreaElement, (data) => out.push(data));
  const key = (keyCode: number, init: Record<string, unknown> = {}) => {
    dispatch(textarea, 'keydown', { keyCode, ...init });
    dispatch(textarea, 'keyup', { keyCode, ...init });
  };
  const ime = {
    type(text: string) {
      for (const char of text) {
        dispatch(textarea, 'keydown', { keyCode: 229 });
        textarea.value += char;
        dispatch(textarea, 'input', { inputType: 'insertText', data: char });
        dispatch(textarea, 'keyup', { keyCode: 229 });
      }
    },
    /** The IME deletes from the text it believes is in the field. */
    deleteBackward() {
      dispatch(textarea, 'keydown', { keyCode: 229 });
      textarea.value = [...textarea.value].slice(0, -1).join('');
      dispatch(textarea, 'input', { inputType: 'deleteContentBackward', data: null });
      dispatch(textarea, 'keyup', { keyCode: 229 });
    },
    compose(steps: string[]) {
      dispatch(textarea, 'compositionstart', { data: '' });
      for (const value of steps) {
        textarea.value = value;
        dispatch(textarea, 'compositionupdate', { data: value });
        dispatch(textarea, 'input', { inputType: 'insertCompositionText', data: value });
      }
      dispatch(textarea, 'compositionend', { data: steps.at(-1) });
    },
    enter: () => key(13, { key: 'Enter' }),
    ctrlC: () => key(67, { key: 'c', ctrlKey: true }),
  };
  return { host, textarea, out, ime, detach, sent: () => out.join('') };
}

test('IME letters reach the shell once each, in order, and xterm never handles them', () => {
  const p = page();
  p.ime.type('ls');
  p.ime.enter();
  assert.deepEqual(p.out, ['l', 's', '\r']);
  assert.equal(p.textarea.attributes.autocomplete, 'off');
});

test('the IME deleting a letter sends one DEL; a word replaced in place sends DELs and the new text', () => {
  const p = page();
  p.ime.type('cas');
  p.ime.deleteBackward();
  p.ime.type('ncion');
  p.textarea.value = 'canción';
  dispatch(p.textarea, 'input', { inputType: 'insertReplacementText', data: 'canción' });
  assert.equal(p.sent(), 'cas\x7fncion\x7f\x7fón');
});

test('a composition sends nothing until it ends, then only what changed', () => {
  const p = page();
  p.ime.type('la ');
  p.ime.compose(['la c', 'la ca', 'la canci', 'la canción']);
  assert.deepEqual(p.out, ['l', 'a', ' ', 'canción']);
});

test('after Enter or Ctrl-C the next line starts from nothing, even when it begins like the last one', () => {
  const p = page();
  p.ime.type('ca');
  p.ime.enter();
  p.ime.type('ca');
  p.ime.enter();
  p.ime.type('git status');
  p.ime.ctrlC();
  p.ime.type('git diff');
  assert.equal(p.sent(), 'ca\rca\rgit status\x03git diff');
});

test("after Gboard's own Backspace, which xterm sends, the IME text starts over", () => {
  const p = page();
  p.ime.type('casa');
  dispatch(p.textarea, 'keydown', { keyCode: 8, key: 'Backspace' });
  dispatch(p.textarea, 'keyup', { keyCode: 8, key: 'Backspace' });
  assert.equal(p.textarea.value, '');
  p.ime.type('z');
  assert.equal(p.sent(), 'casa\x7fz');
});

test('a paste leaves no copy behind: xterm sent it, and the next letter goes alone', () => {
  const p = page();
  p.ime.type('ab');
  p.textarea.value += 'echo uno\necho dos';
  dispatch(p.textarea, 'input', { inputType: 'insertFromPaste', data: null });
  p.ime.type('c');
  assert.equal(p.sent(), 'abc');
});

test('detached, the adapter hears nothing more', () => {
  const p = page();
  p.detach();
  p.ime.type('a');
  assert.deepEqual(p.out, ['<xterm saw an IME key>', 'a']);
});

/** An xterm stand-in for the key bar: it records what reaches paste and what the selection holds. */
function keyBar({ input = true, clipboard = '', selection = '', applicationCursor = false } = {}) {
  const written: string[] = [];
  const copied: string[] = [];
  const pasted: string[] = [];
  const mods: Mods[] = [];
  let reads = 0;
  let selected = selection;
  const actions: KeyActions = {
    input,
    write: async (text) => { written.push(text); },
    copy: async (text) => { copied.push(text); },
    paste: async () => { reads++; return clipboard; },
  };
  const term = {
    modes: { applicationCursorKeysMode: applicationCursor },
    hasSelection: () => selected !== '',
    getSelection: () => selected,
    clearSelection: () => { selected = ''; },
    paste: (text: string) => { pasted.push(text); },
  };
  const bar = createKeyBar(term, () => actions, (m) => mods.push(m));
  return { ...bar, written, copied, pasted, mods, actions, reads: () => reads, selected: () => selected };
}

test('Ctrl and Alt apply to the next character only, then turn off', () => {
  const k = keyBar();
  k.press('ctrl');
  k.emit('c');
  k.emit('c');
  k.press('alt');
  k.emit('b');
  k.press('ctrl');
  k.press('alt');
  k.emit('a');
  assert.deepEqual(k.written, ['\x03', 'c', '\x1bb', '\x1b\x01']);
  assert.deepEqual(k.mods.at(-1), { ctrl: false, alt: false, select: false });
});

test('Esc, Tab and the arrows send their sequences, the arrows following the cursor mode', () => {
  const normal = keyBar();
  for (const key of ['esc', 'tab', 'up', 'down', 'right', 'left'] as const) normal.press(key);
  assert.deepEqual(normal.written, ['\x1b', '\t', '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D']);
  const application = keyBar({ applicationCursor: true });
  application.press('up');
  assert.deepEqual(application.written, ['\x1bOA']);
});

test('Ctrl and Alt modify the arrows like a keyboard, and Esc, Tab, an arrow or a whole word turns them off', () => {
  const k = keyBar({ applicationCursor: true });
  const after = (keys: (() => void)[]) => { for (const key of keys) key(); k.emit('b'); };
  after([() => k.press('ctrl'), () => k.press('up')]);
  after([() => k.press('alt'), () => k.press('down')]);
  after([() => k.press('ctrl'), () => k.press('alt'), () => k.press('right')]);
  after([() => k.press('ctrl'), () => k.press('esc')]);
  after([() => k.press('alt'), () => k.press('tab')]);
  after([() => k.press('ctrl'), () => k.emit('hola')]);
  assert.deepEqual(k.written, ['\x1b[1;5A', 'b', '\x1b[1;3B', 'b', '\x1b[1;7C', 'b', '\x1b', 'b', '\x1b\t', 'b', 'hola', 'b']);
  assert.deepEqual(k.mods.at(-1), { ctrl: false, alt: false, select: false });
});

test('Pegar hands the clipboard to xterm as it is, with no Enter added', async () => {
  const k = keyBar({ clipboard: 'echo uno\necho dos' });
  k.press('paste');
  await flush();
  assert.deepEqual(k.pasted, ['echo uno\necho dos']);
  assert.deepEqual(k.written, []);
});

test('without input, keys and Pegar do nothing and the clipboard is not read', async () => {
  const k = keyBar({ input: false, clipboard: 'rm -rf ~' });
  k.press('esc');
  k.emit('a');
  k.press('paste');
  await flush();
  assert.equal(k.reads(), 0);
  assert.deepEqual([k.written, k.pasted], [[], []]);
});

test('Copiar copies the selection, clears it and turns Selec. off; with nothing selected it copies nothing', () => {
  const k = keyBar({ selection: 'línea uno\nlínea dos' });
  k.press('select');
  assert.equal(k.selecting(), true);
  k.press('copy');
  assert.deepEqual(k.copied, ['línea uno\nlínea dos']);
  assert.equal(k.selected(), '');
  assert.equal(k.selecting(), false);
  k.press('copy');
  assert.equal(k.copied.length, 1);
});

/** A 10×4 screen at (100, 200), 10 px per cell, scrolled 50 lines into the buffer. */
function touchPage(active = true) {
  const host = new FakeNode();
  const screen = { getBoundingClientRect: () => ({ left: 100, top: 200, width: 100, height: 40 }) };
  const selections: [number, number, number][] = [];
  const term = {
    element: { querySelector: (selector: string) => (selector === '.xterm-screen' ? screen : null) },
    cols: 10, rows: 4, buffer: { active: { viewportY: 50 } },
    select: (col: number, row: number, length: number) => { selections.push([col, row, length]); },
  };
  let on = active;
  attachTouchSelection(host as unknown as HTMLElement, term as never, () => on);
  const touch = (type: string, x: number, y: number) => dispatch(host, type, { touches: [{ clientX: x, clientY: y }] });
  return { selections, touch, setActive: (value: boolean) => { on = value; } };
}

test('with Selec. on, a drag selects across lines in either direction and keeps the touch from scrolling', () => {
  const t = touchPage();
  const start = t.touch('touchstart', 135, 215); // column 3, row 1
  t.touch('touchmove', 125, 235); // column 2, row 3
  t.touch('touchmove', 115, 205); // column 1, row 0: before the anchor
  t.touch('touchend', 0, 0);
  assert.equal(start.defaultPrevented, true);
  assert.deepEqual(t.selections, [[3, 51, 1], [3, 51, 20], [1, 50, 13]]);
});

test('a touch outside the screen selects up to its edge', () => {
  const t = touchPage();
  t.touch('touchstart', 105, 205);
  t.touch('touchmove', 900, 900);
  assert.deepEqual(t.selections.at(-1), [0, 50, 40]);
});

test('with Selec. off, a touch scrolls as usual and selects nothing', () => {
  const t = touchPage(false);
  const start = t.touch('touchstart', 135, 215);
  t.touch('touchmove', 125, 235);
  assert.equal(start.defaultPrevented, false);
  assert.deepEqual(t.selections, []);
});
