import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { LockGate } from '@/screens/LockGate';
import { ServerToolsScreen } from '@/screens/ServerToolsScreen';
import { health, polling, seed, serverA, settings } from '../support/fixtures';
import { biometrics, clockStart, emitAppState, resizeWindow } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, networkError, requests, respond, type RequestRecord } from '../support/transport';
import { liveWebViews, nativeEvent, webView } from '../support/webView';

// The Web tool with the real LockGate, AppProvider, poll, remote access, capability negotiation and
// web client. Doubles: the system verification, the clock, the transport, Linking (the phone's
// browser) and react-native-webview (tests/support/webView.tsx).
const V1 = { version: 1, minAppVersion: 1 };
const URL = serverA.url;
const APP = 'app_' + 'A'.repeat(22);
const ORIGIN = 'https://relay-0123456789abcdef.tail.ts.net';
const TICKET = 'T'.repeat(43);
const PENDING = { id: 'acc_' + 'P'.repeat(22), code: 'K7QM-3XPD', createdAt: clockStart - 30_000, expiresAt: clockStart + 270_000 };
const tienda = { id: APP, name: 'Tienda', address: '127.0.0.1', port: 3000, origin: ORIGIN, createdAt: clockStart };
const candidates = [
  { address: '127.0.0.1', port: 3000, process: { name: 'node', directory: '/home/ana/tienda' } },
  { address: '::1', port: 5173, process: { name: 'node', directory: '/home/ana/blog' } },
];
const posts = (path: string) => requests.filter((r) => r.method === 'POST' && r.path === path);
const webRequests = () => requests.filter((r) => r.path.startsWith('/v1/remote/web/'));
const settle = () => act(async () => { await jest.advanceTimersByTimeAsync(10); });
/** A time as the phone shows it, in its own zone. */
const clock = (ms: number) => new Date(ms).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
const openURL = () => jest.mocked(Linking.openURL);

function serve(apps: unknown[]) {
  respond(URL, '/health', json({ ...health, capabilities: { web: V1 } }));
  respond(URL, '/v1/remote/status', json({ serverNow: clockStart, web: { inRelay: { state: 'available' }, external: { state: 'available' } } }));
  respond(URL, '/v1/remote/web/apps', json({ apps }));
  respond(URL, '/v1/remote/web/candidates', json({ candidates }));
  respond(URL, `/v1/remote/web/apps/${APP}/open`, () => json({ origin: ORIGIN, entryPath: '/__relay/entrar', ticket: TICKET, expiresAt: clockStart + 60_000 }), 'POST');
  respond(URL, `/v1/remote/web/apps/${APP}/close`, json({ closed: 1 }), 'POST');
}

async function setup(apps: unknown[] = [tienda], options: { autoLockMs?: 60_000 | 900_000 } = {}) {
  seed([serverA], { ...settings, faceid: true, autoLockMs: options.autoLockMs ?? 900_000 });
  polling(serverA);
  serve(apps);
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  const app = renderApp(<LockGate><ServerToolsScreen serverId={serverA.id} /></LockGate>);
  await app.ready();
  await enter();
  fireEvent.press(screen.getByLabelText('Web'));
  await settle();
  return app;
}
async function enter() {
  await waitFor(() => expect(screen.getByText('PON TU HUELLA PARA ENTRAR')).toBeVisible());
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  await act(async () => { fireEvent.press(screen.getByLabelText('Entrar con huella')); });
  await settle();
}
async function openInRelay() {
  await act(async () => { fireEvent.press(screen.getByLabelText('Abrir Tienda en Relay')); });
  await settle();
}
/** What react-native-webview would ask the screen before a navigation of the page. */
const navigate = (url: string) => (webView().props.onShouldStartLoadWithRequest as (r: object) => boolean)({ url, isTopFrame: true, navigationType: 'click', loading: true, title: '', canGoBack: false, canGoForward: false, lockIdentifier: 1 });
const fire = (name: string, detail: object) => act(async () => { (webView().props[name] as (e: object) => void)(nativeEvent(detail)); });
// react-native-webview hands this one the navigation state itself, not a native event.
const at = (url: string, canGoBack = true) => act(async () => {
  (webView().props.onNavigationStateChange as (s: object) => void)({ url, loading: false, title: 'Tienda', canGoBack, canGoForward: false, navigationType: 'other', lockIdentifier: 0 });
});
/** A page of the app that loaded without an HTTP error. */
async function loaded(url: string) {
  await fire('onLoadStart', { url });
  await at(url);
  await fire('onLoadEnd', { url });
}

