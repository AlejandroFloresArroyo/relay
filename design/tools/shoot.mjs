// Screenshots each route of the web demo at phone and tablet sizes, in light and dark, over the
// DevTools protocol. No dependencies, like capture.mjs.
//
//   node design/tools/shoot.mjs <base-url> <out-dir> [claro|oscuro]
//
// Leaves <out-dir>/claro/<size>-<route>.png and <out-dir>/oscuro/<size>-<route>.png; the third
// argument shoots only one theme.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const [base, outDir, only] = process.argv.slice(2);
// The web demo keeps its theme preference under this localStorage key (mobile/src/core/theme.ts).
const THEMES = [['claro', 'light'], ['oscuro', 'dark']].filter(([name]) => !only || name === only);
if (!base || !outDir || !THEMES.length) {
  console.error('usage: shoot.mjs <base-url> <out-dir> [claro|oscuro]');
  process.exit(2);
}
const ROUTES = [
  ['01-agentes', '/agents'],
  ['02-aprobaciones', '/approvals'],
  ['03-servidores', '/servers'],
  ['04-ajustes', '/settings'],
  ['05-conectar', '/connect'],
  ['06-tablero', '/board'],
  ['07-servidor', '/server/atlas'],
  ['08-chat-dev', '/chat/atlas/dev'],
  ['09-chat-research', '/chat/atlas/research'],
  ['10-agente-ficha', '/agent/atlas/dev'],
  ['11-agente-memoria', '/agent/atlas/dev/memory'],
  ['12-agente-soul', '/agent/atlas/dev/soul'],
  ['13-agente-herramientas', '/agent/atlas/dev/tools'],
  ['14-agente-skills', '/agent/atlas/dev/skills'],
  ['15-tareas', '/jobs'],
  ['16-uso', '/usage/atlas'],
  ['17-trabajo', '/work'],
  ['18-personalidades', '/presets/atlas'],
  ['19-notificaciones', '/notifications/atlas'],
  ['20-actualizacion-apk', '/app-update/atlas'],
  ['21-herramientas', '/tools'],
  ['21b-herramientas-atlas', '/tools/atlas'],
  ['22-compartir', '/share'],
  ['23-widget', '/widget-preview'],
  ['24-maquinaria', '/machinery-preview'],
];
const SIZES = [['phone', 390, 844, 3], ['tablet', 1280, 800, 2]];

const PORT = 9800 + Math.floor(Math.random() * 100);
const BROWSER = process.env.CHROMIUM || 'chromium';
const profile = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'relay-shoot-'));
const chromium = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
let startError = null;
chromium.on('error', (error) => { startError = error; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((r, j) => { const n = ++id; pending.set(n, { r, j }); ws.send(JSON.stringify({ id: n, method, params })); });

// Every page must render text before its shot; a page that stays blank stops the run.
async function rendered(route) {
  for (let waited = 0; waited < 120000; waited += 250) {
    const { result } = await send('Runtime.evaluate', { expression: "(document.getElementById('root')?.innerText ?? '').trim().length > 0 && document.fonts.status === 'loaded'", returnByValue: true });
    if (result.value) return;
    await sleep(250);
  }
  throw new Error(`página en blanco: ${route}`);
}

// Text in the DOM can still paint an empty screen, so the PNG itself is checked and the route reloaded.
async function shot(route, pixels) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await send('Page.navigate', { url: base + route });
    await rendered(route);
    await sleep(1500 + attempt * 3000); // entrance animations and the demo's first reading settle
    const png = Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
    // ponytail: a near-uniform screen compresses to <0.005 bytes per pixel and real screens to >0.029;
    // decode the pixels if a sparse screen ever falls under the line.
    if (png.length / pixels > 0.01) return png;
    console.error(`captura en blanco, reintento: ${route}`);
  }
  throw new Error(`página en blanco: ${route}`);
}

try {
  let wsUrl;
  for (let i = 0; i < 50 && !wsUrl && !startError; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; }
    catch { /* Chromium is still starting */ }
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error(`Chromium no arrancó (${BROWSER}): ${startError?.message ?? 'no abrió el puerto de DevTools'}`);
  ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error(`no se pudo conectar con Chromium en ${wsUrl}`)); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') console.error('error en la página:', m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console.error('error en consola:', m.params.args.map((a) => a.value ?? a.description).join(' '));
    const w = pending.get(m.id); if (w) { pending.delete(m.id); m.error ? w.j(new Error(m.error.message)) : w.r(m.result); }
  };
  await send('Page.enable'); await send('Runtime.enable');
  // A cold dev server bundles on the first visit, so that visit only warms it up.
  await send('Page.navigate', { url: base + ROUTES[0][1] }); await rendered(ROUTES[0][1]); await sleep(5000);
  for (const [theme, preference] of THEMES) {
    const dir = path.join(outDir, theme);
    await mkdir(dir, { recursive: true });
    const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('relay.theme.v1', ${JSON.stringify(JSON.stringify(preference))});` });
    for (const [size, width, height, scale] of SIZES) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: size === 'phone' });
      for (const [name, route] of ROUTES) {
        const file = path.join(dir, `${size}-${name}.png`);
        await writeFile(file, await shot(route, width * height * scale * scale));
        console.log(file);
      }
    }
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  }
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  ws?.close(); chromium.kill();
}
