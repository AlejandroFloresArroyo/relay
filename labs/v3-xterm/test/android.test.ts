// Acceptance suite for xterm inside the Expo 57 DOM WebView on Android. Needs the lab APK
// installed and ANDROID_SERIAL pointing at an authorized device. LAB_CONFIG picks the
// configuration under test (`baseline` or `relay`).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { LAB_DEVICE_KEY, LAB_FILE_CANARY, LAB_FILE_CANARY_NAME } from '../src/fixture.ts';
import {
  adb,
  assertDevice,
  hardKeys,
  hardText,
  keyboardShown,
  labLog,
  lastSize,
  launch,
  lines,
  PKG,
  type Page,
  received,
  tap,
  waitFor,
  webViewBounds,
} from './device.ts';

const CONFIG = process.env.LAB_CONFIG ?? 'relay';
const SCROLLBACK = 5000;
const QUEUE_BOUND = 256 * 1024 + 32 * 1024;

// Gboard, Spanish layout (ES • EN), portrait, on the 1080x2400 / 420 dpi emulator profile with
// no hardware keyboard. Measured from a screenshot; other screens need their own map, so the
// tests that tap it only run with LAB_GBOARD=1.
const GBOARD = process.env.LAB_GBOARD === '1';
const GBOARD_ES = (() => {
  const unit = 1080 / 706;
  const keys: Record<string, [number, number]> = {};
  [...'qwertyuiop'].forEach((k, i) => (keys[k] = [(38 + i * 70) * unit, 1120 * unit]));
  [...'asdfghjklñ'].forEach((k, i) => (keys[k] = [(38 + i * 70) * unit, 1220 * unit]));
  [...'zxcvbnm'].forEach((k, i) => (keys[k] = [(143 + i * 70) * unit, 1322 * unit]));
  keys[' '] = [387 * unit, 1424 * unit];
  keys['⌫'] = [650 * unit, 1322 * unit];
  keys['⏎'] = [650 * unit, 1424 * unit];
  return keys;
})();

// `á` is a long press on `a`: Gboard ES opens its accent popup with `á` highlighted, and lifting
// the finger without moving commits it.
function gboard(text: string) {
  for (const key of text) {
    const position = GBOARD_ES[key === 'á' ? 'a' : key];
    assert.ok(position, `no Gboard position for ${key}`);
    if (key !== 'á') {
      tap(...position);
      continue;
    }
    const [x, y] = position.map((value) => String(Math.round(value)));
    adb('shell', 'input', 'swipe', x, y, x, y, '1000');
  }
}

let page: Page;

before(() => {
  assertDevice();
  adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
  adb('shell', 'settings', 'put', 'system', 'user_rotation', '0');
});

after(() => {
  page?.close();
  adb('shell', 'settings', 'put', 'system', 'user_rotation', '0');
});

async function open() {
  page?.close();
  page = await launch(CONFIG);
}

// Drives the shell without involving the keyboard, for tests about output and screen state.
async function command(text: string) {
  await page.eval(`window.__lab.term.input(${JSON.stringify(text + '\r')}, true)`);
}

async function screenText() {
  return (await page.screen()).join('\n');
}

async function size() {
  return page.eval<{ cols: number; rows: number }>('({ cols: __lab.term.cols, rows: __lab.term.rows })');
}