test('discovery only lists; choosing a service registers it by its exact address, and nothing is opened or authorized', async () => {
  respond(URL, '/v1/remote/web/apps', (r: RequestRecord) => r.method === 'POST' ? json({ ...tienda, name: 'Mi tienda' }) : json({ apps: [] }), 'POST');
  await setup([]);
  expect(screen.getByText('node · /home/ana/tienda')).toBeVisible();
  expect(screen.getByText('[::1]:5173')).toBeVisible();
  expect(webRequests().map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/remote/web/apps', 'GET /v1/remote/web/candidates']);

  fireEvent.press(screen.getByLabelText('Elegir node · 127.0.0.1:3000'));
  expect(screen.getByLabelText('Nombre de la aplicación').props.value).toBe('tienda');
  fireEvent.changeText(screen.getByLabelText('Nombre de la aplicación'), 'Mi tienda');
  respond(URL, '/v1/remote/web/apps', json({ apps: [{ ...tienda, name: 'Mi tienda' }] }));
  await act(async () => { fireEvent.press(screen.getByLabelText('Guardar aplicación')); });
  await settle();
  expect(posts('/v1/remote/web/apps').map((r) => r.body)).toEqual([{ requestId: expect.stringMatching(/^[A-Za-z0-9_-]{8,128}$/), name: 'Mi tienda', address: '127.0.0.1', port: 3000 }]);
  expect(posts('/v1/remote/web/apps')[0]!.headers.get('X-Relay-Capability')).toBe('web/1');
  expect(screen.getByLabelText('Abrir Mi tienda en Relay')).toBeVisible();
  expect(webRequests().filter((r) => /\/(open|authorizations)/.test(r.path))).toEqual([]);
  expect(liveWebViews()).toBe(0);
});

test('the viewer enters with the single-use ticket in a form POST and gets no key, no native channel and no file access', async () => {
  await setup();
  await openInRelay();
  expect(posts(`/v1/remote/web/apps/${APP}/open`).map((r) => r.body)).toEqual([{ path: '/' }]);
  const { props } = webView();
  expect(props.source).toEqual({ uri: `${ORIGIN}/__relay/entrar`, method: 'POST', body: `ticket=${TICKET}` });
  // Nothing of the Servidor's control API crosses into the page: neither its address nor the key.
  const passed = JSON.stringify(props, (_key, value: unknown) => typeof value === 'function' ? undefined : value);
  expect(passed).not.toContain(serverA.key);
  expect(passed).not.toContain(serverA.url);
  expect(passed).not.toContain('a.fixture.ts.net');
  expect(props.onMessage).toBeUndefined();
  expect(props.injectedJavaScript).toBeUndefined();
  expect(props.injectedJavaScriptBeforeContentLoaded).toBeUndefined();
  expect(props).toMatchObject({ allowFileAccess: false, allowFileAccessFromFileURLs: false, allowUniversalAccessFromFileURLs: false, mixedContentMode: 'never', setSupportMultipleWindows: true, thirdPartyCookiesEnabled: false });
  expect(props.webviewDebuggingEnabled).toBeFalsy();
  // Every navigation reaches the screen's policy: none is opened by react-native-webview on its own.
  expect(props.originWhitelist).toEqual(['*']);
});

test('the app stays in the viewer; other webs open in the phone browser; loopback and other schemes are refused', async () => {
  openURL().mockResolvedValue(true);
  await setup();
  await openInRelay();
  expect(navigate(`${ORIGIN}/carrito`)).toBe(true);
  expect(navigate('https://cdn.example.com/doc')).toBe(false);
  expect(openURL()).toHaveBeenLastCalledWith('https://cdn.example.com/doc');
  // Another app of the same Servidor is another web: never loaded here, never granted.
  expect(navigate('https://relay-fedcba9876543210.tail.ts.net/')).toBe(false);
  expect(openURL()).toHaveBeenLastCalledWith('https://relay-fedcba9876543210.tail.ts.net/');
  expect(navigate('intent://scan#Intent;scheme=zxing;end')).toBe(false);
  expect(navigate('file:///android_asset/www.bundle/terminal.html')).toBe(false);
  expect(openURL()).toHaveBeenCalledTimes(2);
  // A fixed loopback address is the phone itself: the app does not follow the proxy contract.
  await act(async () => { expect(navigate('http://127.0.0.1:3000/static/app.js')).toBe(false); });
  expect(openURL()).toHaveBeenCalledTimes(2);
  expect(screen.getByText('DIRECCIÓN LOCAL BLOQUEADA')).toBeVisible();
  expect(screen.getByText(/http:\/\/127\.0\.0\.1:3000/)).toBeVisible();

  // New windows: the app's own stay in the viewer, the rest go to the browser.
  await fire('onOpenWindow', { targetUrl: `${ORIGIN}/popup` });
  expect(webView().props.source).toEqual({ uri: `${ORIGIN}/popup` });
  await fire('onOpenWindow', { targetUrl: 'https://docs.example.com/' });
  expect(openURL()).toHaveBeenLastCalledWith('https://docs.example.com/');
  await fire('onOpenWindow', { targetUrl: 'tel:5555' });
  expect(openURL()).toHaveBeenCalledTimes(3);
  expect(webView().props.source).toEqual({ uri: `${ORIGIN}/popup` });
  expect(webRequests().filter((r) => r.path.endsWith('/open'))).toHaveLength(1);
});

test('back, reload and a typed path move inside the app only', async () => {
  await setup();
  await openInRelay();
  await at(`${ORIGIN}/carrito?x=1`);
  expect(screen.getByLabelText('Ruta de la aplicación').props.value).toBe('/carrito?x=1');
  fireEvent.press(screen.getByLabelText('Atrás en la página'));
  expect(webView().goBack).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByLabelText('Recargar'));
  expect(webView().reload).toHaveBeenCalledTimes(1);
  fireEvent.changeText(screen.getByLabelText('Ruta de la aplicación'), 'pedidos/ñandú');
  fireEvent.press(screen.getByLabelText('Ir a la ruta'));
  expect(webView().props.source).toEqual({ uri: `${ORIGIN}/pedidos/%C3%B1and%C3%BA` });
  // The same path again (a form there posted meanwhile) loads it again: the source alone would not change.
  const before = webView();
  fireEvent.press(screen.getByLabelText('Ir a la ruta'));
  expect(webView()).not.toBe(before);
  expect(webView().props.source).toEqual({ uri: `${ORIGIN}/pedidos/%C3%B1and%C3%BA` });
  fireEvent.changeText(screen.getByLabelText('Ruta de la aplicación'), 'https://otro.example/');
  fireEvent.press(screen.getByLabelText('Ir a la ruta'));
  expect(webView().props.source).toEqual({ uri: `${ORIGIN}/pedidos/%C3%B1and%C3%BA` });
  expect(screen.getByText('Escribe una ruta de esta aplicación, como /pedidos.')).toBeVisible();
});

