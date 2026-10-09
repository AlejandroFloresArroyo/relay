import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Keyboard } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootLayout from '@/app/_layout';
import type { ServerEntry } from '@/state/app';
import { useApp } from '@/state/app';
import { ChatScreen } from '@/screens/ChatScreen';
import { LockGate } from '@/screens/LockGate';
import { ServerToolsScreen } from '@/screens/ServerToolsScreen';
import { clipboard } from '../support/clipboard';
import { agentA, conversationA, health, polling, seed, serverA, serverB, settings } from '../support/fixtures';
import { biometrics, clockStart, navigation, resizeWindow, router, showRoute, stackOf, tabsRoute } from '../support/native';
import { renderApp } from '../support/renderApp';
import { surfaces } from '../support/terminalSurface';
import { json, requests, respond, streamFixture, type RequestRecord } from '../support/transport';

jest.mock('expo-font', () => require('../support/native').fonts);
jest.mock('expo-splash-screen', () => require('../support/native').splash);
jest.mock('expo-status-bar', () => ({ StatusBar: require('../support/native').StatusBar }));

// The tools of a Servidor composed as the outline asks (docs/planning/relay-v3-workspace-outline.md):
// panels, keyboard focus, the way back to the Conversación and more than one Servidor. Real root
// layout, Shell, tools host, LockGate, AppProvider, remote access, terminal session and files core.
// Doubles: the system verification, the clock, the transport, the router, the terminal WebView.
const V1 = { version: 1, minAppVersion: 1 };
const ID = 'env_' + 'W'.repeat(22);
const settle = () => act(async () => { await jest.advanceTimersByTimeAsync(10); });
const entry = (name: string, ino: number) => ({
  name, nameUtf8: true, type: 'file', size: 4, mode: 0o644, uid: 1000, gid: 1000, mtime: clockStart,
  version: { dev: '64', ino: String(ino), mtimeNs: '1790000000000000000', ctimeNs: '1790000000000000001' },
});

/** A Servidor with the terminal (one running) and files; `file` is the only entry of its home folder. */
function serveTools(server: ServerEntry, home: string, file: string) {
  respond(server.url, '/health', json({ ...health, capabilities: { environments: V1, terminal: V1, files: V1 } }));
  respond(server.url, '/v1/remote/status', json({ serverNow: clockStart, terminal: { state: 'available' }, files: { state: 'available' } }));
  respond(server.url, '/v1/remote/environments', json({ environments: [{ id: ID, kind: 'terminal', ownership: 'own', createdAt: clockStart, state: 'running', terminal: { shell: '/usr/bin/zsh', cwd: home } }] }));
  respond(server.url, '/v1/remote/shells', json({ shells: ['/usr/bin/zsh'], defaultShell: '/usr/bin/zsh', home }));
  for (const action of ['ack', 'resize']) respond(server.url, `/v1/remote/terminals/${ID}/${action}`, json({ ok: true }), 'POST');
  respond(server.url, `/v1/remote/terminals/${ID}/input`, (r: RequestRecord) => json({ inputSeq: (r.body as { seq: number }).seq }), 'POST');
  const stream = streamFixture();
  respond(server.url, `/v1/remote/terminals/${ID}/output`, (r: RequestRecord) => stream.reply(r));
  respond(server.url, '/v1/remote/files/list', (r: RequestRecord) => {
    const path = (r.body as { path?: string }).path ?? home;
    return json({ path, realPath: path, entries: [entry(file, 70)], truncated: false, protection: null });
  }, 'POST');
  respond(server.url, '/v1/remote/files/read', json({ path: `${home}/${file}`, realPath: `${home}/${file}`, protection: null,
    version: { dev: '64', ino: '70', size: 4, mtimeNs: '1790000000000000000', sha256: 'a'.repeat(64) }, bytes: Buffer.from('uno\n').toString('base64') }), 'POST');
  return { connect: () => act(async () => { stream.emit(`data: ${JSON.stringify({ type: 'open', channel: 'c'.repeat(22), inputSeq: 0 })}\n\n`); }) };
}

