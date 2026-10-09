// Browser scenario run with a real Chromium against one lab configuration. Every check records
// what it observed; nothing is skipped when an earlier step fails, so a failing configuration
// shows exactly which guarantees it breaks.
//
// The browser profile is throwaway: hostnames map to loopback and only the lab certificate's
// key is accepted (SPKI pin flag). Requests to any origin outside the lab are blocked and
// recorded, standing in for a phone that cannot reach the Server's loopback ports.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import type { Lab } from './lab.ts';
import { GRANT_MS, PENDING_COOKIE, SESSION_COOKIE } from './webGate.ts';

export type Result = { id: string; label: string; pass: boolean; detail: string };

export type ScenarioOptions = { executablePath: string; advanceClock(ms: number): void };

type App = 'a' | 'b';

export async function runScenario(lab: Lab, opts: ScenarioOptions): Promise<{ browser: string; results: Result[] }> {
  const results: Result[] = [];
  async function check(id: string, label: string, fn: () => Promise<string>) {
    try {
      results.push({ id, label, pass: true, detail: await fn() });
    } catch (error) {
      results.push({ id, label, pass: false, detail: String((error as Error).message ?? error).split('\n')[0].slice(0, 300) });
    }
  }
  const expect = (ok: boolean, detail: string) => {
    if (!ok) throw new Error(detail);
    return detail;
  };

  const browser = await chromium.launch({
    executablePath: opts.executablePath,
    args: [
      `--host-resolver-rules=MAP *.${lab.names.parent} 127.0.0.1,MAP ${lab.names.cdn} 127.0.0.1`,
      `--ignore-certificate-errors-spki-list=${lab.cert.spki}`,
    ],
  });
  const allowedOrigins = [lab.origins.a, lab.origins.b, lab.origins.cdn];
  const escapes = new Set<string>();
  const inLab = (url: URL) => !/^https?:|^wss?:/.test(url.protocol) || allowedOrigins.includes(url.origin.replace(/^ws/, 'http'));

  async function newContext(): Promise<BrowserContext> {
    const context = await browser.newContext({ acceptDownloads: true });
    await context.route((url) => !inLab(url), (route) => { escapes.add(route.request().url()); return route.abort(); });
    await context.routeWebSocket((url) => !inLab(url), (ws) => { escapes.add(ws.url()); ws.close(); });
    // Routes do not see redirect hops; the request event does.
    context.on('request', (request) => { if (!inLab(new URL(request.url()))) escapes.add(request.url()); });
    return context;
  }
  const needsPuente = () => {
    if (!lab.authority) throw new Error('sin Puente: no existe autorización ni API de control');
  };

  // Relay's native side: read the code the browser shows and grant that exact request.
  // The control API name only resolves inside the browser profile; Node reaches it on loopback.
  const controlUrl = (path: string) => `http://127.0.0.1:${new URL(lab.origins.control).port}${path}`;
  async function relayGrants(app: App, code: string) {
    const headers = { authorization: `Bearer ${lab.devices.movil}` };
    const list = (await (await fetch(controlUrl(`/v1/web/apps/app-${app}/requests`), { headers })).json()) as { id: string; code: string }[];
    const found = list.find((r) => r.code === code);
    if (!found) throw new Error(`code ${code} not pending`);
    const res = await fetch(controlUrl(`/v1/web/apps/app-${app}/requests/${found.id}/grant`), { method: 'POST', headers });
    if (res.status !== 200) throw new Error(`grant ${res.status}`);
  }

  async function accessCode(page: Page): Promise<string | null> {
    const el = await page.waitForSelector('#codigo', { timeout: 1500 }).catch(() => null);
    return el ? (await el.textContent())!.trim() : null;
  }

  // Opens a URL; if the access page appears, Relay grants it and the page redeems by itself.
  async function openAuthorized(page: Page, app: App, path: string): Promise<string> {
    await page.goto(lab.origins[app] + path);
    const code = await accessCode(page);
    if (!code) return 'sin página de acceso';
    await relayGrants(app, code);
    await page.waitForURL(lab.origins[app] + path, { timeout: 6000, waitUntil: 'load' });
    await page.waitForFunction(() => !document.getElementById('codigo'), undefined, { timeout: 6000 });
    return `código ${code} concedido y canjeado`;
  }

  const phone = await newContext();
  const page = await phone.newPage();
  const a = lab.origins.a;
  const b = lab.origins.b;
  const hitsA = () => lab.apps.a.hits;

  await check('acceso', 'Sin autorización se muestra la página de acceso y nada llega a la aplicación', async () => {
    hitsA().length = 0;
    await page.goto(`${a}/deep/a/b/c?x=1`);
    const code = await accessCode(page);
    return expect(code !== null && hitsA().length === 0, `código=${code} peticiones a la app=${hitsA().length}`);
  });

  await check('canje', 'Relay concede el código; el navegador canjea una vez y vuelve a la ruta profunda', async () => {
    const how = await openAuthorized(page, 'a', '/deep/a/b/c?x=1');
    const text = await page.textContent('#deep-path');
    const cookie = (await phone.cookies(a)).find((c) => c.name === SESSION_COOKIE);
    expect(!!cookie, `${how}; sin cookie de sesión`);
    return expect(
      text === '/deep/a/b/c?x=1' && cookie!.httpOnly && cookie!.secure && cookie!.sameSite === 'Strict' && cookie!.domain === new URL(a).hostname,
      `${how}; ruta=${text}; cookie dominio=${cookie!.domain} httpOnly=${cookie!.httpOnly} sameSite=${cookie!.sameSite}`,
    );
  });

  await check('recursos', 'Página, CSS, imagen y script propios por rutas relativas', async () => {
    await page.goto(`${a}/`);
    const color = await page.$eval('#app', (el) => getComputedStyle(el).color);
    const width = await page.$eval('#logo', (el) => (el as HTMLImageElement).naturalWidth);
    const js = await page.evaluate(() => document.documentElement.dataset.js);
    return expect(color === 'rgb(1, 2, 3)' && width === 10 && js === 'ok', `color=${color} imagen=${width}px js=${js}`);
  });

  await check('externos', 'Recurso externo permitido por la CSP de la aplicación (CSP intacta)', async () => {
    const cdn = await page.evaluate(() => document.documentElement.dataset.cdn);
    const csp = await page.evaluate(async () => (await fetch('/')).headers.get('content-security-policy') ?? '');
    return expect(cdn === 'ok' && csp.includes(lab.origins.cdn), `script externo=${cdn}; CSP recibida=${csp ? 'sí' : 'no'}`);
  });

  await check('sse', 'SSE: eventos en vivo a través de Serve y el Puente', async () => {
    await page.waitForFunction(() => Number(document.body.dataset.sse ?? 0) >= 3, undefined, { timeout: 5000 });
    return `eventos=${await page.evaluate(() => document.body.dataset.sse)}`;
  });

  await check('hmr', 'WebSocket de desarrollo (HMR) en ambos sentidos por wss del mismo origen', async () => {
    await page.waitForFunction(() => !!document.body.dataset.hmrAck, undefined, { timeout: 5000 });
    return `respuesta=${await page.evaluate(() => document.body.dataset.hmrAck)}`;
  });

  await check('formulario', 'Formulario POST urlencoded con texto no ASCII', async () => {
    await page.goto(`${a}/formulario`);
    await page.click('#f button');
    await page.waitForSelector('#nota');
    const text = await page.textContent('#nota');
    return expect(text === 'hola ñandú', `nota=${text}`);
  });

  await check('subida', 'Subida multipart de 3 MiB íntegra', async () => {
    const buffer = randomBytes(3 * 1024 * 1024);
    const sha = createHash('sha256').update(buffer).digest('hex');
    await page.goto(`${a}/formulario`);
    await page.setInputFiles('#u input[type=file]', { name: 'datos.bin', mimeType: 'application/octet-stream', buffer });
    await page.click('#u button');
    const el = await page.waitForSelector('#upload');
    const got = { name: await el.getAttribute('data-name'), size: Number(await el.getAttribute('data-size')), sha: await el.getAttribute('data-sha') };
    return expect(got.sha === sha && got.size === buffer.length, `archivo=${got.name} tamaño=${got.size} sha256 coincide=${got.sha === sha}`);
  });

  await check('descarga', 'Descarga con Content-Disposition', async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => { location.href = '/descarga'; })]);
    const body = readFileSync((await download.path())!, 'utf8');
    return expect(download.suggestedFilename() === 'informe-app-a.txt' && body === 'informe de app-a\n', `archivo=${download.suggestedFilename()} contenido=${JSON.stringify(body)}`);
  });

  await check('redirecciones', 'Redirecciones relativa, por Host y absoluta a loopback terminan en el origen público', async () => {
    const finals: string[] = [];
    for (const kind of ['relative', 'host', 'upstream']) {
      await page.goto(`${a}/redirect/${kind}`).catch(() => {});
      finals.push(page.url());
    }
    return expect(finals.every((u) => u.startsWith(`${a}/deep/redirigida`)), finals.join(' | '));
  });

  await check('login', 'Inicio de sesión propio de la aplicación con cookie __Host-', async () => {
    await page.goto(`${a}/login`);
    await page.click('#login button');
    await page.waitForURL(`${a}/cuenta`);
    const text = await page.textContent('#cuenta');
    return expect(text === 'dentro de app-a', `cuenta=${text}`);
  });

  await check('ventanas', 'Ventanas nuevas: mismo destino autorizado y web externa', async () => {
    await page.goto(`${a}/ventanas`);
    const opened: string[] = [];
    for (const selector of ['#blank', '#abrir', '#externa']) {
      const [popup] = await Promise.all([page.waitForEvent('popup'), page.click(selector)]);
      await popup.waitForLoadState();
      const marker = await popup.$('#deep-path, #externa');
      opened.push(`${new URL(popup.url()).origin === a ? 'A' : popup.url()}:${marker ? 'ok' : 'sin contenido'}`);
      await popup.close();
    }
    return expect(opened[0] === 'A:ok' && opened[1] === 'A:ok' && opened[2] === `${lab.origins.cdn}/pagina:ok`, opened.join(' | '));
  });

  await check('sin-escape', 'Ninguna petición sale hacia el puerto original ni fuera de los orígenes del laboratorio', async () =>
    expect(escapes.size === 0, escapes.size ? `escapes: ${[...escapes].join(', ')}` : 'ninguna'));

  // Second app in the same browser: the hostile sibling.
  await check('segunda-app', 'Segunda aplicación autorizada aparte en el mismo navegador', async () => {
    const how = await openAuthorized(page, 'b', '/login');
    await page.click('#login button');
    await page.waitForURL(`${b}/cuenta`);
    return expect((await page.textContent('#cuenta')) === 'dentro de app-b' && how.startsWith('código'), how);
  });

  const whoami = async (origin: string) => {
    await page.goto(`${origin}/whoami`);
    if (await page.$('#codigo')) throw new Error(`${origin} vuelve a pedir acceso: su cookie de Relay fue sustituida`);
    return JSON.parse((await page.textContent('body'))!) as { cookies: Record<string, string> };
  };

  await check('mismo-nombre', 'Dos aplicaciones con la misma cookie __Host-app_session no se pisan', async () => {
    const ca = (await whoami(a)).cookies['__Host-app_session'] ?? '';
    const cb = (await whoami(b)).cookies['__Host-app_session'] ?? '';
    return expect(ca.startsWith('app-a-') && cb.startsWith('app-b-'), `A ve ${ca.slice(0, 5)}… B ve ${cb.slice(0, 5)}…`);
  });

  await check('padre-http', 'Set-Cookie con Domain padre desde B, en cualquier grafía (`Domain =`, tabulador, mayúsculas), queda limitada a B', async () => {
    await page.goto(`${b}/cookies-padre`);
    await page.waitForFunction(() => document.body.dataset.done === '1');
    const seen = (await whoami(a)).cookies;
    const leaked = ['padre_http', 'padre_espacio', 'padre_tab', 'padre_mayus'].filter((n) => n in seen);
    return expect(leaked.length === 0, `A recibe ${leaked.map((n) => `${n}=${seen[n]}`).join(', ') || '(ninguna)'}`);
  });

  await check('padre-js', 'LÍMITE documentado: cookie Domain padre creada por JavaScript de B llega a A', async () => {
    const seen = (await whoami(a)).cookies;
    return expect(seen.padre_js === 'de-app-b', `A recibe padre_js=${seen.padre_js ?? '(no)'}`);
  });

  await check('reservadas', 'B no puede crear ni sustituir __Host-RelayWeb (Set-Cookie, JS con Domain padre, JS host-only)', async () => {
    const cookies = await phone.cookies([a, b]);
    const relay = cookies.filter((c) => c.name.startsWith('__Host-Relay'));
    const bad = relay.filter((c) => c.value.startsWith('falsa') || c.domain.startsWith('.'));
    const statusA = (await page.goto(`${a}/whoami`))?.status();
    return expect(bad.length === 0 && statusA === 200, `cookies Relay=${relay.map((c) => `${c.name}@${c.domain}`).join(',')} falsas=${bad.length} sesión A=${statusA}`);
  });

  await check('cruzadas', 'Peticiones cruzadas B→A (fetch con credenciales, POST, WebSocket) no llegan a A', async () => {
    hitsA().length = 0;
    await page.goto(`${b}/cruzado?target=${encodeURIComponent(a)}`);
    const out = await page.waitForFunction(() => document.getElementById('cruzado')!.dataset.out, undefined, { timeout: 8000 });
    const fromB = hitsA().filter((h) => h.origin === b);
    return expect(fromB.length === 0, `página B: ${await out.jsonValue()}; peticiones de B que llegaron a A=${fromB.map((h) => `${h.method} ${h.path}`).join(',') || 0}`);
  });

  await check('control', 'El contenido web no alcanza el API de control del Puente', async () => {
    needsPuente();
    await page.goto(`${a}/deep/control`);
    const outcome = await page.evaluate(async (url) => {
      try { return String((await fetch(url, { credentials: 'include' })).status); } catch { return 'bloqueado'; }
    }, `${lab.origins.control}/v1/web/apps/app-a/requests`);
    return expect(outcome === 'bloqueado' || outcome === '401', `fetch desde A al control=${outcome}`);
  });

  await check('otro-navegador', 'El canje está ligado al navegador que pidió: otro perfil con el código público no entra', async () => {
    const other = await newContext();
    const intruder = await other.newPage();
    await intruder.goto(`${a}/`);
    const own = await accessCode(intruder);
    const victim = await newContext();
    const vpage = await victim.newPage();
    await vpage.goto(`${a}/deep/victima`);
    const code = await accessCode(vpage);
    if (!own || !code) throw new Error('sin página de acceso');
    await other.addCookies([{ name: PENDING_COOKIE, value: code, url: a, secure: true, httpOnly: true, sameSite: 'Strict' }]);
    await relayGrants('a', code);
    await vpage.waitForURL(`${a}/deep/victima`, { timeout: 6000 });
    await vpage.waitForSelector('#deep-path', { timeout: 6000 });
    await intruder.waitForTimeout(2500);
    const intruderIn = (await other.cookies(a)).some((c) => c.name === SESSION_COOKIE);
    await other.close();
    await victim.close();
    return expect(!intruderIn, `concedido ${code}; el otro perfil con ese código obtuvo sesión=${intruderIn}`);
  });

  await check('revocar', 'Revocar desde Relay corta SSE y WebSocket abiertos y vuelve a pedir acceso', async () => {
    needsPuente();
    await page.goto(`${a}/`);
    await page.waitForFunction(() => Number(document.body.dataset.sse ?? 0) >= 2 && !!document.body.dataset.hmrAck, undefined, { timeout: 5000 });
    const res = await fetch(controlUrl('/v1/web/apps/app-a/revoke'), { method: 'POST', headers: { authorization: `Bearer ${lab.devices.movil}` } });
    await page.waitForFunction(() => document.body.dataset.sseError === '1' && document.body.dataset.hmrClosed === '1', undefined, { timeout: 5000 });
    await page.reload();
    return expect(res.status === 200 && (await accessCode(page)) !== null, 'streams cortados; recarga muestra acceso');
  });

  await check('caducidad', 'Al cumplirse la hora (reloj del Servidor) se cortan los streams de B sin renovación', async () => {
    needsPuente();
    await page.goto(`${b}/`);
    await page.waitForFunction(() => Number(document.body.dataset.sse ?? 0) >= 2 && !!document.body.dataset.hmrAck, undefined, { timeout: 5000 });
    opts.advanceClock(GRANT_MS);
    lab.authority?.sweep();
    await page.waitForFunction(() => document.body.dataset.sseError === '1' && document.body.dataset.hmrClosed === '1', undefined, { timeout: 5000 });
    await page.reload();
    return expect((await accessCode(page)) !== null, 'streams cortados al vencer; recarga muestra acceso');
  });

  await check('reinicio', 'Reiniciar el Puente exige autorizar de nuevo y conserva la sesión propia de la aplicación', async () => {
    await openAuthorized(page, 'a', '/cuenta');
    await lab.restartPuente();
    await page.goto(`${a}/cuenta`);
    const code = await accessCode(page);
    expect(code !== null, 'tras reiniciar no se pidió acceso');
    await openAuthorized(page, 'a', '/cuenta');
    const text = await page.textContent('#cuenta');
    return expect(text === 'dentro de app-a', `tras reautorizar: ${text}`);
  });

  await check('incompatible', 'Aplicación con URLs fijas a 127.0.0.1: el escape se detecta y bloquea (no se reescribe HTML/JS)', async () => {
    const before = escapes.size;
    await page.goto(`${a}/incompatible`);
    await page.waitForTimeout(800);
    const found = [...escapes].slice(before);
    return expect(found.length >= 1, `intentos bloqueados: ${found.join(', ') || 'ninguno'}`);
  });

  const version = browser.version();
  await browser.close();
  return { browser: version, results };
}