test('a session the Puente ended enters again once at the same path; the app’s own 401 is then shown, never a loop', async () => {
  await setup();
  await openInRelay();
  await loaded(`${ORIGIN}/carrito`);
  await fire('onLoadStart', { url: `${ORIGIN}/carrito` });
  await fire('onHttpError', { url: `${ORIGIN}/carrito`, statusCode: 401, description: 'Unauthorized' });
  await settle();
  expect(posts(`/v1/remote/web/apps/${APP}/open`).map((r) => r.body)).toEqual([{ path: '/' }, { path: '/carrito' }]);
  expect(webView().props.source).toEqual({ uri: `${ORIGIN}/__relay/entrar`, method: 'POST', body: `ticket=${TICKET}` });
  // Right after entering again, a 401 is the app's own page: it stays on screen.
  await fire('onLoadStart', { url: `${ORIGIN}/carrito` });
  await fire('onHttpError', { url: `${ORIGIN}/carrito`, statusCode: 401, description: 'Unauthorized' });
  await fire('onLoadEnd', { url: `${ORIGIN}/carrito` });
  await settle();
  expect(posts(`/v1/remote/web/apps/${APP}/open`)).toHaveLength(2);
  // A page that loads fine arms it again.
  await fire('onLoadStart', { url: `${ORIGIN}/` });
  await fire('onLoadEnd', { url: `${ORIGIN}/` });
  await fire('onLoadStart', { url: `${ORIGIN}/x` });
  await fire('onHttpError', { url: `${ORIGIN}/x`, statusCode: 401, description: 'Unauthorized' });
  await settle();
  expect(posts(`/v1/remote/web/apps/${APP}/open`)).toHaveLength(3);
});

