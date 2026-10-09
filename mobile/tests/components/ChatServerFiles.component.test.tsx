import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { withFileNotes } from '../../../protocol/chatFiles';
import { ChatScreen } from '@/screens/ChatScreen';
import { FILES_ROW_INSET } from '@/screens/chat/ChatFilesPanel';
import { LockGate } from '@/screens/LockGate';
import { LIGHT_PALETTE } from '@/theme/tokens';
import { agentA, conversationA, health, polling, seed, serverA, serverInfo, settings } from '../support/fixtures';
import { hold } from '../support/gestures';
import { biometrics, clockStart, resizeWindow } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, requests, requestsFor, respond, streamFixture, type RequestRecord } from '../support/transport';

// #114: Archivos beside a Conversación on a tablet, through the real LockGate, AppProvider, poll,
// capability negotiation, remote access and Archivos tool. Doubles: transport, fingerprint, gestures.
const V1 = { version: 1, minAppVersion: 1 };
const URL = serverA.url;
const HOME = '/home/user';
const transcript = '/v1/agents/agentA/transcript';
const runPath = '/v1/agents/agentA/runs';
const COLUMN = 600;
const ACCENT = LIGHT_PALETTE.K.accent;
const entry = (name: string, type = 'file') => ({ name, nameUtf8: true, type, size: 5, mode: type === 'directory' ? 0o755 : 0o644, uid: 1000, gid: 1000, mtime: clockStart, version: { dev: '1', ino: name.length.toString(), mtimeNs: '1', ctimeNs: '1' } });
const history = { sessionId: conversationA.sessionId, conversation: conversationA, items: [
  { kind: 'user', id: 'h1', text: 'Corre las pruebas', at: clockStart },
  { kind: 'tool', id: 'h2', tool: 'terminal', preview: 'npm test', status: 'done', durationSeconds: 1, result: null, at: clockStart },
  { kind: 'assistant', id: 'h3', text: 'Historial de archivos', at: clockStart },
] };

function serve(capabilities: Record<string, typeof V1> = { files: V1, chat_files: V1 }) {
  seed([serverA], { ...settings, faceid: true, autoLockMs: 60_000 });
  polling(serverA, [agentA]);
  respond(URL, '/health', json({ ...health, capabilities }));
  respond(URL, '/v1/server', json(serverInfo));
  respond(URL, transcript, json(history));
  respond(URL, '/v1/remote/status', json({ serverNow: clockStart, files: { state: 'available' } }));
  respond(URL, '/v1/remote/files/list', (r: RequestRecord) => {
    const path = (r.body as { path?: string }).path ?? HOME;
    return json({ path, realPath: path, entries: path === HOME ? [entry('notas.txt'), entry('proyectos', 'directory')] : [], truncated: false, protection: null });
  }, 'POST');
}

async function mount(width = 1280) {
  resizeWindow(width, 800);
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  const app = renderApp(<LockGate><ChatScreen serverId="A" agentId="agentA" /></LockGate>);
  await app.ready();
  await screen.findByText('Historial de archivos');
  return app;
}

const settle = () => act(async () => { await jest.advanceTimersByTimeAsync(10); });

async function openPanel() {
  fireEvent.press(screen.getByLabelText('Adjuntar imagen'));
  fireEvent.press(screen.getByText('Desde el Servidor'));
  await settle();
}

/** Opens the panel, enters with the fingerprint and waits for the folder; the Conversación column is COLUMN wide. */
async function ready() {
  serve(); await mount(); await openPanel();
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  await act(async () => { fireEvent.press(screen.getByLabelText('Entrar con huella')); });
  await settle();
  await screen.findByLabelText('Abrir notas.txt');
  fireEvent(screen.getByTestId('conversacion-destino'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: COLUMN, height: 600 } } });
}

const ring = () => String(StyleSheet.flatten(screen.getByTestId('conversacion-destino').props.style).boxShadow ?? '');
const chips = () => screen.queryAllByText(/^ARCHIVO DEL SERVIDOR · /);
/** Nothing of a file's content was asked for: no read, no download. */
const contentRequests = () => requests.filter((r) => r.path.startsWith('/v1/remote/files/read') || r.path.startsWith('/v1/remote/files/downloads'));

test('«Desde el Servidor» is offered on a tablet whose Puente has chat_files', async () => {
  serve(); await mount();
  fireEvent.press(screen.getByLabelText('Adjuntar imagen'));
  expect(screen.getByText('Desde el Servidor')).toBeVisible();
  expect(screen.getByText('IMÁGENES DEL TELÉFONO · ARCHIVOS DEL SERVIDOR POR REFERENCIA')).toBeVisible();
});

test('a phone has no option, so no panel and no drag', async () => {
  serve(); await mount(400);
  fireEvent.press(screen.getByLabelText('Adjuntar imagen'));
  expect(screen.queryByText('Desde el Servidor')).toBeNull();
  expect(screen.getByText('SOLO IMÁGENES · HERMES NO ACEPTA OTROS ARCHIVOS')).toBeVisible();
});

test('an older Puente without chat_files gets no option', async () => {
  serve({ files: V1 }); await mount();
  fireEvent.press(screen.getByLabelText('Adjuntar imagen'));
  expect(screen.queryByText('Desde el Servidor')).toBeNull();
});