// Centre of a DOM element in screen pixels.
async function elementCenter(selector: string): Promise<[number, number]> {
  const box = await page.eval<{ x: number; y: number; dpr: number } | null>(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: devicePixelRatio };
  })()`);
  assert.ok(box, `${selector} is not on the page`);
  const view = webViewBounds();
  return [view.left + box.x * box.dpr, view.top + box.y * box.dpr];
}

async function focusWithTouch() {
  const view = webViewBounds();
  tap((view.left + view.right) / 2, view.top + 200);
  await waitFor('soft keyboard', keyboardShown, 5000);
  await sleep(500);
}

async function hideKeyboard() {
  if (!keyboardShown()) return;
  adb('shell', 'input', 'keyevent', 'BACK');
  await waitFor('keyboard hidden', () => !keyboardShown(), 5000);
}

test('boundary: the WebView never holds the device key nor reaches native modules', async () => {
  await open();
  assert.equal(await page.eval('location.protocol'), 'file:');
  assert.equal(await page.eval('typeof globalThis.expo?.modules'), 'undefined');
  // The Expo bridge is always attached to the page; it must refuse to evaluate host code.
  assert.equal(
    await page.eval(`ExpoDomWebViewBridge.eval(JSON.stringify({ deferredId: 1, source: '1 + 1' }))`),
    '{"isPromise":false,"value":null}',
  );
  await command('size');
  await waitFor('authenticated round trip', async () => (await screenText()).includes('SIZE cols='));
  assert.ok(!(await page.eval<string>('ReactNativeWebView.injectedObjectJson()')).includes(LAB_DEVICE_KEY));
  assert.ok(!(await page.eval<string>('document.documentElement.outerHTML')).includes(LAB_DEVICE_KEY));
  assert.ok(!(await page.heapSnapshot()).includes(LAB_DEVICE_KEY), 'device key found in the WebView heap');
});

// Records an open vector, not a guarantee: @expo/dom-webview 57 forces allowFileAccess and
// allowFileAccessFromFileURLs on, so a script in the file:// page reads the app's private
// storage. Asserts what was observed; it fails the day Expo closes that access, and then the
// research document must change too.
test('boundary: the page can read a plain file in the app\'s private files/ (open vector)', async () => {
  await open();
  const url = `file:///data/data/${PKG}/files/${LAB_FILE_CANARY_NAME}`;
  const read = await page.eval<string>(`(() => {
    const xhr = new XMLHttpRequest();
    try { xhr.open('GET', ${JSON.stringify(url)}, false); xhr.send(); return 'read: ' + xhr.responseText; }
    catch (error) { return 'blocked: ' + error.name; }
  })()`);
  console.log(`files/ canary from the page: ${read}`);
  assert.equal(read, `read: ${LAB_FILE_CANARY}`);
});

// Needs an AVD with hw.keyboard=yes: `emu event text` only reaches the qwerty2 device then.
const HW = process.env.LAB_HW_KEYBOARD === '1';

