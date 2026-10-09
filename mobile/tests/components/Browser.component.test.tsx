import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { LockGate } from '@/screens/LockGate';
import { ServerToolsScreen } from '@/screens/ServerToolsScreen';
import { configureLocalFiles, localFiles, pickPhoneFile } from '../support/files';
import { health, polling, seed, serverA, settings } from '../support/fixtures';
import { biometrics, clockStart, emitAppState } from '../support/native';
import { renderApp } from '../support/renderApp';
import { binary, json, requests, respond, streamCount, streamFixture, type RequestRecord } from '../support/transport';

// The Navegador tool with the real LockGate, AppProvider, poll, remote access, capability negotiation,
// browser session and browsers client. Doubles: the system verification, the clock and the transport.
const V1 = { version: 1, minAppVersion: 1 };
const ID = 'env_' + 'D'.repeat(22);
const HID = 'env_' + 'H'.repeat(22);
const CHANNEL = 'c'.repeat(22);
const URL = serverA.url;
const JPEG = Buffer.from('jpeg').toString('base64');
const env = (id: string, kind: 'browser_dedicated' | 'browser_habitual', extra: Record<string, unknown> = {}) => ({
  id, kind, ownership: kind === 'browser_habitual' ? 'shared' : 'own', createdAt: clockStart, state: 'running', ...extra,
});
const tab = (id: string, extra: Record<string, unknown> = {}) => ({
  id, url: `https://tienda.example/${id}`, title: `Página ${id}`, limitation: null, createdByRelay: false, dialog: null, fileChooser: null, ...extra,
});
const page = (id: string) => `/v1/remote/browsers/${id}`;
const posts = (path: string) => requests.filter((r) => r.method === 'POST' && r.path === path);
const actions = (id = ID, tabId = 'T1') => posts(`${page(id)}/tabs/${tabId}/action`).map((r) => r.body);
const remoteRequests = () => requests.filter((r) => r.path.startsWith('/v1/remote/') && r.path !== '/v1/remote/status');
const settle = () => act(async () => { await jest.advanceTimersByTimeAsync(10); });

/** Whether the Servidor offers the files tool, for phone files to and from a page. */
let withFiles = false;
beforeEach(() => { withFiles = false; });

function serve(list: unknown[]) {
  respond(URL, '/health', json({ ...health, capabilities: { environments: V1, browser: V1, ...(withFiles ? { files: V1 } : {}) } }));
  respond(URL, '/v1/remote/status', json({ serverNow: clockStart, browser: { dedicated: { state: 'available' }, habitual: { state: 'available' } }, ...(withFiles ? { files: { state: 'available' } } : {}) }));
  respond(URL, '/v1/remote/environments', json({ environments: list }));
  for (const id of [ID, HID]) {
    for (const action of ['view', 'ack']) respond(URL, `${page(id)}/${action}`, json({ ok: true }), 'POST');
    for (const tabId of ['T1', 'T2', 'T3']) respond(URL, `${page(id)}/tabs/${tabId}/action`, json({}), 'POST');
  }
}
function frames(id: string) {
  const stream = streamFixture();
  respond(URL, `${page(id)}/frames`, (request: RequestRecord) => stream.reply(request));
  return { ...stream, send: (event: object) => stream.emit(`${'seq' in event ? `id: ${(event as { seq: number }).seq}\n` : ''}data: ${JSON.stringify(event)}\n\n`) };
}
const frame = (seq: number, viewport: { width: number; height: number }, tabId = 'T1') => ({ type: 'frame', seq, tab: tabId, data: JPEG, viewport });
const layout = async (width: number, height: number) => {
  await act(async () => { fireEvent(screen.getByLabelText('Página del navegador'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width, height } } }); });
  await settle();
};
/** A finger down at (x, y) of the page box, lifted after moving by (dx, dy). */
const touch = async (x: number, y: number, dx = 0, dy = 0) => {
  const target = screen.getByLabelText('Página del navegador');
  await act(async () => {
    fireEvent(target, 'responderGrant', { nativeEvent: { locationX: x, locationY: y, pageX: x + 12, pageY: y + 200 } });
    fireEvent(target, 'responderRelease', { nativeEvent: { locationX: x + dx, locationY: y + dy, pageX: x + 12 + dx, pageY: y + 200 + dy } });
  });
  await settle();
};