async function enter() {
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  await act(async () => { fireEvent.press(screen.getByLabelText('Entrar con huella')); });
  await settle();
}
const aliveSurfaces = () => surfaces.filter((s) => s.alive);
const remote = (server: ServerEntry) => requests.filter((r) => r.origin === new URL(server.url).origin && r.path.startsWith('/v1/remote/') && r.path !== '/v1/remote/status')
  .map((r) => `${r.method} ${r.path}`);

async function tablet() {
  resizeWindow(1200, 800);
  seed([serverA], { ...settings, autoLockMs: 60_000 });
  polling(serverA);
  const tools = serveTools(serverA, '/home/ana', 'notas.txt');
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  const app = renderApp(<LockGate><ServerToolsScreen serverId={serverA.id} /></LockGate>);
  await app.ready();
  await waitFor(() => expect(screen.getByText('PON TU HUELLA PARA ENTRAR')).toBeVisible());
  await enter();
  await tools.connect();
  await settle();
  fireEvent.press(screen.getByLabelText('Dos paneles'));
  await settle();
  return app;
}

test('a tablet shows two tools side by side; only the focused panel types, and moving tools or going back to one panel remounts nothing', async () => {
  const dismiss = jest.spyOn(Keyboard, 'dismiss');
  await tablet();
  expect(screen.getByLabelText('Pantalla de la terminal')).toBeVisible();
  expect(screen.getByLabelText('Carpeta actual')).toBeVisible();
  expect(screen.getByLabelText('Teclado en el panel 1')).toBeSelected();
  expect(screen.getByLabelText('Teclado en el panel 2')).not.toBeSelected();
  expect(screen.getByText('RECIBE EL TECLADO')).toBeVisible();
  expect(screen.getByText('TOCA PARA ESCRIBIR AQUÍ')).toBeVisible();
  const [terminal] = aliveSurfaces();
  expect(terminal!.props.input).toBe(true);

  // A touch anywhere in the files panel moves the keyboard there: the terminal stops taking keys.
  dismiss.mockClear();
  fireEvent(screen.getByLabelText('Abrir notas.txt'), 'touchStart');
  await settle();
  expect(screen.getByLabelText('Teclado en el panel 2')).toBeSelected();
  expect(screen.getByLabelText('Teclado en el panel 1')).not.toBeSelected();
  expect(terminal!.props.input).toBe(false);
  expect(dismiss).toHaveBeenCalled();
  // The tag moves with the keyboard: one «RECIBE EL TECLADO», now beside the files, and the terminal asks for the touch.
  expect(screen.getAllByText('RECIBE EL TECLADO')).toHaveLength(1);
  expect(screen.getByLabelText('Teclado en el panel 2')).toHaveTextContent('RECIBE EL TECLADO');
  expect(screen.getByLabelText('Teclado en el panel 1')).toHaveTextContent('TOCA PARA ESCRIBIR AQUÍ');

  // The terminal chosen in panel 2 swaps with Archivos, and takes the keyboard back: the same surface.
  const listed = remote(serverA).length;
  fireEvent.press(screen.getByLabelText('Terminal en el panel 2'));
  await settle();
  expect(screen.getByLabelText('Archivos en el panel 1')).toBeVisible();
  expect(screen.getByLabelText('Carpeta actual')).toBeVisible();
  expect(terminal!.props.input).toBe(true);
  expect(aliveSurfaces()).toEqual([terminal]);

  // One panel: the focused tool alone; Archivos waits mounted, and two panels bring it back as it was.
  fireEvent.press(screen.getByLabelText('Un panel'));
  await settle();
  expect(screen.getByLabelText('Pantalla de la terminal')).toBeVisible();
  expect(screen.getByLabelText('Carpeta actual', { includeHiddenElements: true })).not.toBeVisible();
  expect(screen.queryByLabelText('Teclado en el panel 1')).toBeNull();
  fireEvent.press(screen.getByLabelText('Dos paneles'));
  await settle();
  expect(screen.getByLabelText('Carpeta actual')).toBeVisible();
  expect(aliveSurfaces()).toEqual([terminal]);
  expect(remote(serverA).slice(listed)).toEqual([]);
});

