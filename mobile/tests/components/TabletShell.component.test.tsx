import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { SettingsScreen } from '@/screens/SettingsScreen';
import { KeyboardAvoidingView, StyleSheet, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { ChatScreen } from '@/screens/ChatScreen';
import { LockGate } from '@/screens/LockGate';
import { RelayShell } from '@/ui/RelayShell';
import { agentA, conversationA, polling, seed, serverA, serverB, serverInfo, settings } from '../support/fixtures';
import { approval } from '../support/fixtures';
import { ApprovalSheet } from '@/screens/ApprovalSheet';
import { biometrics, deferred, emitKeyboard, navigation, resizeWindow, router } from '../support/native';
import ServersTab from '@/app/(tabs)/servers';
import BoardTab from '@/app/(tabs)/board';
import { animatedStyle } from '../support/motion';
import { renderApp } from '../support/renderApp';
import { json, requestsFor, respond } from '../support/transport';

function chatSetup() {
  seed([serverA, serverB], { ...settings, faceid: false });
  polling(serverA, [agentA]); polling(serverB, [{ ...agentA, id: 'other', name: 'Otro Agente' }]);
  for (const server of [serverA, serverB]) respond(server.url, '/v1/server', json(serverInfo));
  respond(serverA.url, '/v1/agents/agentA/transcript', json({ sessionId: conversationA.id, conversation: conversationA, items: [{ kind: 'assistant', id: 'message', text: 'Texto recuperado', at: conversationA.startedAt }] }));
  navigation.pathname = '/chat/A/agentA';
}

const rail = () => screen.getByLabelText('Navegación principal');

test('an expanded window exposes the real Agent list beside chat and switches tabs with dismissTo', async () => {
  chatSetup(); resizeWindow(1200, 800);
  const app = renderApp(<ChatVisibilityProvider value={true}><RelayShell><ChatScreen serverId="A" agentId="agentA" /></RelayShell></ChatVisibilityProvider>); await app.ready();
  await waitFor(() => expect(screen.getByText('Texto recuperado')).toBeVisible());
  expect(within(screen.getByLabelText('Lista de Agentes')).getByText('Agentes')).toBeVisible();
  expect(animatedStyle(rail()).width).toBe(72);
  expect(animatedStyle(screen.getByLabelText('Lista de Agentes')).width).toBe(294);
  fireEvent.press(screen.getByText('Otro Agente'));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/chat/[server]/[agent]', params: { server: 'B', agent: 'other' } });
  expect(screen.getAllByRole('tab')).toHaveLength(8);
  expect(screen.getByRole('tab', { name: 'Agentes' })).toBeSelected();
  fireEvent.press(screen.getByRole('tab', { name: 'Aprobaciones' }));
  expect(router.dismissTo).toHaveBeenCalledWith('/approvals');
  expect(router.navigate).not.toHaveBeenCalled();
  app.unmount();
});

test('an approval remains a global overlay but its command and actions have a bounded tablet reading width', async () => {
  chatSetup(); resizeWindow(1200, 800);
  const app = renderApp(<LockGate><RelayShell><ChatScreen serverId="A" agentId="agentA" /></RelayShell><ApprovalSheet /></LockGate>); await app.ready();
  await waitFor(() => expect(screen.getByText('Texto recuperado')).toBeVisible());
  await act(async () => { app.probe.current!.openApproval(approval()); });
  const command = screen.getByText(/echo fixture/);
  let sheet = command.parent;
  while (sheet && sheet.props.style?.position !== 'absolute') sheet = sheet.parent;
  expect(sheet).toHaveStyle({ width: '100%', maxWidth: 620, alignSelf: 'center' });
});

test('rotation, keyboard and split-window changes preserve the mounted chat draft, transcript and explicit send action', async () => {
  chatSetup(); resizeWindow(1200, 800);
  const app = renderApp(<ChatVisibilityProvider value={true}><RelayShell><ChatScreen serverId="A" agentId="agentA" /></RelayShell></ChatVisibilityProvider>); await app.ready();
  await waitFor(() => expect(screen.getByText('Texto recuperado')).toBeVisible());
  const input = () => screen.getByPlaceholderText('Mensaje a Agente A…');
  fireEvent.changeText(input(), 'Borrador con teclado');
  for (const [width, height] of [[800, 1200], [800, 500], [500, 800], [1200, 800]]) {
    await act(async () => { resizeWindow(width, height); emitKeyboard(height === 500); });
    expect(input().props.value).toBe('Borrador con teclado');
    expect(screen.getByText('Texto recuperado')).toBeVisible();
    expect(screen.getByLabelText('Enviar')).toBeEnabled();
    expect(screen.queryByLabelText('Lista de Agentes') !== null).toBe(width >= 760);
    expect(screen.queryAllByRole('tab')).toHaveLength(width >= 760 ? 8 : 0);
  }
});

test('large native text chooses one readable pane while phone rendering keeps its own bottom navigation', async () => {
  chatSetup(); resizeWindow(1200, 800, 1.6);
  const app = renderApp(<ChatVisibilityProvider value={true}><RelayShell><ChatScreen serverId="A" agentId="agentA" /></RelayShell></ChatVisibilityProvider>); await app.ready();
  await waitFor(() => expect(screen.getByText('Texto recuperado')).toBeVisible());
  expect(screen.queryByLabelText('Lista de Agentes')).toBeNull();
  expect(screen.queryByLabelText('Navegación principal')).toBeNull();
  expect(screen.queryAllByRole('tab')).toHaveLength(0);
});

test('the rail selector re-keys the Tablero tab to the chosen Server without reusing the previous board scope', async () => {
  chatSetup(); navigation.pathname = '/board'; resizeWindow(1200, 800);
  for (const server of [serverA, serverB]) respond(server.url, '/v1/board', json({ cards: [], failedAgents: [], observedAt: conversationA.startedAt }));
  const app = renderApp(<ChatVisibilityProvider value={true}><RelayShell><BoardTab /></RelayShell></ChatVisibilityProvider>); await app.ready();
  await screen.findByText('SIN TARJETAS');
  expect(screen.getAllByRole('tab')).toHaveLength(8);
  expect(screen.getByRole('tab', { name: 'Tablero' })).toBeSelected();
  expect(screen.queryByLabelText(/^Lista de/)).toBeNull();
  const previousReads = requestsFor(serverA.url, '/v1/board').length;
  expect(requestsFor(serverB.url, '/v1/board')).toHaveLength(0);
  fireEvent.press(within(rail()).getByLabelText('Servidor Servidor A'));
  fireEvent.press(await screen.findByLabelText(/^Servidor B, /));
  await waitFor(() => expect(app.probe.current!.selectedServer).toBe('B'));
  await waitFor(() => expect(requestsFor(serverB.url, '/v1/board')).toHaveLength(1));
  expect(requestsFor(serverA.url, '/v1/board')).toHaveLength(previousReads);
  expect(within(rail()).getByLabelText('Servidor Servidor B')).toBeVisible();
  expect(router.dismissTo).not.toHaveBeenCalled();
  expect(router.replace).not.toHaveBeenCalled();
  await act(async () => { await jest.advanceTimersByTimeAsync(300); });
  await screen.findByText('SIN TARJETAS');
  app.unmount();
});

test('the Servidores tab stays mounted while the window changes between phone and rail layouts', async () => {
  chatSetup(); navigation.pathname = '/servers'; resizeWindow(390, 844);
  respond(serverA.url, '/v1/discovery', json({ bridges: [], truncated: false }));
  const app = renderApp(<ChatVisibilityProvider value={true}><RelayShell><ServersTab /></RelayShell></ChatVisibilityProvider>); await app.ready();
  await screen.findByText('No se encontraron Puentes sin emparejar.');
  for (const width of [390, 800, 1200, 390]) {
    await act(async () => { resizeWindow(width, 844); });
    expect(screen.queryAllByRole('tab')).toHaveLength(width >= 760 ? 8 : 0);
    if (width >= 760) expect(screen.getByRole('tab', { name: 'Servidores' })).toBeSelected();
    // The Servidores tab is the list itself: no second list beside it.
    expect(screen.queryByLabelText('Lista de Servidores')).toBeNull();
    expect(screen.getByText('No se encontraron Puentes sin emparejar.')).toBeVisible();
  }
  app.unmount();
});

test('a short landscape window keeps every approval action in a scrollable sheet', async () => {
  chatSetup(); resizeWindow(844, 390);
  const app = renderApp(<LockGate><RelayShell><ChatScreen serverId="A" agentId="agentA" /></RelayShell><ApprovalSheet /></LockGate>); await app.ready();
  await waitFor(() => expect(screen.getByText('Texto recuperado')).toBeVisible());
  await act(async () => { app.probe.current!.openApproval(approval()); });
  const content = screen.getByLabelText('Contenido de la Aprobación');
  let sheet = content.parent;
  while (sheet && sheet.props.style?.position !== 'absolute') sheet = sheet.parent;
  expect(sheet).toHaveStyle({ maxHeight: 390 });
  fireEvent.press(within(content).getByRole('switch', { name: 'Seguro' }));
  expect(within(content).getByRole('button', { name: 'Aprobar' })).toBeEnabled();
  expect(within(content).getByRole('button', { name: 'Rechazar' })).toBeEnabled();
});


test.each([
  [1200, 390, 48, 64, 30],
  [800, 1200, 48, 64, 30],
  [390, 844, 48, 0, 56],
  [1200, 390, 0, 16, 30],
  [390, 844, 0, 0, 30],
])('Shell consumes the bottom OS inset once at %dx%d with inset %d while chat preserves minimum padding', async (width, height, systemBottom, shellBottom, composerBottom) => {
  chatSetup(); seed([serverA, serverB], settings); resizeWindow(width, height);
  const unlock = deferred<{ success: boolean }>();
  biometrics.authenticateAsync.mockReturnValueOnce(unlock.promise);
  const app = renderApp(
    <SafeAreaInsetsContext.Provider value={{ top: 24, bottom: systemBottom, left: 10, right: 10 }}>
      <LockGate><RelayShell><ChatScreen serverId="A" agentId="agentA" /></RelayShell></LockGate>
    </SafeAreaInsetsContext.Provider>,
  );
  await app.ready();
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
  expect(screen.getByText('Relay está bloqueado')).toBeVisible();
  expect(screen.queryByPlaceholderText('Mensaje a Agente A…')).toBeNull();
  await act(async () => { unlock.resolve({ success: true }); });
  await waitFor(() => expect(screen.getByText('Texto recuperado')).toBeVisible());
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Borrador con área segura');
  let composer = screen.getByPlaceholderText('Mensaje a Agente A…').parent;
  while (composer && StyleSheet.flatten(composer.props.style)?.marginBottom === undefined) composer = composer.parent;
  expect(composer).not.toBeNull();
  expect(composer).toHaveStyle({ marginBottom: composerBottom });
  let shell = screen.getByLabelText('Contenido principal').parent;
  while (shell && StyleSheet.flatten(shell.props.style)?.paddingBottom === undefined) shell = shell.parent;
  expect(shell).not.toBeNull();
  expect(shell).toHaveStyle({ paddingBottom: shellBottom });
  expect(screen.getByPlaceholderText('Mensaje a Agente A…').props.value).toBe('Borrador con área segura');
  expect(screen.getByLabelText('Enviar')).toBeEnabled();
});


test.each([1200, 800])('the rail does not charge the bottom OS inset a second time at width %d', async (width) => {
  chatSetup(); resizeWindow(width, 844);
  const app = renderApp(<ChatVisibilityProvider value={true}><SafeAreaInsetsContext.Provider value={{ top: 24, bottom: 48, left: 0, right: 0 }}><RelayShell><ChatScreen serverId="A" agentId="agentA" /></RelayShell></SafeAreaInsetsContext.Provider></ChatVisibilityProvider>); await app.ready();
  await screen.findByText('Texto recuperado');
  let shell = rail().parent;
  while (shell && StyleSheet.flatten(shell.props.style)?.paddingBottom === undefined) shell = shell.parent;
  expect(shell).toHaveStyle({ paddingBottom: 64 });
  for (const pane of [rail(), screen.getByLabelText('Lista de Agentes')]) expect(animatedStyle(pane).paddingBottom).toBeUndefined();
  expect(screen.getAllByRole('tab')).toHaveLength(8);
  app.unmount();
});

// Tablet: the content pane starts below the status bar and the frame's edge (24 + 16), so the
// keyboard covers 40 dp more of it than its own height says.
test.each([[1200, 40, 740], [390, 0, 844]])('the keyboard never covers the composer at width %d', async (width, top, height) => {
  chatSetup(); resizeWindow(width, 844);
  const app = renderApp(<ChatVisibilityProvider value={true}><SafeAreaInsetsContext.Provider value={{ top: 24, bottom: 48, left: 0, right: 0 }}><RelayShell><ChatScreen serverId="A" agentId="agentA" /></RelayShell></SafeAreaInsetsContext.Provider></ChatVisibilityProvider>); await app.ready();
  await screen.findByText('Texto recuperado');
  const avoider = screen.UNSAFE_getByType(KeyboardAvoidingView).findByType(View);
  await act(async () => { fireEvent(avoider, 'layout', { persist() {}, nativeEvent: { layout: { x: 0, y: 0, width, height } } }); });
  await act(async () => { emitKeyboard(true); });
  // The composer's bottom (top + height) must end at the keyboard's top, 844 - 300.
  expect(StyleSheet.flatten(avoider.props.style).paddingBottom).toBe(top + height - 544);
  app.unmount();
});

// A paused Servidor puts its strip (8 + 56 + 8) at the top of the pane, above the screen.
test('with a paused Servidor on a tablet the keyboard still never covers the composer', async () => {
  chatSetup(); respond(serverA.url, '/v1/server/control', json({ paused: true, hermesPaused: true, phase: 'ready', action: null })); resizeWindow(1200, 844);
  const app = renderApp(<ChatVisibilityProvider value={true}><SafeAreaInsetsContext.Provider value={{ top: 24, bottom: 48, left: 0, right: 0 }}><RelayShell><ChatScreen serverId="A" agentId="agentA" /></RelayShell></SafeAreaInsetsContext.Provider></ChatVisibilityProvider>); await app.ready();
  await screen.findByText('Texto recuperado');
  const pane = screen.getByLabelText('Contenido principal');
  expect(within(pane).getAllByText(/^PAUSA GENERAL/)).toHaveLength(1);
  const avoider = screen.UNSAFE_getByType(KeyboardAvoidingView).findByType(View);
  let screenRoot = avoider; while (screenRoot.parent && screenRoot.parent !== pane) screenRoot = screenRoot.parent;
  await act(async () => { fireEvent(screenRoot, 'layout', { nativeEvent: { layout: { x: 0, y: 72, width: 1200, height: 668 } } }); });
  await act(async () => { fireEvent(avoider, 'layout', { persist() {}, nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 668 } } }); });
  await act(async () => { emitKeyboard(true); });
  // The screen ends at 40 + 72 + 668 = 780; the keyboard starts at 844 - 300.
  expect(StyleSheet.flatten(avoider.props.style).paddingBottom).toBe(780 - 544);
  app.unmount();
});

