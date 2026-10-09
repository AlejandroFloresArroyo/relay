// Renders a design file in headless Chromium and saves, for every canvas (each element with a
// data-screen-label), a PNG and the rendered HTML, plus an index of labels. No dependencies: it speaks the DevTools protocol
// over Node's built-in WebSocket.
//
//   node design/tools/capture.mjs design/source/relay-instrumento-2.dc.html design/captures/instrumento-2 [label-regex]
//
// With --select <page-script.js>, the script tags the canvases instead (it sets data-screen-label, and optionally
// data-capture-title and data-capture-notes), and every capture also gets <label>.txt with its computed values
// followed by its notes:
//
//   node design/tools/capture.mjs --select design/tools/rediseno.js design/source/relay-rediseno.dc.html design/captures/rediseno
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const selectAt = args.indexOf('--select');
const select = selectAt >= 0 ? await readFile(args.splice(selectAt, 2)[1], 'utf8') : null;
const [source, outDir, only] = args;
if (!source || !outDir) {
  console.error('usage: capture.mjs [--select page-script.js] <design.dc.html> <out-dir> [label-regex]');
  process.exit(2);
}

// One line per element with its own text or a visible box, indented by nesting; positions relative to the capture.
const VALUES = `((root) => {
  const R = root.getBoundingClientRect();
  const rgb = /rgba?\\(([^)]+)\\)/g;
  const hex = (c) => c.replace(rgb, (_, body) => {
    const [r, g, b, a] = body.split(',').map((s) => parseFloat(s));
    const h = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    return a !== undefined && a < 1 ? h + '/' + +a.toFixed(3) : h;
  });
  const out = [];
  const walk = (el, depth) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) return;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).filter(Boolean).join(' ');
    const box = [];
    if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)') box.push('bg ' + hex(cs.backgroundColor));
    if (cs.backgroundImage !== 'none') box.push('bgimg ' + hex(cs.backgroundImage));
    if (cs.borderTopLeftRadius !== '0px') box.push('r ' + cs.borderTopLeftRadius);
    if (cs.boxShadow !== 'none') box.push('shadow ' + hex(cs.boxShadow));
    if (cs.borderTopWidth !== '0px' && cs.borderTopStyle !== 'none') box.push('border ' + cs.borderTopWidth + ' ' + hex(cs.borderTopColor));
    if (cs.animationName !== 'none') box.push('anim ' + cs.animationName + ' ' + cs.animationDuration + ' ' + cs.animationTimingFunction + ' delay ' + cs.animationDelay);
    if (cs.opacity !== '1') box.push('op ' + cs.opacity);
    const pos = Math.round(r.left - R.left) + ',' + Math.round(r.top - R.top) + ' ' + Math.round(r.width) + '×' + Math.round(r.height);
    const tail = box.length ? ' | ' + box.join(' · ') : '';
    if (own) {
      const fam = /Martian/.test(cs.fontFamily) ? 'Mono' : /Hanken/.test(cs.fontFamily) ? 'Hanken' : cs.fontFamily.split(',')[0];
      const ls = cs.letterSpacing === 'normal' ? '' : ' ls ' + cs.letterSpacing;
      const tt = cs.textTransform !== 'none' ? ' ' + cs.textTransform : '';
      const ts = cs.textShadow !== 'none' ? ' tshadow ' + hex(cs.textShadow) : '';
      out.push('  '.repeat(depth) + '"' + own + '" ' + fam + ' ' + cs.fontSize + '/' + cs.fontWeight + ls + tt + ' ' + hex(cs.color) + ts + ' @' + pos + tail);
    } else if (box.length) {
      out.push('  '.repeat(depth) + '[' + el.tagName.toLowerCase() + '] @' + pos + tail);
    }
    for (const c of el.children) walk(c, depth + (own || box.length ? 1 : 0));
  };
  walk(root, 0);
  return out.join(String.fromCharCode(10));
})`;
const PORT = 9300 + Math.floor(Math.random() * 500);
const profile = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'relay-capture-'));
const chromium = spawn(
  process.env.CHROMIUM || 'chromium',
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--hide-scrollbars',
    '--allow-file-access-from-files', '--window-size=1600,1200', 'about:blank'],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function target() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((entry) => entry.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chromium is still starting
    }
    await sleep(200);
  }
  throw new Error('Chromium did not open a DevTools port');
}