test('a stopped app shows the failure and a retry that never opens another port; the Server browser is offered, not authorized', async () => {
  await setup();
  await openInRelay();
  await loaded(`${ORIGIN}/`);
  await fire('onLoadStart', { url: `${ORIGIN}/` });
  respond(URL, `/v1/remote/web/apps/${APP}/open`, json({ error: { code: 'remote_ended', message: 'x' } }, 410), 'POST');
  await fire('onHttpError', { url: `${ORIGIN}/`, statusCode: 502, description: 'Bad Gateway' });
  await settle();
  expect(screen.getByText('LA APLICACIÓN NO RESPONDE')).toBeVisible();
  expect(screen.getByText(/127\.0\.0\.1:3000/)).toBeVisible();
  expect(liveWebViews()).toBe(0);
  respond(URL, `/v1/remote/web/apps/${APP}/open`, json({ origin: ORIGIN, entryPath: '/__relay/entrar', ticket: TICKET, expiresAt: clockStart + 60_000 }), 'POST');
  await act(async () => { fireEvent.press(screen.getByLabelText('Reintentar')); });
  await settle();
  expect(posts(`/v1/remote/web/apps/${APP}/open`).map((r) => r.body)).toEqual([{ path: '/' }, { path: '/' }, { path: '/' }]);
  expect(webView().props.source).toMatchObject({ uri: `${ORIGIN}/__relay/entrar` });
  // Still down right after entering (the identity check passed, the port refused): the Puente's own
  // 502 page is never left on screen, and retrying enters again.
  await fire('onLoadStart', { url: `${ORIGIN}/` });
  await fire('onHttpError', { url: `${ORIGIN}/`, statusCode: 502, description: 'Bad Gateway' });
  await settle();
  expect(screen.getByText('LA APLICACIÓN NO RESPONDE')).toBeVisible();
  expect(liveWebViews()).toBe(0);
  await act(async () => { fireEvent.press(screen.getByLabelText('Reintentar')); });
  await settle();
  expect(posts(`/v1/remote/web/apps/${APP}/open`)).toHaveLength(4);

  respond(URL, `/v1/remote/web/apps/${APP}/open`, json({ error: { code: 'remote_conflict', message: 'x' } }, 409), 'POST');
  await fire('onLoadStart', { url: `${ORIGIN}/` });
  await fire('onLoadEnd', { url: `${ORIGIN}/` });
  await fire('onLoadStart', { url: `${ORIGIN}/` });
  await fire('onHttpError', { url: `${ORIGIN}/`, statusCode: 401, description: 'Unauthorized' });
  await settle();
  expect(screen.getByText('OTRO PROGRAMA EN ESE PUERTO')).toBeVisible();
  const before = requests.length;
  fireEvent.press(screen.getByLabelText('Usar el navegador del Servidor'));
  await settle();
  expect(screen.getByText('NAVEGADOR · DEDICADO')).toBeVisible();
  expect(requests.slice(before).filter((r) => r.path.startsWith('/v1/remote/') && r.path !== '/v1/remote/status')).toEqual([]);
});