async function setup(list: unknown[], { navegador = true } = {}) {
  seed([serverA], { ...settings, faceid: true, autoLockMs: 60_000 });
  polling(serverA);
  serve(list);
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  const app = renderApp(<LockGate><ServerToolsScreen serverId={serverA.id} /></LockGate>);
  await app.ready();
  await waitFor(() => expect(screen.getByText('PON TU HUELLA PARA ENTRAR')).toBeVisible());
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  await act(async () => { fireEvent.press(screen.getByLabelText('Entrar con huella')); });
  await settle();
  if (navegador) {
    fireEvent.press(screen.getByLabelText('Navegador'));
    await settle();
  }
  return app;
}

/** The dedicated browser connected, T1 and T2 listed, T1 chosen in a 400 × 700 box and its first frame, drawn at that view, on screen. */
async function viewing() {
  const stream = frames(ID);
  await setup([env(ID, 'browser_dedicated')]);
  await act(async () => { stream.send({ type: 'open', channel: CHANNEL }); stream.send({ type: 'tabs', tabs: [tab('T1'), tab('T2')] }); });
  await settle();
  await layout(400, 700);
  fireEvent.press(screen.getByLabelText('Pestaña Página T1'));
  await settle();
  await act(async () => { stream.send(frame(1, { width: 400, height: 700 })); });
  await settle();
  return stream;
}