let exitCode = 0;
try {
  const ws = new WebSocket(await target());
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };

  await send('Page.enable');
  await send('Page.navigate', { url: pathToFileURL(path.resolve(source)).href });

  // The file builds part of its canvases from templates at load time: wait until the count settles.
  let count = -1;
  for (let stable = 0, attempt = 0; attempt < 60 && stable < 4; attempt++) {
    await sleep(500);
    const now = await evaluate(select ?? `document.querySelectorAll('[data-screen-label]').length`);
    stable = now === count && now > 0 ? stable + 1 : 0;
    count = now;
  }
  await evaluate(`document.fonts.ready.then(() => true)`);
  await sleep(500);
  // Same output on every run: load every font subset and freeze animations at their start (the .txt still names them).
  if (select) {
    await evaluate(`Promise.all([...document.fonts].map((f) => f.load())).then(() => true)`);
    await evaluate(`document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 0; })`);
    await sleep(500);
  }

  const screens = await evaluate(`(() => {
    const seen = new Map();
    return [...document.querySelectorAll('[data-screen-label]')].map((el, index) => {
      const label = el.getAttribute('data-screen-label');
      const n = (seen.get(label) || 0) + 1; seen.set(label, n);
      el.setAttribute('data-capture-index', String(index));
      const r = el.getBoundingClientRect();
      const title = el.getAttribute('data-capture-title') ?? (el.innerText || '').split(String.fromCharCode(10)).map((line) => line.trim()).filter(Boolean).slice(0, 2).join(' ');
      return { index, label, repeat: n, title, x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
    });
  })()`);

  await mkdir(outDir, { recursive: true });
  const filter = only ? new RegExp(only) : null;
  const index = [];
  for (const screen of screens) {
    if (filter && !filter.test(screen.label)) continue;
    if (screen.width < 2 || screen.height < 2) {
      index.push({ label: screen.label, file: null, note: 'not rendered (zero size)' });
      continue;
    }
    const slug = screen.label.replace(/·/g, '-').replace(/[^0-9A-Za-z-]+/g, '_') + (screen.repeat > 1 ? `_${screen.repeat}` : '');
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: screen.x, y: screen.y, width: screen.width, height: screen.height, scale: 1 },
    });
    await writeFile(path.join(outDir, `${slug}.png`), Buffer.from(shot.data, 'base64'));
    const html = await evaluate(`document.querySelector('[data-capture-index="${screen.index}"]').outerHTML`);
    await writeFile(path.join(outDir, `${slug}.html`), html + '\n');
    const entry = { label: screen.label, title: screen.title, file: `${slug}.png`, html: `${slug}.html`, width: Math.round(screen.width), height: Math.round(screen.height) };
    if (select) {
      const [values, notes] = await evaluate(`(() => {
        const el = document.querySelector('[data-capture-index="${screen.index}"]');
        return [${VALUES}(el), JSON.parse(el.getAttribute('data-capture-notes') || '[]')];
      })()`);
      await writeFile(path.join(outDir, `${slug}.txt`), [values, ...(notes.length ? ['', '--- PIE Y NOTAS ---', ...notes] : [])].join('\n') + '\n');
      entry.txt = `${slug}.txt`;
    }
    index.push(entry);
  }
  await writeFile(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  console.log(`${index.filter((entry) => entry.file).length} captures, ${index.filter((entry) => !entry.file).length} skipped, of ${screens.length} canvases`);
  ws.close();
} catch (error) {
  console.error(error.message);
  exitCode = 1;
} finally {
  chromium.kill();
  await sleep(300);
  await rm(profile, { recursive: true, force: true });
}
process.exit(exitCode);