test('hiding Relay keeps the page (a file chooser hides it); locking closes the session and returning enters again where it was', async () => {
  await setup([tienda], { autoLockMs: 60_000 });
  await openInRelay();
  await at(`${ORIGIN}/carrito`);
  const page = webView();
  await act(async () => { emitAppState('background'); });
  await settle();
  await act(async () => { emitAppState('active'); });
  await settle();
  expect(webView()).toBe(page);
  expect(posts(`/v1/remote/web/apps/${APP}/close`)).toEqual([]);
  expect(posts(`/v1/remote/web/apps/${APP}/open`)).toHaveLength(1);

  await act(async () => { await jest.advanceTimersByTimeAsync(61_000); });
  expect(screen.getByText('Relay está bloqueado')).toBeVisible();
  expect(liveWebViews()).toBe(0);
  expect(posts(`/v1/remote/web/apps/${APP}/close`)).toHaveLength(1);
  expect(webRequests().filter((r) => r.path.includes('/authorizations'))).toEqual([]);

  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  await act(async () => { fireEvent.press(screen.getByText('Usar el código del teléfono')); });
  await enter();
  expect(posts(`/v1/remote/web/apps/${APP}/open`).map((r) => r.body)).toEqual([{ path: '/' }, { path: '/carrito' }]);
  expect(webView().props.source).toMatchObject({ uri: `${ORIGIN}/__relay/entrar` });
});

test('external: the phone browser asks, Relay grants only the compared code, shows the hour, cancels, and shows the end', async () => {
  openURL().mockResolvedValue(true);
  let listed: { requests: unknown[]; authorizations: unknown[] } = { requests: [], authorizations: [] };
  respond(URL, `/v1/remote/web/apps/${APP}/authorizations`, () => json({ serverNow: Date.now(), ...listed }));
  const granted = { id: PENDING.id, code: PENDING.code, grantedAt: clockStart + 2_000, expiresAt: clockStart + 2_000 + 3_600_000, redeemed: false };
  // Granting moves the request to this device's authorizations, as the Puente does.
  respond(URL, `/v1/remote/web/apps/${APP}/authorizations`, () => { listed = { requests: [], authorizations: [granted] }; return json(granted); }, 'POST');
  respond(URL, `/v1/remote/web/apps/${APP}/authorizations/${PENDING.id}/cancel`, json({ ok: true }), 'POST');
  await setup();
  await act(async () => { fireEvent.press(screen.getByLabelText('Abrir Tienda en el navegador del teléfono')); });
  await settle();
  expect(screen.getByText(/Autoriza solo el código que ves en el navegador/)).toBeVisible();
  expect(screen.getByText(/hasta 20 solicitudes/)).toBeVisible();
  await act(async () => { fireEvent.press(screen.getByLabelText('Abrir la aplicación en el navegador')); });
  expect(openURL()).toHaveBeenCalledWith(`${ORIGIN}/`);
  expect(webRequests().filter((r) => r.method === 'POST')).toEqual([]);

  listed = { requests: [PENDING], authorizations: [] };
  await act(async () => { await jest.advanceTimersByTimeAsync(2_000); });
  expect(screen.getByText('K7QM-3XPD')).toBeVisible();
  await act(async () => { fireEvent.press(screen.getByLabelText('Autorizar código K7QM-3XPD')); });
  await settle();
  expect(posts(`/v1/remote/web/apps/${APP}/authorizations`).map((r) => r.body)).toEqual([{ request: PENDING.id, code: 'K7QM-3XPD' }]);
  expect(screen.getByText('ESPERANDO AL NAVEGADOR')).toBeVisible();
  expect(screen.getByText(`Vence a las ${clock(granted.expiresAt)}`)).toBeVisible();
  listed = { requests: [], authorizations: [{ ...granted, redeemed: true }] };
  await act(async () => { await jest.advanceTimersByTimeAsync(2_000); });
  expect(screen.getByText('EN USO')).toBeVisible();

  listed = { requests: [], authorizations: [] };
  await act(async () => { fireEvent.press(screen.getByLabelText('Cancelar autorización K7QM-3XPD')); });
  await settle();
  expect(posts(`/v1/remote/web/apps/${APP}/authorizations/${PENDING.id}/cancel`)).toHaveLength(1);
  expect(screen.getByText('CANCELADA')).toBeVisible();
});

