// Android check: the lab viewer APK (react-native-webview) and the device's Chrome, against the
// servicios-puente lab. Needs the `android` lock, an emulator or phone in `device` state and the
// APK from viewer/build-android.sh.
//   node src/android.ts <serial> [webview|chrome|all]
//
// Names are *.relay-lab.localhost: Chromium resolves them to loopback itself, and `adb reverse`
// carries the lab ports to this machine. The viewer trusts the lab certificate through its own
// network security config. Chrome is driven over DevTools and told to ignore certificate errors
// only for that DevTools session; nothing is installed in the device trust store.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { _android as android, chromium, type Page } from 'playwright-core';
import { certFromPem } from './certs.ts';
import { startLab, type Lab } from './lab.ts';
import type { Result } from './scenario.ts';

const serial = process.argv[2];
const which = process.argv[3] ?? 'all';
if (!serial) throw new Error('usage: node src/android.ts <serial> [webview|chrome|all]');
const ADB = process.env.ADB ?? join(homedir(), 'Android/Sdk/platform-tools/adb');
const PKG = 'dev.relay.lab.webproxy';
const viewer = new URL('../viewer/', import.meta.url).pathname;
const APK = join(viewer, 'android/app/build/outputs/apk/release/app-release.apk');
const UPLOAD = 'datos-lab.bin';

const adb = (...args: string[]) => execFileSync(ADB, ['-s', serial, ...args], { encoding: 'utf8', timeout: 60000 });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const cert = certFromPem(readFileSync(join(viewer, '.lab-cert/cert.pem'), 'utf8'), readFileSync(join(viewer, '.lab-cert/key.pem'), 'utf8'));
let offset = 0;
const lab = await startLab('servicios-puente', { names: { parent: 'relay-lab.localhost', cdn: 'cdn.localhost' }, cert, now: () => Date.now() + offset });
const ports = [new URL(lab.origins.a).port, new URL(lab.origins.cdn).port];
for (const port of ports) adb('reverse', `tcp:${port}`, `tcp:${port}`);

const controlUrl = (path: string) => `http://127.0.0.1:${new URL(lab.origins.control).port}${path}`;
async function relayGrants(code: string) {
  const headers = { authorization: `Bearer ${lab.devices.movil}` };
  const list = (await (await fetch(controlUrl('/v1/web/apps/app-a/requests'), { headers })).json()) as { id: string; code: string }[];
  const found = list.find((r) => r.code === code);
  if (!found) throw new Error(`code ${code} not pending`);
  await fetch(controlUrl(`/v1/web/apps/app-a/requests/${found.id}/grant`), { method: 'POST', headers });
}

// Taps the first on-screen element whose text matches, using the accessibility dump.
function tapText(pattern: RegExp): boolean {
  adb('shell', 'uiautomator', 'dump', '/sdcard/relaylab-ui.xml');
  const xml = adb('shell', 'cat', '/sdcard/relaylab-ui.xml');
  for (const node of xml.matchAll(/<node [^>]*>/g)) {
    const text = /text="([^"]*)"/.exec(node[0])?.[1] ?? '';
    const desc = /content-desc="([^"]*)"/.exec(node[0])?.[1] ?? '';
    const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node[0]);
    if (bounds && (pattern.test(text) || pattern.test(desc))) {
      const [x1, y1, x2, y2] = bounds.slice(1).map(Number);
      adb('shell', 'input', 'tap', String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2)));
      return true;
    }
  }
  return false;
}