test('a portrait tablet has room for one panel: turning it shows the focused tool alone and back both, remounting nothing', async () => {
  await tablet();
  fireEvent(screen.getByLabelText('Abrir notas.txt'), 'touchStart');
  await settle();
  const [terminal] = aliveSurfaces();
  await act(async () => { resizeWindow(800, 1200); });
  await settle();
  expect(screen.queryByLabelText('Dos paneles')).toBeNull();
  expect(screen.getByLabelText('Carpeta actual')).toBeVisible();
  expect(screen.getByLabelText('Pantalla de la terminal', { includeHiddenElements: true })).not.toBeVisible();
  expect(terminal!.props.input).toBe(false);
  await act(async () => { resizeWindow(1200, 800); });
  await settle();
  expect(screen.getByLabelText('Pantalla de la terminal')).toBeVisible();
  expect(screen.getByLabelText('Teclado en el panel 2')).toBeSelected();
  expect(aliveSurfaces()).toEqual([terminal]);
});

test('a lock hides both panels and sends nothing; a revocation removes both', async () => {
  const app = await tablet();
  await act(async () => { await jest.advanceTimersByTimeAsync(61_000); });
  expect(screen.getByText('Relay está bloqueado')).toBeVisible();
  expect(screen.getByLabelText('Carpeta actual', { includeHiddenElements: true })).not.toBeVisible();
  expect(aliveSurfaces()).toEqual([]);
  const locked = remote(serverA).length;
  await act(async () => { await jest.advanceTimersByTimeAsync(30_000); });
  expect(remote(serverA).slice(locked)).toEqual([]);

  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  await act(async () => { fireEvent.press(screen.getByText('Usar el código del teléfono')); });
  await settle();
  await enter();
  expect(screen.getByLabelText('Teclado en el panel 1')).toBeVisible();
  expect(screen.getByLabelText('Carpeta actual')).toBeVisible();

  respond(serverA.url, '/v1/agents', json({ error: { code: 'device_revoked', message: 'hidden' } }, 403));
  await act(async () => { await jest.advanceTimersByTimeAsync(5_000); });
  expect(screen.getByText('SIN ACCESO')).toBeVisible();
  expect(screen.queryByLabelText('Carpeta actual', { includeHiddenElements: true })).toBeNull();
  expect(screen.queryByLabelText('Teclado en el panel 1')).toBeNull();
  expect(aliveSurfaces()).toEqual([]);
  expect(app.probe.current?.servers).toHaveLength(1);
});

/** The actual root layout on a phone, with the Conversación as the route below the tools: each Servidor with its home and file. */
async function root(servers: [ServerEntry, string, string][], beside: React.ReactNode = null) {
  seed(servers.map(([server]) => server), { ...settings, autoLockMs: 900_000 });
  for (const [server] of servers) polling(server, [agentA]);
  const tools = servers.map(([server, home, file]) => serveTools(server, home, file));
  respond(serverA.url, '/v1/server', json({ host: 'fixture', hermesVersion: 'fixture', profiles: 1, chat: { available: true, reason: null } }));
  respond(serverA.url, '/v1/agents/agentA/transcript', json({ sessionId: conversationA.id, conversation: conversationA, items: [{ kind: 'assistant', id: 'message', text: 'Contenido de la Conversación', at: conversationA.startedAt }] }));
  navigation.pathname = '/chat/A/agentA';
  navigation.params = { server: 'A', agent: 'agentA' };
  navigation.stackContent = <><ChatScreen serverId="A" agentId="agentA" />{beside}</>;
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  render(<SafeAreaProvider><RootLayout /></SafeAreaProvider>);
  await waitFor(() => expect(screen.getByText('Contenido de la Conversación')).toBeVisible());
  return tools;
}
const editor = () => screen.getByLabelText('Texto de notas.txt', { includeHiddenElements: true });