test('external: locking Relay keeps the hour; its end on the Server clock is shown, and nothing renews it', async () => {
  // The Server's clock runs 5 minutes ahead of the phone's: its hour ends 10 s from now on the phone.
  const granted = { id: PENDING.id, code: PENDING.code, grantedAt: clockStart + 310_000 - 3_600_000, expiresAt: clockStart + 310_000, redeemed: true };
  let listed: unknown[] = [granted];
  respond(URL, `/v1/remote/web/apps/${APP}/authorizations`, () => json({ serverNow: Date.now() + 300_000, requests: [], authorizations: listed }));
  await setup([tienda], { autoLockMs: 60_000 });
  await act(async () => { fireEvent.press(screen.getByLabelText('Abrir Tienda en el navegador del teléfono')); });
  await settle();
  expect(screen.getByText('EN USO')).toBeVisible();
  expect(screen.getByText(`Vence a las ${clock(clockStart + 10_000)}`)).toBeVisible();
  // Over by the Server's clock: shown as over, then gone from the list, and never renewed.
  await act(async () => { await jest.advanceTimersByTimeAsync(11_000); });
  expect(screen.getByText('VENCIDA')).toBeVisible();
  listed = [];
  await act(async () => { await jest.advanceTimersByTimeAsync(2_000); });
  expect(screen.getByText('VENCIDA')).toBeVisible();
  expect(webRequests().filter((r) => r.method === 'POST')).toEqual([]);

  listed = [{ ...granted, expiresAt: Date.now() + 1_800_000 }];
  await act(async () => { await jest.advanceTimersByTimeAsync(61_000); });
  expect(screen.getByText('Relay está bloqueado')).toBeVisible();
  expect(webRequests().filter((r) => r.path.endsWith('/cancel'))).toEqual([]);
});

test('revocation removes the viewer and sends nothing more to the web tool', async () => {
  await setup();
  await openInRelay();
  const before = webRequests().length;
  respond(URL, '/v1/agents', json({ error: { code: 'device_revoked', message: 'hidden' } }, 403));
  await act(async () => { await jest.advanceTimersByTimeAsync(5_000); });
  expect(screen.getByText('SIN ACCESO')).toBeVisible();
  expect(liveWebViews()).toBe(0);
  expect(webRequests().slice(before)).toEqual([]);
});

test('a lost connection removes the viewer and sends nothing; reconnecting enters again where it was', async () => {
  await setup();
  await openInRelay();
  await at(`${ORIGIN}/carrito`);
  respond(URL, '/health', () => networkError());
  respond(URL, '/v1/agents', () => networkError());
  await act(async () => { await jest.advanceTimersByTimeAsync(5_000); });
  expect(screen.getByText('SIN CONTROL')).toBeVisible();
  expect(liveWebViews()).toBe(0);
  // No current advertisement: not even the close leaves (ADR 0006). Entering again replaces that session.
  expect(posts(`/v1/remote/web/apps/${APP}/close`)).toEqual([]);

  polling(serverA);
  serve([tienda]);
  await act(async () => { await jest.advanceTimersByTimeAsync(30_000); });
  expect(posts(`/v1/remote/web/apps/${APP}/open`).map((r) => r.body)).toEqual([{ path: '/' }, { path: '/carrito' }]);
  expect(liveWebViews()).toBe(1);
});

test('two panels on a tablet: the page lets go of its field when the other panel takes the keyboard, and keeps the page', async () => {
  resizeWindow(1200, 800);
  await setup();
  await openInRelay();
  const page = webView();
  fireEvent.press(screen.getByLabelText('Dos paneles'));
  await settle();
  expect(page.injectJavaScript).not.toHaveBeenCalled();
  fireEvent(screen.getByLabelText('Teclado en el panel 2'), 'touchStart');
  await settle();
  expect(page.injectJavaScript).toHaveBeenCalledTimes(1);
  expect(page.injectJavaScript).toHaveBeenCalledWith('document.activeElement && document.activeElement.blur(); true;');
  fireEvent.press(screen.getByLabelText('Teclado en el panel 1'));
  await settle();
  expect(page.injectJavaScript).toHaveBeenCalledTimes(1);
  expect(webView()).toBe(page);
  expect(posts(`/v1/remote/web/apps/${APP}/open`)).toHaveLength(1);
});