test('the panel takes ACTIVIDAD\'s place and asks for the fingerprint first; closing it gives ACTIVIDAD back', async () => {
  serve(); await mount();
  expect(screen.getByText('ACTIVIDAD DEL TURNO')).toBeVisible();
  await openPanel();
  expect(screen.getByText('ARCHIVOS DEL SERVIDOR')).toBeVisible();
  expect(screen.queryByText('ACTIVIDAD DEL TURNO')).toBeNull();
  expect(screen.getByText('PON TU HUELLA PARA ENTRAR')).toBeVisible();
  expect(screen.queryByLabelText('Abrir notas.txt')).toBeNull();
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  await act(async () => { fireEvent.press(screen.getByLabelText('Entrar con huella')); });
  await settle();
  expect(await screen.findByLabelText('Abrir notas.txt')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Cerrar Archivos'));
  expect(screen.queryByText('ARCHIVOS DEL SERVIDOR')).toBeNull();
  expect(screen.getByText('ACTIVIDAD DEL TURNO')).toBeVisible();
});

test('dragging a file over the Conversación lights it; dropping attaches its path, and sending carries only the path', async () => {
  await ready();
  expect(ring()).not.toContain(ACCENT);
  const drag = hold('archivo-notas.txt', [{ x: -(FILES_ROW_INSET + 1) }]);
  expect(ring()).toContain(`0px 0px 0px 2px ${ACCENT}`);
  expect(screen.getByText('SUELTA PARA ADJUNTAR')).toBeVisible();
  drag.release();
  expect(screen.queryByText('SUELTA PARA ADJUNTAR')).toBeNull();
  expect(screen.getByText('ARCHIVO DEL SERVIDOR · notas.txt')).toBeVisible();
  expect(screen.getByText(`${HOME}/notas.txt`)).toBeVisible();
  expect(requestsFor(URL, runPath)).toHaveLength(0);

  respond(URL, runPath, json({ runId: 'file-run', sessionId: conversationA.id, conversationId: conversationA.id, inputMessageId: 'file-message' }), 'POST');
  const stream = streamFixture(); respond(URL, '/v1/runs/file-run/events', stream.reply);
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Resume el archivo');
  await act(async () => { fireEvent.press(screen.getByLabelText('Enviar')); });
  await waitFor(() => expect(requestsFor(URL, runPath)).toHaveLength(1));
  expect(requestsFor(URL, runPath)[0]!.body).toEqual({ input: 'Resume el archivo', sessionId: conversationA.id, files: [{ path: `${HOME}/notas.txt` }] });
  expect(contentRequests()).toEqual([]);
  // The bubble shows the chip, never the note.
  expect(screen.getAllByText('ARCHIVO DEL SERVIDOR · notas.txt')).toHaveLength(1);
  expect(screen.getByText('Resume el archivo')).toBeVisible();
  expect(screen.queryByText(/The user attached/)).toBeNull();
});

test('a release over the panel or past the Conversación attaches nothing', async () => {
  await ready();
  hold('archivo-notas.txt', [{ x: -FILES_ROW_INSET + 1 }]).release();
  expect(chips()).toHaveLength(0);
  const far = hold('archivo-notas.txt', [{ x: -(FILES_ROW_INSET + COLUMN + 1) }]);
  expect(ring()).not.toContain(ACCENT);
  far.release();
  expect(chips()).toHaveLength(0);
});

test('a drag the system cancels attaches nothing and the ring goes off', async () => {
  await ready();
  const drag = hold('archivo-notas.txt', [{ x: -(FILES_ROW_INSET + 1) }]);
  expect(ring()).toContain(ACCENT);
  drag.cancel();
  expect(ring()).not.toContain(ACCENT);
  expect(chips()).toHaveLength(0);
});

test('a folder cannot be dragged', async () => {
  await ready();
  expect(() => getByGestureTestId('archivo-proyectos')).toThrow();
  expect(getByGestureTestId('archivo-notas.txt')).toBeTruthy();
});

test('Puente data is refused with a fixed text; the file stays attached and no Turno runs', async () => {
  await ready();
  hold('archivo-notas.txt', [{ x: -(FILES_ROW_INSET + 1) }]).release();
  respond(URL, runPath, json({ error: { code: 'remote_bridge_protected', message: 'private server message' } }, 403), 'POST');
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Mira');
  await act(async () => { fireEvent.press(screen.getByLabelText('Enviar')); });
  expect(await screen.findByText('Los datos del Puente no se adjuntan.')).toBeVisible();
  expect(screen.queryByText(/private server message/)).toBeNull();
  expect(screen.getByText('ARCHIVO DEL SERVIDOR · notas.txt')).toBeVisible();
  expect(screen.queryByLabelText('Detener')).toBeNull();
});

test('a transcript message with a file note shows the chip on a phone too, never the raw note', async () => {
  serve();
  respond(URL, transcript, json({ ...history, items: [...history.items, { kind: 'user', id: 'h4', text: withFileNotes('¿Qué dice?', ['/srv/datos/informe.pdf']), at: clockStart }] }));
  await mount(400);
  expect(screen.getByText('ARCHIVO DEL SERVIDOR · informe.pdf')).toBeVisible();
  expect(screen.getByText('¿Qué dice?')).toBeVisible();
  expect(screen.queryByText(/The user attached/)).toBeNull();
});

test('a Puente that stops offering chat_files never receives files: the send is refused here and the chip stays', async () => {
  await ready();
  hold('archivo-notas.txt', [{ x: -(FILES_ROW_INSET + 1) }]).release();
  respond(URL, '/health', json({ ...health, capabilities: { files: V1 } }));
  await act(async () => { await jest.advanceTimersByTimeAsync(6_000); });
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Mira');
  await act(async () => { fireEvent.press(screen.getByLabelText('Enviar')); });
  expect(requestsFor(URL, runPath)).toHaveLength(0);
  expect(screen.getByText('Actualiza el Puente para adjuntar archivos del Servidor.')).toBeVisible();
  expect(screen.getByText('ARCHIVO DEL SERVIDOR · notas.txt')).toBeVisible();
});