test('from a Conversación the tools open and go back to it; terminal, folder, copied path and draft change nothing there and are kept', async () => {
  const [tools] = await root([[serverA, '/home/ana', 'notas.txt']]);
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Borrador de la Conversación');
  const transcripts = requests.filter((r) => r.path === '/v1/agents/agentA/transcript').length;

  fireEvent.press(screen.getByLabelText('Herramientas de Servidor A'));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/tools/[server]', params: { server: 'A' } });
  const chat = { name: 'chat/[server]/[agent]', key: 'chat', params: { server: 'A', agent: 'agentA' } };
  await act(async () => { showRoute('/tools/A', { server: 'A' }, stackOf(tabsRoute('agents'), chat, { name: 'tools/[server]', key: 'tools', params: { server: 'A' } })); });
  expect(screen.getByText('PON TU HUELLA PARA ENTRAR')).toBeVisible();
  await enter();
  await tools.connect();
  fireEvent.press(screen.getByLabelText('Archivos'));
  await settle();
  fireEvent.press(screen.getByLabelText('Acciones de notas.txt'));
  await act(async () => { fireEvent.press(screen.getByLabelText('Copiar ruta')); });
  expect(clipboard.setStringAsync).toHaveBeenCalledWith('/home/ana/notas.txt');
  fireEvent.press(screen.getByLabelText('Terminal aquí'));
  await settle();
  expect(screen.getByLabelText('Carpeta de la terminal').props.value).toBe('/home/ana');
  fireEvent.press(screen.getByLabelText('Archivos'));
  await act(async () => { fireEvent.press(screen.getByLabelText('Abrir notas.txt')); });
  await settle();
  fireEvent.changeText(editor(), 'uno\ndos\n');

  // The tools host is drawn after the stack: its return is the last one (the Conversación under it reads the same root).
  expect(screen.getAllByText('‹ Agente A').at(-1)).toBeVisible();
  fireEvent.press(screen.getAllByLabelText('Volver a Agente A').at(-1)!);
  expect(router.back).toHaveBeenCalledTimes(1);
  await act(async () => { showRoute('/chat/A/agentA', { server: 'A', agent: 'agentA' }, stackOf(tabsRoute('agents'), chat)); });
  // The same Conversación, never reloaded nor written to; the tools wait out of sight with no keyboard.
  expect(screen.getByText('Contenido de la Conversación')).toBeVisible();
  expect(screen.getByPlaceholderText('Mensaje a Agente A…').props.value).toBe('Borrador de la Conversación');
  expect(requests.filter((r) => r.path === '/v1/agents/agentA/transcript')).toHaveLength(transcripts);
  expect(requests.filter((r) => r.method === 'POST' && !r.path.startsWith('/v1/remote/'))).toEqual([]);
  expect(editor()).not.toBeVisible();
  expect(aliveSurfaces().every((s) => !s.props.input)).toBe(true);

  // Back from the Servidor's screen: no new verification, the draft and the folder as they were.
  const asked = biometrics.authenticateAsync.mock.calls.length;
  await act(async () => { showRoute('/tools/A', { server: 'A' }, stackOf(tabsRoute('servers'), { name: 'server/[server]', key: 'server', params: { server: 'A' } }, { name: 'tools/[server]', key: 'tools', params: { server: 'A' } })); });
  expect(screen.getAllByLabelText('Volver a Servidor A').at(-1)).toBeVisible();
  expect(editor()).toBeVisible();
  expect(editor().props.value).toBe('uno\ndos\n');
  expect(screen.getByText('BORRADOR')).toBeVisible();
  expect(biometrics.authenticateAsync.mock.calls.length).toBe(asked);
  expect(requests.filter((r) => r.path === '/v1/remote/files/read')).toHaveLength(1);
});