test.each([800, 1200])('rail, list and content follow real theme changes at width %d', async (width) => {
  chatSetup(); resizeWindow(width, 844);
  const app = renderApp(<ChatVisibilityProvider value={true}><ThemeProvider><RelayShell><ChatScreen serverId="A" agentId="agentA" /><SettingsScreen /></RelayShell></ThemeProvider></ChatVisibilityProvider>);
  await app.ready(); await screen.findByText('Texto recuperado');
  for (const [theme, background, list] of [['Claro', '#D8D5CE', '#CBC7BF'], ['Oscuro', '#141413', '#0F0F0E'], ['Claro', '#D8D5CE', '#CBC7BF']]) {
    await act(async () => { fireEvent.press(screen.getByRole('radio', { name: theme })); });
    expect(animatedStyle(rail()).backgroundColor).toBe(background);
    expect(animatedStyle(screen.getByLabelText('Lista de Agentes')).backgroundColor).toBe(list);
    expect(screen.getByLabelText('Contenido principal')).toHaveStyle({ backgroundColor: background });
    expect(screen.getByRole('tab', { name: 'Agentes' })).toBeSelected();
  }
  fireEvent.press(screen.getByRole('tab', { name: 'Aprobaciones' }));
  expect(router.dismissTo).toHaveBeenCalledWith('/approvals');
  app.unmount();
});