test('hardware keyboard: text, Backspace, Enter, Esc, Tab, arrows, Ctrl and Alt', { skip: !HW && 'LAB_HW_KEYBOARD=1 not set' }, async () => {
  await open();
  await focusWithTouch();
  await hideKeyboard();
  hardText('lsx');
  for (const key of ['DEL', 'ENTER', 'ESCAPE', 'TAB', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_RIGHT', 'DPAD_LEFT']) hardKeys(key);
  hardKeys('CTRL_LEFT', 'C');
  hardKeys('ALT_LEFT', 'X');
  const expected = 'lsx\x7f\r\x1b\t\x1b[A\x1b[B\x1b[C\x1b[D\x03\x1bx';
  await waitFor('keys at the shell', () => received().length >= expected.length);
  assert.equal(received(), expected);
  assert.deepEqual(lines(), ['ls']);
});

// Gboard in this WebView commits key by key (keyCode 229 + insertText, no composition events,
// with or without suggestions); a glide-typed word arrives as one insertText.
for (let attempt = 1; attempt <= 3; attempt++) {
  test(`Gboard Spanish: letters, ñ, delete and Enter arrive once (attempt ${attempt})`, { skip: !GBOARD && 'LAB_GBOARD=1 not set' }, async () => {
    await open();
    await focusWithTouch();
    gboard('cancion ano⌫⌫ño⏎');
    await waitFor('line', () => lines().length > 0);
    await sleep(500);
    const got = lines();
    console.log(`Gboard line: ${JSON.stringify(got)}`);
    assert.deepEqual(got, ['cancion año']);
  });

  // Exactly one DEL for the `á` (one character, not one UTF-16 unit or one byte) and nothing
  // after Enter: `baseline` sometimes sends a stray DEL there.
  test(`Gboard Spanish: long-press á and Backspace over it arrive once (attempt ${attempt})`, { skip: !GBOARD && 'LAB_GBOARD=1 not set' }, async () => {
    await open();
    await focusWithTouch();
    gboard('está⌫á⏎');
    await waitFor('line', () => lines().length > 0);
    await sleep(500);
    const bytes = received();
    console.log(`Gboard accent: line ${JSON.stringify(lines())}, bytes ${JSON.stringify(bytes).replaceAll('\x7f', '\\x7f')}`);
    assert.deepEqual(lines(), ['está']);
    assert.equal(bytes, 'está\x7fá\r');
  });
}

test('soft keyboard: rows shrink to the visible area and the PTY follows', async () => {
  await open();
  const closed = await size();
  await focusWithTouch();
  const open_ = await waitFor('rows to shrink', async () => {
    const now = await size();
    return now.rows < closed.rows && now;
  });
  assert.equal(open_.cols, closed.cols);
  await waitFor('PTY size', () => lastSize()?.rows === open_.rows);
  const cursorBottom = await page.eval<number>(
    '(() => { const t = __lab.term; const s = t.element.querySelector(".xterm-screen").getBoundingClientRect(); return s.top + (t.buffer.active.cursorY + 1) * (s.height / t.rows); })()',
  );
  assert.ok(cursorBottom <= (await page.eval<number>('innerHeight')), 'cursor row hidden behind the keyboard');
  await hideKeyboard();
  await waitFor('rows restored', async () => (await size()).rows === closed.rows);
});

test('rotation and full screen: the terminal fills the window in both orientations', async () => {
  await open();
  const [physicalW, physicalH] = adb('shell', 'wm', 'size').match(/(\d+)x(\d+)/)!.slice(1).map(Number);
  const fills = async (rotated: boolean) => {
    // The WebView spans the whole display width and reaches its bottom edge.
    const view = webViewBounds();
    const [displayW, displayH] = rotated ? [physicalH, physicalW] : [physicalW, physicalH];
    assert.equal(view.right - view.left, displayW);
    assert.equal(view.bottom, displayH);
    // xterm uses the whole host but a scrollbar and less than one cell.
    const fit = await page.eval<{ width: number; height: number; cellW: number; cellH: number }>(`(() => {
      const t = __lab.term, host = t.element.parentElement.getBoundingClientRect();
      const s = t.element.querySelector(".xterm-screen").getBoundingClientRect();
      const bar = t.element.querySelector(".scrollbar.vertical")?.getBoundingClientRect().width ?? 0;
      return { width: host.width - bar - s.width, height: host.height - s.height, cellW: s.width / t.cols, cellH: s.height / t.rows };
    })()`);
    assert.ok(fit.width >= 0 && fit.width < fit.cellW, `unused width ${fit.width}`);
    assert.ok(fit.height >= 0 && fit.height < fit.cellH, `unused height ${fit.height}`);
  };
  // Natural orientation is portrait on a phone and landscape on a tablet.
  const natural = await size();
  await fills(false);
  adb('shell', 'settings', 'put', 'system', 'user_rotation', '1');
  try {
    const rotated = await waitFor('rotated size', async () => {
      const now = await size();
      const wider = now.cols > natural.cols && now.rows < natural.rows;
      const taller = now.cols < natural.cols && now.rows > natural.rows;
      return (wider || taller) && now;
    });
    await waitFor('PTY size', () => lastSize()?.cols === rotated.cols);
    await fills(true);
  } finally {
    adb('shell', 'settings', 'put', 'system', 'user_rotation', '0');
  }
  await waitFor('natural orientation again', async () => (await size()).cols === natural.cols);
});

test('alternate screen: a full-screen program draws every row and the shell comes back', async () => {
  await open();
  await command('size');
  await waitFor('marker', async () => (await screenText()).includes('SIZE cols='));
  await command('alt');
  await waitFor('alternate buffer', () => page.eval('__lab.term.buffer.active.type === "alternate"'));
  const { cols, rows } = await size();
  const screen = await waitFor('box drawn', async () => {
    const now = await page.screen();
    return now.at(-1)?.startsWith('└') && now;
  });
  assert.equal(screen.length, rows);
  assert.ok(screen[0].startsWith('┌'));
  assert.ok(screen[1].includes(`ALT cols=${cols} rows=${rows}`));
  await command('noalt');
  await waitFor('normal buffer', () => page.eval('__lab.term.buffer.active.type === "normal"'));
  assert.match(await screenText(), /SIZE cols=/);
});

test('sustained output: 100 000 lines arrive intact with bounded queues and scrollback', async () => {
  await open();
  const started = Date.now();
  await command('flood 100000');
  await waitFor('END', async () => (await screenText()).includes('END lines=100000'), 180_000);
  const seconds = (Date.now() - started) / 1000;
  const native = await waitFor('native totals', () => {
    const line = labLog().findLast((l) => l.startsWith('LAB queue '));
    const match = line?.match(/total=(\d+) hash=([0-9a-f]+) max=(\d+)/);
    return match && Number(match[1]) > 100_000 * 70 && match;
  });
  const dom = await waitFor('DOM caught up', async () => {
    const stats = await page.eval<{ received: number; hash: number }>('__lab.stats');
    return stats.received === Number(native[1]) && stats;
  });
  assert.equal(dom.hash.toString(16), native[2], 'output corrupted between native and DOM');
  assert.ok(Number(native[3]) <= QUEUE_BOUND, `native queue peaked at ${native[3]}`);
  const { rows } = await size();
  assert.ok((await page.eval<number>('__lab.term.buffer.active.length')) <= rows + SCROLLBACK);
  console.log(`flood: ${native[1]} chars in ${seconds.toFixed(1)} s, native queue max ${native[3]}`);
});

test('Ctrl-C under an endless flood: its echo is on screen within 1 s of the key', async () => {
  await open();
  await focusWithTouch();
  await hideKeyboard();
  await command('flood 100000000');
  await waitFor('flood running', async () => (await page.eval<number>('__lab.stats.received')) > 1_000_000, 30_000);
  // Timed in the page: from xterm emitting ^C to the shell's ^C echo parsed behind the output
  // already queued. ADB and DevTools polling would add their own latency.
  await page.eval(`(() => {
    const t = __lab.term, at = (window.__ctrlc = {});
    t.onData((d) => { if (d === '\\x03') at.sent = performance.now(); });
    t.onWriteParsed(() => {
      if (!at.sent || at.shown) return;
      const b = t.buffer.active;
      for (let i = b.baseY; i < b.length; i++) if (b.getLine(i).translateToString().includes('^C')) at.shown = performance.now();
    });
  })()`);
  hardKeys('CTRL_LEFT', 'C');
  await waitFor('^C at the shell', () => received().includes('\x03'), 10_000);
  const latency = await waitFor('^C echoed', () => page.eval<number | null>('__ctrlc.shown && __ctrlc.shown - __ctrlc.sent'), 10_000);
  console.log(`Ctrl-C: echo on screen ${Math.round(latency)} ms after the key`);
  assert.ok(latency < 1000, `Ctrl-C echo after ${latency} ms`);
});

async function setClipboard(text: string) {
  await page.eval(`navigator.clipboard.writeText(${JSON.stringify(text)})`, true);
}

test('hardware keyboard: Ctrl+V stays ^V; Ctrl+Shift+V pastes several lines without adding Enter', async () => {
  await open();
  await focusWithTouch();
  await hideKeyboard();
  await setClipboard('uno\ndos');
  hardKeys('CTRL_LEFT', 'V');
  hardKeys('CTRL_LEFT', 'SHIFT_LEFT', 'V');
  await waitFor('paste', () => received().includes('dos'));
  await sleep(500);
  assert.equal(received(), '\x16uno\rdos');
  await command('');
  await command('bpon');
  await sleep(300);
  hardKeys('CTRL_LEFT', 'SHIFT_LEFT', 'V');
  await waitFor('bracketed paste', () => received().includes('\x1b[201~'));
  assert.ok(received().endsWith('\x1b[200~uno\rdos\x1b[201~'));
});

test('touch: Pegar pastes the Android clipboard with the soft keyboard open', async () => {
  await open();
  await focusWithTouch();
  await setClipboard('ls -la\necho ñandú');
  tap(...(await elementCenter('[data-key="paste"]')));
  await waitFor('paste', () => received().includes('ñandú'));
  assert.equal(received(), 'ls -la\recho ñandú');
  assert.ok(keyboardShown(), 'keyboard closed by the paste button');
});

test('touch: Selec. drags a selection across lines and Copiar puts it on the clipboard', async () => {
  await open();
  await command('size');
  await command('size');
  await waitFor('two lines', async () => (await screenText()).match(/SIZE/g)?.length === 2);
  const view = webViewBounds();
  const cell = await page.eval<{ w: number; h: number; top: number; dpr: number }>(`(() => {
    const t = __lab.term, s = t.element.querySelector(".xterm-screen").getBoundingClientRect();
    return { w: s.width / t.cols, h: s.height / t.rows, top: s.top, dpr: devicePixelRatio };
  })()`);
  const at = (col: number, row: number) => [
    String(Math.round(view.left + (col + 0.5) * cell.w * cell.dpr)),
    String(Math.round(view.top + (cell.top + (row + 0.5) * cell.h) * cell.dpr)),
  ];
  // Rows 1 and 3 hold the two SIZE lines (row 0 and 2 are the commands). The drag starts at
  // column 10 and ends at column 0: a drag that starts at the screen edge is taken by the
  // system back gesture (touchcancel after two touchmoves).
  tap(...(await elementCenter('[data-key="select"]')));
  await sleep(300);
  adb('shell', 'input', 'swipe', ...at(10, 3), ...at(0, 1), '600');
  const selection = await waitFor('selection across lines', async () => {
    const text = await page.eval<string>('__lab.term.getSelection()');
    return /^SIZE cols=.*\n.*\nSIZE/s.test(text) && text;
  }, 3000);
  tap(...(await elementCenter('[data-key="copy"]')));
  await waitFor('copied', () => labLog().some((l) => l.startsWith('LAB copied ')));
  // Round trip through the Android clipboard into the shell.
  await focusWithTouch();
  tap(...(await elementCenter('[data-key="paste"]')));
  await waitFor('pasted', () => received().includes('SIZE'));
  assert.ok(received().endsWith(selection.replace(/\n/g, '\r')));
});

test('accessory keys for the soft keyboard: Esc, Tab, arrows, Ctrl and Alt keep the keyboard open', async () => {
  await open();
  await focusWithTouch();
  for (const key of ['esc', 'tab', 'up', 'down', 'left', 'right']) tap(...(await elementCenter(`[data-key="${key}"]`)));
  tap(...(await elementCenter('[data-key="ctrl"]')));
  await waitFor('Ctrl armed', () => page.eval('document.querySelector(\'[data-key="ctrl"]\').style.background !== "rgb(44, 44, 46)"'));
  await page.send('Input.insertText', { text: 'c' });
  tap(...(await elementCenter('[data-key="alt"]')));
  await waitFor('Alt armed', () => page.eval('document.querySelector(\'[data-key="alt"]\').style.background !== "rgb(44, 44, 46)"'));
  await page.send('Input.insertText', { text: 'x' });
  const expected = '\x1b\t\x1b[A\x1b[B\x1b[D\x1b[C\x03\x1bx';
  await waitFor('keys', () => received().length >= expected.length);
  assert.equal(received(), expected);
  assert.ok(keyboardShown(), 'keyboard closed by an accessory key');
});