test('each Servidor keeps its own tools: another Servidor never shows, types into or acts on the previous one\'s', async () => {
  const [a, b] = await root([[serverA, '/home/ana', 'notas.txt'], [serverB, '/home/beto', 'otro.txt']]);
  await act(async () => { showRoute('/tools/A', { server: 'A' }); });
  await enter();
  await a.connect();
  fireEvent.press(screen.getByLabelText('Archivos'));
  await settle();
  await act(async () => { fireEvent.press(screen.getByLabelText('Abrir notas.txt')); });
  await settle();
  fireEvent.changeText(editor(), 'uno\ndos\n');
  fireEvent.press(screen.getByLabelText('Terminal'));
  await settle();
  const [terminalA] = aliveSurfaces();
  expect(terminalA!.props.input).toBe(true);

  await act(async () => { showRoute('/tools/B', { server: 'B' }); });
  // B asks for its own entry; A's terminal takes no keys and A receives nothing more.
  const sentToA = remote(serverA).length;
  expect(screen.getByText('PON TU HUELLA PARA ENTRAR')).toBeVisible();
  expect(screen.getByText('SERVIDOR · SERVIDOR B')).toBeVisible();
  expect(editor()).not.toBeVisible();
  expect(terminalA!.props.input).toBe(false);
  await enter();
  await b.connect();
  fireEvent.press(screen.getByLabelText('Archivos'));
  await settle();
  expect(screen.getByLabelText('Abrir otro.txt')).toBeVisible();
  expect(editor()).not.toBeVisible();
  const terminalB = aliveSurfaces().find((s) => s !== terminalA)!;
  expect(terminalB.props.input).toBe(false);
  expect(terminalA!.props.input).toBe(false);
  expect(remote(serverA).slice(sentToA)).toEqual([]);
  expect(remote(serverB)).toContain('POST /v1/remote/files/list');

  // Back to A: its draft, without asking again; B's tools wait with no keyboard.
  const asked = biometrics.authenticateAsync.mock.calls.length;
  await act(async () => { showRoute('/tools/A', { server: 'A' }); });
  expect(screen.getByText('SERVIDOR · SERVIDOR A')).toBeVisible();
  expect(terminalA!.props.input).toBe(true);
  expect(terminalB.props.input).toBe(false);
  expect(screen.getByLabelText('Abrir otro.txt', { includeHiddenElements: true })).not.toBeVisible();
  fireEvent.press(screen.getByLabelText('Archivos'));
  expect(editor()).toBeVisible();
  expect(editor().props.value).toBe('uno\ndos\n');
  expect(biometrics.authenticateAsync.mock.calls.length).toBe(asked);
});

test('a Servidor that is no longer paired drops its kept tools and is sent nothing more; the other Servidor keeps its own', async () => {
  // The app's own action, from inside the real provider: what «Quitar Servidor» calls.
  let removeServer: ((id: string) => Promise<void>) | null = null;
  function Remover() { removeServer = useApp().removeServer; return null; }
  const [a, b] = await root([[serverA, '/home/ana', 'notas.txt'], [serverB, '/home/beto', 'otro.txt']], <Remover />);
  await act(async () => { showRoute('/tools/A', { server: 'A' }); });
  await enter();
  await a.connect();
  const [terminalA] = aliveSurfaces();
  await act(async () => { showRoute('/tools/B', { server: 'B' }); });
  await enter();
  await b.connect();
  const terminalB = aliveSurfaces().find((s) => s !== terminalA)!;
  expect(terminalA!.alive && terminalB.alive).toBe(true);

  await act(async () => { await removeServer!('A'); });
  await settle();
  const sentToA = remote(serverA).length;
  expect(terminalA!.alive).toBe(false);
  expect(terminalB.alive).toBe(true);
  expect(screen.getByText('SERVIDOR · SERVIDOR B')).toBeVisible();
  // Its revoked access already closed its channels (#82); the host also lets the instance go.
  expect(screen.queryAllByText(/^SERVIDOR · /, { includeHiddenElements: true })).toHaveLength(1);
  await act(async () => { await jest.advanceTimersByTimeAsync(30_000); });
  expect(remote(serverA).slice(sentToA)).toEqual([]);
});

test('on the phone the gate keeps the tab bar in the real layout, the entry swaps it for the tool bar, and leaving shows no tool bar', async () => {
  const [tools] = await root([[serverA, '/home/ana', 'notas.txt']]);
  // The host paints over the tabs' own bar (the stack's sibling), so the gate draws the tabs itself: SIN CONTROL and the gate need a way out.
  await act(async () => { showRoute('/tools', {}, stackOf(tabsRoute('tools'))); });
  expect(screen.getByText('PON TU HUELLA PARA ENTRAR')).toBeVisible();
  expect(screen.getAllByRole('tab')).toHaveLength(8);
  expect(screen.getByRole('tab', { name: 'HERRAM.' })).toBeSelected();
  fireEvent.press(screen.getByRole('tab', { name: 'AGENTES' }));
  expect(router.dismissTo).toHaveBeenCalledWith('/agents');
  await enter();
  await tools.connect();
  expect(screen.queryAllByRole('tab')).toHaveLength(0);
  expect(screen.getByLabelText('Terminal')).toBeSelected();
  await act(async () => { showRoute('/agents', {}, stackOf(tabsRoute('agents'))); });
  expect(screen.queryByLabelText('Archivos')).toBeNull();
  expect(screen.queryAllByRole('tab')).toHaveLength(0);
});