// Package of the activity in front, from the activity manager.
const resumed = () => adb('shell', 'dumpsys', 'activity', 'activities').match(/(?:topResumedActivity|mResumedActivity)[^\n]*\{[^ ]+ [^ ]+ ([^ /]+)/)?.[1] ?? '';

async function scenario(name: string, page: Page, opts: { pickerApp: string }): Promise<Result[]> {
  const results: Result[] = [];
  const a = lab.origins.a;
  async function check(id: string, label: string, fn: () => Promise<string>) {
    try {
      results.push({ id, label, pass: true, detail: await fn() });
    } catch (error) {
      results.push({ id, label, pass: false, detail: String((error as Error).message ?? error).split('\n')[0].slice(0, 300) });
    }
    console.log(`${results.at(-1)!.pass ? 'PASS' : 'FAIL'}  ${name} ${id.padEnd(12)} ${label}\n      ${results.at(-1)!.detail}`);
  }
  const expect = (ok: boolean, detail: string) => {
    if (!ok) throw new Error(detail);
    return detail;
  };

  await check('canje', 'Página de acceso, concesión desde Relay y canje en este navegador', async () => {
    const el = await page.waitForSelector('#codigo', { timeout: 15000 });
    const code = (await el.textContent())!.trim();
    await relayGrants(code);
    await page.waitForSelector('#deep-path', { timeout: 15000 });
    return `código ${code}; ruta=${await page.textContent('#deep-path')}`;
  });

  await check('recursos', 'Navegación, CSS, imagen, script propio y script externo permitido', async () => {
    await page.goto(`${a}/`);
    await page.waitForFunction(() => document.documentElement.dataset.js === 'ok', undefined, { timeout: 10000 });
    const color = await page.$eval('#app', (el) => getComputedStyle(el).color);
    const width = await page.$eval('#logo', (el) => (el as HTMLImageElement).naturalWidth);
    const cdn = await page.evaluate(() => document.documentElement.dataset.cdn);
    return expect(color === 'rgb(1, 2, 3)' && width === 10 && cdn === 'ok', `color=${color} imagen=${width}px externo=${cdn}`);
  });

  await check('streams', 'SSE y WebSocket de desarrollo por wss', async () => {
    await page.waitForFunction(() => Number(document.body.dataset.sse ?? 0) >= 3 && !!document.body.dataset.hmrAck, undefined, { timeout: 10000 });
    return `sse=${await page.evaluate(() => document.body.dataset.sse)} hmr=${await page.evaluate(() => document.body.dataset.hmrAck)}`;
  });

  await check('formulario', 'Formulario POST urlencoded', async () => {
    await page.goto(`${a}/formulario`);
    await page.click('#f button');
    await page.waitForSelector('#nota', { timeout: 10000 });
    return expect((await page.textContent('#nota')) === 'hola ñandú', `nota=${await page.textContent('#nota')}`);
  });

  await check('subida', 'Subida multipart con el selector de archivos del sistema', async () => {
    await page.goto(`${a}/formulario`);
    await sleep(1000);
    await page.click('#u input[type=file]', { noWaitAfter: true });
    await sleep(2500);
    const steps: string[] = [resumed()];
    let picked = false;
    // Camera permission (denied) → chooser → document picker → roots → Downloads → file.
    for (let i = 0; i < 8 && !picked; i += 1) {
      picked = tapText(new RegExp(`^${UPLOAD}$`));
      if (!picked && !tapText(/^(Don’t allow|Don't allow|No permitir)$/) && !tapText(/^(Downloads|Descargas)$/) && !tapText(/^(Show roots|Mostrar raíces)$/)) {
        tapText(/^(Photos &amp; videos|Files|Archivos|Fotos y videos)$/);
      }
      await sleep(1500);
      steps.push(resumed());
    }
    if (!picked) throw new Error(`no se encontró ${UPLOAD} en el selector (${[...new Set(steps)].join(' → ')})`);
    await sleep(1500);
    const value = await page.$eval('#u input[type=file]', (el) => (el as HTMLInputElement).files?.[0]?.name ?? '');
    await page.click('#u button', { noWaitAfter: true });
    const el = await page.waitForSelector('#upload', { timeout: 15000 });
    const size = Number(await el.getAttribute('data-size'));
    return expect(value === UPLOAD && size === 1024 * 1024, `selector: ${[...new Set(steps)].join(' → ')}; archivo=${value} tamaño recibido=${size}`);
  });

  await check('descarga', 'Descarga desde la página', async () => {
    const before = lab.gates!.a.log.length;
    adb('shell', 'rm', '-f', '/sdcard/Download/informe-app-a.txt');
    adb('logcat', '-c');
    await page.goto(`${a}/formulario`);
    await page.evaluate(() => { location.href = '/descarga'; });
    await sleep(6000);
    const gate = lab.gates!.a.log.slice(before).filter((l) => l.includes('/descarga'));
    const file = adb('shell', 'ls', '/sdcard/Download/').split('\n').filter((f) => f.startsWith('informe-app-a'));
    // A download stack that does not share the lab trust fails the TLS handshake (-202).
    const tls = (adb('logcat', '-d').match(/net_error -202/g) ?? []).length;
    return expect(file.length > 0, `Puente: ${gate.join(', ') || 'sin petición'}; archivo en Download: ${file.join(', ') || 'no'}; handshakes ERR_CERT_AUTHORITY_INVALID: ${tls}`);
  });

  await check('ventanas', name === 'webview'
    ? 'Ventanas nuevas: mismo origen se queda en el visor; web externa sale al navegador'
    : 'Ventanas nuevas: pestañas del mismo origen autorizadas; web externa en otra pestaña', async () => {
    const seen: string[] = [];
    for (const selector of ['#blank', '#abrir', '#externa']) {
      await page.goto(`${a}/ventanas`);
      await sleep(1000);
      if (name === 'webview') {
        await page.click(selector, { noWaitAfter: true });
        await sleep(3000);
        seen.push(`${selector}→${selector === '#externa' ? resumed() : page.url().replace(a, 'A')}`);
      } else {
        const [tab] = await Promise.all([page.context().waitForEvent('page'), page.click(selector, { noWaitAfter: true })]);
        await tab.waitForSelector('#deep-path, #externa', { timeout: 10000 }).catch(() => {});
        const marker = await tab.$('#deep-path, #externa');
        seen.push(`${selector}→${tab.url().replace(a, 'A').replace(lab.origins.cdn, 'CDN')}:${marker ? 'ok' : 'sin contenido'}`);
        await tab.close();
      }
    }
    if (name === 'webview') {
      adb('shell', 'am', 'start', '-n', opts.pickerApp);
      await sleep(1500);
      return expect(seen[0].endsWith('A/deep/nueva') && seen[1].endsWith('A/deep/popup') && !seen[2].endsWith(`→${PKG}`) && !seen[2].endsWith('→'), seen.join(' | '));
    }
    return expect(seen[0] === '#blank→A/deep/nueva:ok' && seen[1] === '#abrir→A/deep/popup:ok' && seen[2] === '#externa→CDN/pagina:ok', seen.join(' | '));
  });

  await check('revocar', 'Revocar corta SSE y WebSocket abiertos', async () => {
    await page.goto(`${a}/`);
    await page.waitForFunction(() => Number(document.body.dataset.sse ?? 0) >= 2 && !!document.body.dataset.hmrAck, undefined, { timeout: 10000 });
    await fetch(controlUrl('/v1/web/apps/app-a/revoke'), { method: 'POST', headers: { authorization: `Bearer ${lab.devices.movil}` } });
    await page.waitForFunction(() => document.body.dataset.sseError === '1' && document.body.dataset.hmrClosed === '1', undefined, { timeout: 10000 });
    await page.reload();
    await page.waitForSelector('#codigo', { timeout: 10000 });
    return 'streams cortados; recarga muestra acceso';
  });
  return results;
}

const all: Result[] = [];
adb('shell', `head -c 1048576 /dev/urandom > /sdcard/Download/${UPLOAD}`);
adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file:///sdcard/Download/${UPLOAD}`);
const model = adb('shell', 'getprop', 'ro.product.model').trim();
console.log(`dispositivo ${serial}: ${model} Android ${adb('shell', 'getprop', 'ro.build.version.release').trim()}`);
console.log(`WebView: ${adb('shell', 'dumpsys', 'webviewupdate').match(/Current WebView package \(name, version\): \(([^)]*)\)/)?.[1]}`);

try {
  if (which !== 'chrome') {
    adb('install', '-r', APK);
    adb('shell', 'am', 'force-stop', PKG);
    adb('shell', 'pm', 'clear', PKG);
    const deep = `relaylabweb://abrir?url=${encodeURIComponent(`${lab.origins.a}/deep/a/b/c?x=1`)}`;
    adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', `'${deep}'`, PKG);
    // Playwright tracks WebView sockets per process: look the device up after the app restarted.
    await sleep(3000);
    const [device] = (await android.devices()).filter((d) => d.serial() === serial);
    const webview = await device.webView({ pkg: PKG }, { timeout: 20000 });
    const page = await webview.page();
    console.log('visor conectado por DevTools');
    all.push(...await scenario('webview', page, { pickerApp: `${PKG}/.MainActivity` }));
  }
  if (which !== 'webview') {
    const chrome = 'com.android.chrome';
    const version = adb('shell', 'dumpsys', 'package', chrome).match(/versionName=(\S+)/)?.[1];
    console.log(`Chrome: ${version ?? 'no instalado'}`);
    adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${lab.origins.a}/deep/a/b/c?x=1'`, chrome);
    await sleep(15000); // a cold Chrome needs this long before DevTools answers
    const port = adb('forward', 'tcp:0', 'localabstract:chrome_devtools_remote').trim();
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true });
    const context = browser.contexts()[0];
    const page = context.pages().find((p) => p.url().includes('relay-lab')) ?? context.pages()[0];
    // File choosers only open for the tab in front.
    await page.bringToFront();
    await page.goto(`${lab.origins.a}/deep/a/b/c?x=1`);
    all.push(...await scenario('chrome', page, { pickerApp: `${chrome}/com.google.android.apps.chrome.Main` }));
    await cdp.send('Security.setIgnoreCertificateErrors', { ignore: false });
    adb('forward', '--remove', `tcp:${port}`);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const port of ports) adb('reverse', '--remove', `tcp:${port}`);
  adb('shell', 'rm', '-f', `/sdcard/Download/${UPLOAD}`, '/sdcard/relaylab-ui.xml');
  await lab.close();
  console.log(`\n${all.filter((r) => r.pass).length}/${all.length} PASS`);
  process.exit(process.exitCode ?? (all.length && all.every((r) => r.pass) ? 0 : 1));
}