test('nothing opens by itself: the person picks the mode and opens it, then picks the tab that is viewed', async () => {
  const stream = frames(ID);
  respond(URL, '/v1/remote/environments', (r: RequestRecord) => r.method === 'POST' ? json(env(ID, 'browser_dedicated')) : json({ environments: [] }), 'POST');
  await setup([]);
  expect(screen.getByText('Abrir navegador dedicado')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Navegador habitual'));
  expect(screen.getByText('Conectar con el navegador habitual')).toBeVisible();
  expect(screen.getByText(/Relay controla solo las pestañas que compartas allí/)).toBeVisible();
  expect(posts('/v1/remote/environments')).toEqual([]);
  expect(streamCount()).toBe(0);

  fireEvent.press(screen.getByLabelText('Navegador dedicado'));
  await act(async () => { fireEvent.press(screen.getByText('Abrir navegador dedicado')); });
  await settle();
  const [created] = posts('/v1/remote/environments');
  expect(created!.body).toEqual({ requestId: expect.stringMatching(/^[A-Za-z0-9_-]{8,128}$/), kind: 'browser_dedicated' });
  expect(created!.headers.get('X-Relay-Capability')).toBe('environments/1');
  const opened = requests.find((r) => r.path === `${page(ID)}/frames`)!;
  expect(opened.headers.get('X-Relay-Capability')).toBe('browser/1');

  await act(async () => { stream.send({ type: 'open', channel: CHANNEL }); stream.send({ type: 'tabs', tabs: [tab('T1'), tab('T2')] }); });
  await settle();
  expect(screen.getByText('CONECTADO · PROPIO')).toBeVisible();
  expect(screen.getByText('ELIGE UNA PESTAÑA')).toBeVisible();
  await layout(400, 700);
  expect(posts(`${page(ID)}/view`)).toEqual([]);
  fireEvent.press(screen.getByLabelText('Pestaña Página T2'));
  await settle();
  // Density 1 in the test renderer: one device pixel per CSS pixel.
  expect(posts(`${page(ID)}/view`).map((r) => r.body)).toEqual([{ channel: CHANNEL, tab: 'T2', width: 400, height: 700, scale: 1, quality: 60 }]);
  expect(screen.getByText('ACTUALIZANDO LA CAPTURA…')).toBeVisible();
  await act(async () => { stream.send(frame(1, { width: 400, height: 700 }, 'T2')); });
  await settle();
  expect(posts(`${page(ID)}/ack`).map((r) => r.body)).toEqual([{ channel: CHANNEL, seq: 1 }]);
  expect(screen.getByLabelText('Captura de la página')).toBeVisible();
  expect(screen.queryByText('ACTUALIZANDO LA CAPTURA…')).toBeNull();
});

test('a live browser is not connected while the person is in another tool: only opening Navegador connects it', async () => {
  const stream = frames(ID);
  await setup([env(ID, 'browser_dedicated')], { navegador: false });
  await act(async () => { await jest.advanceTimersByTimeAsync(2000); });
  expect(streamCount()).toBe(0);
  expect(requests.filter((r) => r.path.startsWith('/v1/remote/browsers/'))).toEqual([]);

  fireEvent.press(screen.getByLabelText('Navegador'));
  await settle();
  expect(streamCount()).toBe(1);
  await act(async () => { stream.send({ type: 'open', channel: CHANNEL }); stream.send({ type: 'tabs', tabs: [tab('T1')] }); });
  await settle();
  expect(screen.getByText('CONECTADO · PROPIO')).toBeVisible();
  // Back to another tool, the browser stays connected, as the terminal does.
  fireEvent.press(screen.getByLabelText('Archivos'));
  await settle();
  expect(streamCount()).toBe(1);
});

test('a touch lands on the CSS pixel under the finger; a turn takes nothing until a frame of the new view comes; a drag scrolls', async () => {
  const stream = await viewing();
  // The dedicated browser draws the tab at the size of the box.
  await touch(100, 200);
  await touch(100, 300, 0, -100);
  expect(actions()).toEqual([{ type: 'tap', x: 100, y: 200 }, { type: 'scroll', x: 100, y: 300, dx: 0, dy: 100 }]);

  // Turned to landscape: a new view, and the old frame cannot be touched until the new one comes.
  await layout(700, 400);
  expect(posts(`${page(ID)}/view`).at(-1)!.body).toEqual({ channel: CHANNEL, tab: 'T1', width: 700, height: 400, scale: 1, quality: 60 });
  expect(screen.getByText('ACTUALIZANDO LA CAPTURA…')).toBeVisible();
  await touch(350, 100);
  // A frame drawn before the turn, arriving after it: still the page as it was, never touched.
  await act(async () => { stream.send(frame(2, { width: 400, height: 700 })); });
  await settle();
  expect(screen.getByText('ACTUALIZANDO LA CAPTURA…')).toBeVisible();
  await touch(350, 100);
  fireEvent.press(screen.getByLabelText('Tecla Intro'));
  await settle();
  expect(actions()).toHaveLength(2);
  await act(async () => { stream.send(frame(3, { width: 700, height: 400 })); });
  await settle();
  await touch(350, 100);
  expect(actions().at(-1)).toEqual({ type: 'tap', x: 350, y: 100 });

  // Spanish text from the phone's keyboard, then Intro from its return key; a key from the bar.
  fireEvent.changeText(screen.getByLabelText('Escribir en la página'), 'canción ñandú');
  await act(async () => { fireEvent(screen.getByLabelText('Escribir en la página'), 'submitEditing'); });
  await settle();
  fireEvent.press(screen.getByLabelText('Flecha abajo'));
  await settle();
  expect(actions().slice(3)).toEqual([{ type: 'text', text: 'canción ñandú' }, { type: 'key', key: 'Enter' }, { type: 'key', key: 'ArrowDown' }]);
});

test('the page field keeps the keyboard when it shrinks the page: what is typed waits in it until the frame of the new view comes', async () => {
  const stream = await viewing();
  const field = screen.getByLabelText('Escribir en la página');
  fireEvent(field, 'focus');
  // The phone's keyboard opens: the page box shrinks, a new view is asked for, the frame is stale.
  await layout(400, 380);
  expect(screen.getByText('ACTUALIZANDO LA CAPTURA…')).toBeVisible();
  // An editable={false} field loses focus on Android, and the keyboard closes with it.
  expect(field).toBeEnabled();
  fireEvent.changeText(field, 'añadir');
  await act(async () => { fireEvent(field, 'submitEditing'); });
  await settle();
  expect(actions()).toEqual([]);
  expect(field).toHaveDisplayValue('añadir');
  await act(async () => { stream.send(frame(2, { width: 400, height: 380 })); });
  await settle();
  await act(async () => { fireEvent(field, 'submitEditing'); });
  await settle();
  expect(actions()).toEqual([{ type: 'text', text: 'añadir' }, { type: 'key', key: 'Enter' }]);
});

test('with the page field empty, the keys of a keyboard reach the page; with text in it, or with a modifier, they stay in the field', async () => {
  await viewing();
  const field = screen.getByLabelText('Escribir en la página');
  const press = async (key: string, modifiers: Record<string, boolean> = {}) => {
    await act(async () => { fireEvent(field, 'keyPress', { nativeEvent: { key, ...modifiers }, preventDefault: () => {} }); });
    await settle();
  };
  for (const key of ['Backspace', 'Tab', 'Escape', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Delete', 'Home', 'End', 'PageUp', 'PageDown']) await press(key);
  expect(actions()).toEqual(['Backspace', 'Tab', 'Escape', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Delete', 'Home', 'End', 'PageUp', 'PageDown'].map((key) => ({ type: 'key', key })));

  // Intro goes with the text, from the return key; a letter is text; a modifier would change the key and the contract carries none.
  await press('Enter');
  await press('a');
  await press('Tab', { shiftKey: true });
  await press('ArrowLeft', { ctrlKey: true });
  await press('Backspace', { altKey: true });
  await press('ArrowRight', { metaKey: true });
  expect(actions()).toHaveLength(12);

  // Text in the field: the keys edit it, not the page.
  fireEvent.changeText(field, 'hola');
  await press('Backspace');
  await press('ArrowLeft');
  expect(actions()).toHaveLength(12);
});

test('address, history and tabs: what the person types goes as a page address, and a new tab is chosen once open', async () => {
  const stream = await viewing();
  respond(URL, `${page(ID)}/tabs`, json(tab('T3', { url: '', title: '', createdByRelay: true })), 'POST');
  respond(URL, `${page(ID)}/tabs/T2`, json({ ok: true }), 'DELETE');
  fireEvent.changeText(screen.getByLabelText('Dirección'), 'tienda.example/búsqueda?q=café');
  await act(async () => { fireEvent.press(screen.getByLabelText('Ir')); });
  await settle();
  fireEvent.changeText(screen.getByLabelText('Dirección'), 'javascript:alert(1)');
  await act(async () => { fireEvent.press(screen.getByLabelText('Ir')); });
  for (const label of ['Atrás', 'Adelante', 'Recargar']) fireEvent.press(screen.getByLabelText(label));
  await settle();
  expect(actions()).toEqual([{ type: 'navigate', url: 'https://tienda.example/búsqueda?q=café' }, { type: 'back' }, { type: 'forward' }, { type: 'reload' }]);

  fireEvent.press(screen.getByLabelText('Pestaña nueva'));
  await act(async () => { fireEvent.press(screen.getByLabelText('Abrir pestaña')); });
  await settle();
  expect(posts(`${page(ID)}/tabs`).map((r) => r.body)).toEqual([{}]);
  expect(posts(`${page(ID)}/view`).at(-1)!.body).toMatchObject({ tab: 'T3' });
  await act(async () => { stream.send({ type: 'tabs', tabs: [tab('T1'), tab('T2'), tab('T3', { url: '', title: '', createdByRelay: true })] }); });
  fireEvent.press(screen.getByLabelText('Pestaña Página T2'));
  await act(async () => { fireEvent.press(screen.getByLabelText('Cerrar pestaña')); });
  await settle();
  expect(requests.filter((r) => r.method === 'DELETE').map((r) => r.path)).toEqual([`${page(ID)}/tabs/T2`]);
  expect(screen.queryByLabelText('Pestaña Página T2')).toBeNull();
});

test('a prompt is answered with Relay controls; a limitation is sent to the computer; a file chooser takes Servidor paths; a download is offered', async () => {
  const stream = await viewing();
  await act(async () => { stream.send({ type: 'tabs', tabs: [tab('T1', { dialog: { type: 'prompt', message: '¿Nombre del cliente?', defaultPrompt: 'Ana' } }), tab('T2', { limitation: 'debugger_busy' }), tab('T3', { fileChooser: { multiple: false } })] }); });
  await settle();
  expect(screen.getByText('¿Nombre del cliente?')).toBeVisible();
  expect(screen.getByText('LA PÁGINA ESPERA UNA RESPUESTA')).toBeVisible();
  await touch(100, 100);
  expect(actions()).toEqual([]);
  fireEvent.changeText(screen.getByLabelText('Respuesta del diálogo'), 'Ana María');
  await act(async () => { fireEvent.press(screen.getByLabelText('Aceptar diálogo')); });
  await settle();
  expect(actions()).toEqual([{ type: 'dialog', accept: true, text: 'Ana María' }]);

  const views = posts(`${page(ID)}/view`).length;
  fireEvent.press(screen.getByLabelText('Pestaña Página T2'));
  await settle();
  expect(screen.getByText('NECESITA LA COMPUTADORA')).toBeVisible();
  expect(screen.getByText('Las DevTools u otra herramienta de depuración ocupan esta pestaña. Ciérralas en la computadora.')).toBeVisible();
  expect(posts(`${page(ID)}/view`)).toHaveLength(views);

  fireEvent.press(screen.getByLabelText('Pestaña Página T3'));
  await settle();
  expect(screen.getByText('LA PÁGINA PIDE UN ARCHIVO')).toBeVisible();
  // A relative path is not a file of the Servidor: it is never sent.
  fireEvent.changeText(screen.getByLabelText('Ruta del archivo en el Servidor'), 'Pedidos.csv');
  expect(screen.getByLabelText('Usar archivo del Servidor')).toBeDisabled();
  await act(async () => { fireEvent.press(screen.getByLabelText('Usar archivo del Servidor')); });
  await settle();
  expect(actions(ID, 'T3')).toEqual([]);
  fireEvent.changeText(screen.getByLabelText('Ruta del archivo en el Servidor'), '/home/ana/Pedidos.csv');
  await act(async () => { fireEvent.press(screen.getByLabelText('Usar archivo del Servidor')); });
  await settle();
  expect(actions(ID, 'T3')).toEqual([{ type: 'files', paths: ['/home/ana/Pedidos.csv'] }]);

  await act(async () => { stream.send({ type: 'download', name: 'factura.pdf', path: '/home/ana/Downloads/factura.pdf' }); });
  await settle();
  expect(screen.getByText('DESCARGA EN EL SERVIDOR')).toBeVisible();
  expect(screen.getByText('factura.pdf')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Descartar factura.pdf'));
  expect(screen.queryByText('factura.pdf')).toBeNull();
});

test('the habitual browser is shared: marked so, its frames must keep coming, and disconnecting keeps the browser and every tab', async () => {
  const stream = frames(HID);
  respond(URL, `/v1/remote/environments/${HID}/terminate`, json(env(HID, 'browser_habitual', { state: 'exited', endedAt: clockStart })), 'POST');
  await setup([env(HID, 'browser_habitual')]);
  // The dedicated mode has none: offered, never opened by itself.
  expect(screen.getByText('Abrir navegador dedicado')).toBeVisible();
  expect(streamCount()).toBe(0);
  fireEvent.press(screen.getByLabelText('Navegador habitual'));
  await settle();
  await act(async () => { stream.send({ type: 'open', channel: CHANNEL }); stream.send({ type: 'tabs', tabs: [tab('T1', { createdByRelay: true })] }); });
  await settle();
  expect(screen.getByText('CONECTADO · COMPARTIDO')).toBeVisible();
  expect(screen.getByText('CONTROL COMPARTIDO')).toBeVisible();
  expect(screen.queryByLabelText('Cerrar pestaña')).toBeNull();
  await layout(400, 700);
  fireEvent.press(screen.getByLabelText('Pestaña Página T1'));
  await settle();
  await act(async () => { stream.send(frame(1, { width: 1280, height: 800 })); });
  await settle();
  // The person's window, 1280 × 800, fits the 400 × 700 box at 0.3125 with bars above and below, which are not the page.
  await touch(200, 350);
  await touch(200, 100);
  await touch(200, 350, 0, -50);
  expect(actions(HID)).toEqual([{ type: 'tap', x: 640, y: 400 }, { type: 'scroll', x: 640, y: 400, dx: 0, dy: 160 }]);
  // Turned: the window keeps its size, so its next frame is the page as it is, now with bars at the sides.
  await layout(700, 400);
  await act(async () => { stream.send(frame(2, { width: 1280, height: 800 })); });
  await settle();
  await touch(10, 200);
  await touch(350, 200);
  expect(actions(HID).slice(2)).toEqual([{ type: 'tap', x: 640, y: 400 }]);
  // No frame for 5 s: the extension or the computer may be gone, and the image is stale.
  await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
  expect(screen.getByText('LA CAPTURA NO SE ACTUALIZA')).toBeVisible();
  await touch(350, 200);
  expect(actions(HID)).toHaveLength(3);

  fireEvent.press(screen.getByLabelText('Desconectar navegador'));
  expect(screen.getByText('¿DESCONECTAR DEL NAVEGADOR HABITUAL?')).toBeVisible();
  expect(screen.getByText(/El navegador y todas sus pestañas siguen abiertos, también las que abrió Relay\./)).toBeVisible();
  fireEvent.press(screen.getByLabelText('Cancelar'));
  expect(posts(`/v1/remote/environments/${HID}/terminate`)).toEqual([]);
  respond(URL, '/v1/remote/environments', json({ environments: [env(HID, 'browser_habitual', { state: 'exited', endedAt: clockStart })] }));
  fireEvent.press(screen.getByLabelText('Desconectar navegador'));
  await act(async () => { fireEvent.press(screen.getByLabelText('Confirmar desconectar')); });
  await settle();
  expect(posts(`/v1/remote/environments/${HID}/terminate`).map((r) => r.body)).toEqual([{ confirm: true }]);
  expect(requests.filter((r) => r.method === 'DELETE')).toEqual([]);
  // Listed as ended: the page is gone and its stream closed, with nothing else sent.
  expect(streamCount()).toBe(0);
  await settle();
  expect(screen.getByText('DESCONECTADO')).toBeVisible();
  expect(screen.getByText('Conectar con el navegador habitual')).toBeVisible();
});

test('ending the dedicated browser asks first and says it closes it with its tabs and keeps its sign-ins', async () => {
  await viewing();
  respond(URL, `/v1/remote/environments/${ID}/terminate`, json(env(ID, 'browser_dedicated', { state: 'exited', endedAt: clockStart })), 'POST');
  fireEvent.press(screen.getByLabelText('Terminar navegador'));
  expect(screen.getByText('¿TERMINAR EL NAVEGADOR DEDICADO?')).toBeVisible();
  expect(screen.getByText(/Se cierra el navegador dedicado de Servidor A con sus pestañas\. Su perfil y sus inicios de sesión quedan en el Servidor/)).toBeVisible();
  fireEvent.press(screen.getByLabelText('Cancelar'));
  expect(posts(`/v1/remote/environments/${ID}/terminate`)).toEqual([]);
  respond(URL, '/v1/remote/environments', json({ environments: [env(ID, 'browser_dedicated', { state: 'exited', endedAt: clockStart })] }));
  fireEvent.press(screen.getByLabelText('Terminar navegador'));
  await act(async () => { fireEvent.press(screen.getByLabelText('Confirmar terminar')); });
  await settle();
  expect(posts(`/v1/remote/environments/${ID}/terminate`).map((r) => r.body)).toEqual([{ confirm: true }]);
  expect(streamCount()).toBe(0);
  await settle();
  expect(screen.getByText('TERMINADO')).toBeVisible();
  // Never a replacement by itself.
  expect(posts('/v1/remote/environments')).toEqual([]);
});

test('hiding Relay hides the page and suspends control without sending anything; shown again it recovers the tab and waits for a new frame', async () => {
  await viewing();
  expect(streamCount()).toBe(1);
  const before = remoteRequests().length;
  await act(async () => { emitAppState('background'); });
  await settle();
  expect(streamCount()).toBe(0);
  expect(screen.queryByLabelText('Captura de la página')).toBeNull();
  expect(screen.queryByLabelText('Página del navegador')).toBeNull();
  expect(remoteRequests().slice(before)).toEqual([]);

  const again = frames(ID);
  await act(async () => { emitAppState('active'); });
  await settle();
  expect(streamCount()).toBe(1);
  await act(async () => { again.send({ type: 'open', channel: 'd'.repeat(22) }); again.send({ type: 'tabs', tabs: [tab('T1'), tab('T2')] }); });
  await settle();
  await layout(400, 700);
  // The same tab, viewed again on the new channel; nothing from before is shown or touched until its own frame.
  expect(posts(`${page(ID)}/view`).at(-1)!.body).toMatchObject({ channel: 'd'.repeat(22), tab: 'T1' });
  expect(screen.queryByLabelText('Captura de la página')).toBeNull();
  await touch(100, 200);
  expect(actions()).toEqual([]);
  await act(async () => { again.send(frame(1, { width: 400, height: 700 })); });
  await settle();
  await touch(100, 200);
  expect(actions()).toEqual([{ type: 'tap', x: 100, y: 200 }]);
  expect(posts('/v1/remote/environments')).toEqual([]);
});

test('locking Relay hides the page and closes its stream without sending anything', async () => {
  const stream = await viewing();
  const before = remoteRequests().length;
  // The Puente's keepalive every 15 s keeps the stream alive until Relay locks at 60 s.
  for (const step of [15_000, 15_000, 15_000, 16_000]) {
    await act(async () => { stream.emit(': keepalive\n\n'); await jest.advanceTimersByTimeAsync(step); });
  }
  expect(screen.getByText('Relay está bloqueado')).toBeVisible();
  expect(streamCount()).toBe(0);
  expect(screen.queryByLabelText('Captura de la página')).toBeNull();
  expect(remoteRequests().slice(before)).toEqual([]);
});

test('a lost stream leaves a stale image that takes nothing and comes back without opening another browser', async () => {
  const stream = await viewing();
  await act(async () => { stream.fail(); });
  await settle();
  expect(screen.getByText('RECONECTANDO… · PROPIO')).toBeVisible();
  expect(screen.getByText('SIN CONEXIÓN · IMAGEN ANTERIOR')).toBeVisible();
  // Nothing reaches the page while the image is not the page as it is: the key bar is off.
  expect(screen.getByLabelText('Tecla Intro')).toBeDisabled();
  await touch(100, 200);
  fireEvent.press(screen.getByLabelText('Tecla Intro'));
  fireEvent.press(screen.getByLabelText('Recargar'));
  await settle();
  expect(actions()).toEqual([]);

  const again = frames(ID);
  await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
  await act(async () => { again.send({ type: 'open', channel: 'd'.repeat(22) }); again.send({ type: 'tabs', tabs: [tab('T1')] }); });
  await settle();
  expect(posts(`${page(ID)}/view`).at(-1)!.body).toMatchObject({ channel: 'd'.repeat(22), tab: 'T1' });
  expect(screen.getByText('ACTUALIZANDO LA CAPTURA…')).toBeVisible();
  await act(async () => { again.send(frame(1, { width: 400, height: 700 })); });
  await settle();
  await touch(100, 200);
  expect(actions()).toEqual([{ type: 'tap', x: 100, y: 200 }]);
  expect(screen.getByLabelText('Tecla Intro')).toBeEnabled();
  expect(posts('/v1/remote/environments')).toEqual([]);
});

test('a browser the Servidor lost is shown as not recoverable, with no stream and no replacement', async () => {
  const LOST = 'env_' + 'L'.repeat(22);
  respond(URL, `/v1/remote/environments/${LOST}`, json({ ok: true }), 'DELETE');
  await setup([env(LOST, 'browser_dedicated', { state: 'lost', endedAt: clockStart })]);
  expect(screen.getByText('NO RECUPERABLE')).toBeVisible();
  expect(screen.getByText('Abrir navegador dedicado')).toBeVisible();
  expect(streamCount()).toBe(0);
  respond(URL, '/v1/remote/environments', json({ environments: [] }));
  await act(async () => { fireEvent.press(screen.getByLabelText('Quitar de la lista')); });
  await settle();
  expect(requests.filter((r) => r.method === 'DELETE').map((r) => r.path)).toEqual([`/v1/remote/environments/${LOST}`]);
  expect(screen.queryByText('NO RECUPERABLE')).toBeNull();
  expect(posts('/v1/remote/environments')).toEqual([]);
});

const OP = 'op_' + 'u'.repeat(22);
const VERSION = { dev: '1', ino: '2', mtimeNs: '3', ctimeNs: '4' };
const entry = (name: string, size = 4) => ({ name, nameUtf8: true, type: 'file', size, mode: 0o644, uid: 1, gid: 1, mtime: clockStart, version: VERSION });

test('a phone file reaches the Servidor first, under a free name, and only then fills the page\'s chooser', async () => {
  withFiles = true;
  const stream = await viewing();
  const bytes = new TextEncoder().encode('a,b\n');
  pickPhoneFile('pedidos.csv', bytes);
  respond(URL, '/v1/remote/files/list', json({ path: '/home/ana', realPath: '/home/ana', entries: [entry('pedidos.csv')], truncated: false }), 'POST');
  respond(URL, '/v1/remote/files/uploads', json({ id: OP, size: 4, received: 0 }), 'POST');
  respond(URL, `/v1/remote/files/uploads/${OP}/0`, json({ id: OP, size: 4, received: 4 }), 'PUT');
  respond(URL, `/v1/remote/files/uploads/${OP}/commit`, json(entry('pedidos (2).csv')), 'POST');
  await act(async () => { stream.send({ type: 'tabs', tabs: [tab('T1', { fileChooser: { multiple: false } })] }); });
  await settle();
  await act(async () => { fireEvent.press(screen.getByLabelText('Subir desde el teléfono')); });
  await settle();

  const order = requests.map((r) => `${r.method} ${r.path}`).filter((line) => line.includes('/files/') || line.endsWith('/action'));
  expect(order).toEqual([
    'POST /v1/remote/files/list', 'POST /v1/remote/files/uploads', `PUT /v1/remote/files/uploads/${OP}/0`, `POST /v1/remote/files/uploads/${OP}/commit`,
    `POST ${page(ID)}/tabs/T1/action`,
  ]);
  const put = requests.find((r) => r.method === 'PUT')!;
  expect(put.headers.get('X-Relay-Capability')).toBe('files/1');
  expect(Array.from(put.body as Uint8Array)).toEqual(Array.from(bytes));
  expect(posts('/v1/remote/files/uploads')[0]!.body).toEqual({ directory: '/home/ana', name: 'pedidos (2).csv', size: 4 });
  expect(actions()).toEqual([{ type: 'files', paths: ['/home/ana/pedidos (2).csv'] }]);
  expect(screen.getByText('DEL TELÉFONO AL SERVIDOR · TERMINADA')).toBeVisible();
});

test('a download stays on the Servidor until the person brings it to the phone, chunk by chunk', async () => {
  withFiles = true;
  configureLocalFiles();
  const stream = await viewing();
  const OP2 = 'op_' + 'd'.repeat(22);
  respond(URL, '/v1/remote/files/downloads', json({ id: OP2, path: '/home/ana/Downloads/factura.pdf', realPath: '/home/ana/Downloads/factura.pdf', size: 3, version: VERSION }), 'POST');
  respond(URL, `/v1/remote/files/downloads/${OP2}/0`, binary(new Uint8Array([37, 80, 68])));
  await act(async () => { stream.send({ type: 'download', name: 'factura.pdf', path: '/home/ana/Downloads/factura.pdf' }); });
  await settle();
  expect(requests.filter((r) => r.path.startsWith('/v1/remote/files/'))).toEqual([]);
  await act(async () => { fireEvent.press(screen.getByLabelText('Traer factura.pdf al teléfono')); });
  await settle();
  expect(posts('/v1/remote/files/downloads').map((r) => r.body)).toEqual([{ path: '/home/ana/Downloads/factura.pdf' }]);
  expect(screen.getByText('DEL SERVIDOR AL TELÉFONO · TERMINADA')).toBeVisible();
  expect(screen.getByLabelText('Abrir factura.pdf')).toBeVisible();
  expect([...localFiles.entries()].find(([uri]) => uri.endsWith('/factura.pdf'))?.[1]).toEqual([37, 80, 68]);
});

test('without the files tool on the Servidor, phone files are not offered and the page still takes Servidor paths', async () => {
  const stream = await viewing();
  await act(async () => { stream.send({ type: 'tabs', tabs: [tab('T1', { fileChooser: { multiple: false } })] }); stream.send({ type: 'download', name: 'factura.pdf', path: '/home/ana/Downloads/factura.pdf' }); });
  await settle();
  expect(screen.queryByLabelText('Subir desde el teléfono')).toBeNull();
  expect(screen.queryByLabelText('Traer factura.pdf al teléfono')).toBeNull();
  expect(screen.getAllByText(/hace falta la herramienta Archivos en el Servidor/)).toHaveLength(2);
});

test('hiding Relay mid-upload interrupts it: never shown as done, cancelled on the Servidor, and the chooser is not filled', async () => {
  withFiles = true;
  const stream = await viewing();
  pickPhoneFile('pedidos.csv', new TextEncoder().encode('a,b\n'));
  respond(URL, '/v1/remote/files/list', json({ path: '/home/ana', realPath: '/home/ana', entries: [], truncated: false }), 'POST');
  respond(URL, '/v1/remote/files/uploads', json({ id: OP, size: 4, received: 0 }), 'POST');
  // The chunk never answers: only aborting ends it.
  respond(URL, `/v1/remote/files/uploads/${OP}/0`, (request: RequestRecord) => {
    const { promise, reject } = Promise.withResolvers<Response>();
    request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    return promise;
  }, 'PUT');
  respond(URL, `/v1/remote/operations/${OP}/cancel`, json({ id: OP, state: 'cancelled' }), 'POST');
  await act(async () => { stream.send({ type: 'tabs', tabs: [tab('T1', { fileChooser: { multiple: false } })] }); });
  await settle();
  await act(async () => { fireEvent.press(screen.getByLabelText('Subir desde el teléfono')); });
  await settle();
  expect(screen.getByText(/DEL TELÉFONO AL SERVIDOR · 0 B DE 4 B/)).toBeVisible();
  await act(async () => { emitAppState('background'); });
  await settle();
  expect(screen.getByText('DEL TELÉFONO AL SERVIDOR · INTERRUMPIDA')).toBeVisible();
  expect(posts(`/v1/remote/operations/${OP}/cancel`)).toHaveLength(1);
  expect(posts(`/v1/remote/files/uploads/${OP}/commit`)).toEqual([]);
  expect(actions()).toEqual([]);
});
