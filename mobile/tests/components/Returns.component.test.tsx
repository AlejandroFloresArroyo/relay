import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { BackHandler } from 'react-native';
import ToolsTab from '@/app/(tabs)/tools';
import ServerToolsRoute from '@/app/tools/[server]';
import { widgetScope } from '@/core/widget';
import { AgentDetailScreen } from '@/screens/AgentDetailScreen';
import { AgentMemoryScreen } from '@/screens/AgentMemoryScreen';
import { AgentSoulScreen } from '@/screens/AgentSoulScreen';
import { AgentToolsScreen } from '@/screens/AgentToolsScreen';
import { ChatScreen } from '@/screens/ChatScreen';
import { LockGate } from '@/screens/LockGate';
import { ServerToolsHost } from '@/screens/ServerToolsHost';
import { ShareScreen } from '@/screens/ShareScreen';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { NotificationProvider } from '@/state/notifications';
import { DraftProvider } from '@/state/sharedDrafts';
import { WidgetBridge, WidgetTarget } from '@/state/WidgetBridge';
import { receiveShare, resetExternalShare } from '../support/externalShare';
import { agentA, conversationA, polling, seed, serverA, serverB, serverInfo, settings } from '../support/fixtures';
import { biometrics, clockStart, navigation, pressBack, router, showRoute, stackOf, tabsRoute } from '../support/native';
import { notificationNative } from '../support/notifications';
import { renderApp } from '../support/renderApp';
import { json, respond } from '../support/transport';
import { openWidget, widgetFollows } from '../support/widget';
// The share receiver is loaded inside the hoisted Jest factory; the VPN module stays as in setup.
/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock('expo', () => {
  const actual = jest.requireActual('expo');
  return { ...actual, requireOptionalNativeModule: (name: string) => name === 'RelayShareReceiver' ? require('../support/externalShare').externalShare : name === 'RelayVpnStatus' ? require('../support/vpn').vpn : actual.requireOptionalNativeModule(name) };
});
/* eslint-enable @typescript-eslint/no-require-imports */
beforeEach(() => resetExternalShare());

const unlocked = { ...settings, faceid: false };
const chat = (params: Record<string, string> = {}) => ({ name: 'chat/[server]/[agent]', key: 'chat', params: { server: 'A', agent: 'agentA', ...params } });
const ficha = { name: 'agent/[server]/[agent]', key: 'ficha', params: { server: 'A', agent: 'agentA' } };
/** The visible return reads `‹ label`; pressing it and Android's back key each make `call`, and the app never exits. */
function expectReturn(label: string, call: jest.Mock, ...args: unknown[]) {
  expect(screen.getByText(`‹ ${label}`)).toBeVisible();
  fireEvent.press(screen.getByLabelText(`Volver a ${label}`));
  expect(call).toHaveBeenCalledTimes(1);
  act(() => pressBack());
  expect(call).toHaveBeenCalledTimes(2);
  expect(call).toHaveBeenLastCalledWith(...args);
  expect(BackHandler.exitApp).not.toHaveBeenCalled();
}

function chatSetup() {
  seed([serverA], unlocked); polling(serverA, [agentA]); respond(serverA.url, '/v1/server', json(serverInfo));
  const history = { sessionId: conversationA.sessionId, conversation: conversationA, items: [{ kind: 'assistant', id: 'h', text: 'Historial anterior', at: clockStart }] };
  respond(serverA.url, '/v1/agents/agentA/transcript', json(history));
  respond(serverA.url, `/v1/agents/agentA/transcript?sessionId=${conversationA.sessionId}`, json(history));
  respond(serverA.url, '/v1/agents/agentA/conversations?background=false&limit=50&offset=0', json({ conversations: [conversationA], nextOffset: null }));
}

test('a chat opened from Agentes returns «‹ Agentes» by going back, also with the back key', async () => {
  chatSetup(); navigation.state = stackOf(tabsRoute('agents'), chat());
  const app = renderApp(<ChatScreen serverId="A" agentId="agentA" />); await app.ready(); await screen.findByText('Historial anterior');
  expectReturn('Agentes', router.back);
  expect(router.dismissTo).not.toHaveBeenCalled();
});

test('an entry flag returns to the hierarchical parent, never to the screen underneath', async () => {
  chatSetup(); navigation.state = stackOf(tabsRoute('board'), chat({ entry: '1' }));
  const app = renderApp(<ChatScreen serverId="A" agentId="agentA" />); await app.ready(); await screen.findByText('Historial anterior');
  expect(screen.queryByText('‹ Tablero')).toBeNull();
  expectReturn('Agentes', router.dismissTo, '/agents');
  expect(router.back).not.toHaveBeenCalled();
});

test.each([false, true])('the Conversaciones panel closes first on back (opened with the chat: %s)', async (initially) => {
  chatSetup(); navigation.state = stackOf(tabsRoute('agents'), chat());
  const app = renderApp(<ChatScreen serverId="A" agentId="agentA" initialPanelOpen={initially} />); await app.ready();
  if (!initially) { await screen.findByText('Historial anterior'); fireEvent.press(screen.getByLabelText('Abrir conversaciones')); }
  await screen.findByText('Conversación nueva');
  act(() => pressBack());
  expect(screen.queryByText('Conversación nueva')).toBeNull();
  expect(router.back).not.toHaveBeenCalled();
  act(() => pressBack());
  expect(router.back).toHaveBeenCalledTimes(1);
  expect(BackHandler.exitApp).not.toHaveBeenCalled();
});

const details = { agentId: 'agentA', name: 'Agente A', status: 'on', capturedAt: clockStart, defaultModel: { provider: 'fixture', model: 'default-model' },
  security: { mode: 'manual', pendingMode: null, deny: [], guardianPolicy: null, revision: 'a'.repeat(64), writable: true, reason: null },
  usage: null, usageError: null, recentConversations: [] };

test('the ficha returns to Agentes; its Aprobaciones page returns «‹ Agente A» to the identity', async () => {
  seed([serverA], unlocked); polling(serverA, [agentA]); respond(serverA.url, '/v1/agents/agentA/details', json(details)); respond(serverA.url, '/v1/agents/agentA/tools', json({ error: { code: 'unavailable', message: 'x' } }, 503)); respond(serverA.url, '/v1/agents/agentA/skills', json({ error: { code: 'unavailable', message: 'x' } }, 503));
  navigation.state = stackOf(tabsRoute('agents'), ficha);
  const app = renderApp(<ChatVisibilityProvider value><AgentDetailScreen serverId="A" agentId="agentA" /></ChatVisibilityProvider>); await app.ready();
  await screen.findByText('default-model');
  expect(screen.getByText('‹ Agentes')).toBeVisible();
  fireEvent.press(screen.getByText('Modo de aprobación'));
  expect(screen.getByText('MODO DE APROBACIÓN')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Volver a Agente A'));
  expect(screen.getByText('default-model')).toBeVisible();
  fireEvent.press(screen.getByText('Modo de aprobación'));
  act(() => pressBack());
  expect(screen.getByText('default-model')).toBeVisible();
  expect(router.back).not.toHaveBeenCalled();
  act(() => pressBack());
  expect(router.back).toHaveBeenCalledTimes(1);
  expect(BackHandler.exitApp).not.toHaveBeenCalled();
});

test('the Server button of the ficha opens that Servidor\'s ficha without selecting it', async () => {
  seed([serverA, serverB], unlocked); polling(serverA, [agentA]); polling(serverB); respond(serverA.url, '/v1/agents/agentA/details', json(details)); respond(serverA.url, '/v1/agents/agentA/tools', json({ error: { code: 'unavailable', message: 'x' } }, 503)); respond(serverA.url, '/v1/agents/agentA/skills', json({ error: { code: 'unavailable', message: 'x' } }, 503));
  navigation.state = stackOf(tabsRoute('agents'), ficha);
  const app = renderApp(<ChatVisibilityProvider value><AgentDetailScreen serverId="A" agentId="agentA" /></ChatVisibilityProvider>); await app.ready();
  await screen.findByText('default-model');
  await act(async () => app.probe.current!.selectServer('B'));
  fireEvent.press(screen.getByLabelText('Ver Servidor'));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/server/[server]', params: { server: 'A' } });
  expect(app.probe.current!.selectedServer).toBe('B');
  expect(screen.queryAllByRole('tab')).toHaveLength(0);
});

test('a ficha subpage returns «‹ Agente A»', async () => {
  seed([serverA], unlocked); polling(serverA, [agentA]);
  respond(serverA.url, '/v1/agents/agentA/memory', json({ error: { code: 'unavailable', message: 'x' } }, 503));
  navigation.state = stackOf(tabsRoute('agents'), ficha, { name: 'agent/[server]/[agent]/memory', key: 'memory', params: { server: 'A', agent: 'agentA' } });
  const app = renderApp(<ChatVisibilityProvider value><AgentMemoryScreen serverId="A" agentId="agentA" /></ChatVisibilityProvider>); await app.ready();
  await screen.findByText('‹ Agente A');
  expectReturn('Agente A', router.back);
});

test('the tools opened with >_ from a chat return «‹ Agente A»', async () => {
  seed([serverA], unlocked); polling(serverA, [agentA]);
  showRoute('/tools/A', { server: 'A' }, stackOf(tabsRoute('agents'), chat(), { name: 'tools/[server]', key: 'tools', params: { server: 'A' } }));
  const app = renderApp(<LockGate><ServerToolsRoute /><ServerToolsHost /></LockGate>); await app.ready();
  await screen.findByText('‹ Agente A');
  expectReturn('Agente A', router.back);
});

test('the Herram. tab returns to the previous tab, or to Agentes with no history', async () => {
  seed([serverA], unlocked); polling(serverA, [agentA]);
  showRoute('/tools', {}, stackOf(tabsRoute('tools', ['board', 'tools'])));
  const app = renderApp(<LockGate><ToolsTab /><ServerToolsHost /></LockGate>); await app.ready();
  // The gate is header A, with no return (D-21); the tab bar and the back key still leave it.
  await screen.findByText('PON TU HUELLA PARA ENTRAR');
  expect(screen.queryByText('‹ Tablero')).toBeNull();
  act(() => pressBack());
  expect(router.back).toHaveBeenCalledTimes(1);
  router.back.mockClear();
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  await act(async () => { fireEvent.press(screen.getByLabelText('Entrar con huella')); });
  await screen.findByText('‹ Tablero');
  expectReturn('Tablero', router.back);
  await act(async () => showRoute('/tools', {}, stackOf(tabsRoute('tools'))));
  expectReturn('Agentes', router.dismissTo, '/agents');
});

test.each([
  ['approval', () => expect(router.push).toHaveBeenCalledWith({ pathname: '/notices/[server]/[notice]', params: { server: 'B', notice: 'notice-B', entry: '1' } })],
  ['task', () => expect(router.dismissTo).toHaveBeenCalledWith('/board')],
] as const)('a %s notification selects its Servidor and opens its place', async (kind, opened) => {
  seed([serverA, serverB], unlocked); polling(serverA); polling(serverB);
  notificationNative.takeOpen.mockReturnValueOnce({ serverId: 'B', noticeId: 'notice-B', kind });
  const app = renderApp(<NotificationProvider><></></NotificationProvider>); await app.ready();
  await waitFor(opened);
  expect(app.probe.current!.selectedServer).toBe('B');
});

test('a share chooses its Servidor and replaces the sheet with the chat, marked as an entry', async () => {
  seed([serverA, serverB], unlocked); polling(serverA); polling(serverB, [agentA]);
  respond(serverB.url, '/v1/server', json(serverInfo));
  receiveShare('11111111-1111-4111-8111-111111111111', { kind: 'text', text: 'Contenido compartido' });
  const app = renderApp(<DraftProvider><LockGate><ShareScreen /></LockGate></DraftProvider>); await app.ready();
  await screen.findByText('Contenido compartido');
  fireEvent.press(screen.getByText('Agente A'));
  await act(async () => { fireEvent.press(screen.getByText('Preparar borrador')); });
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith({ pathname: '/chat/[server]/[agent]', params: expect.objectContaining({ server: 'B', agent: 'agentA', entry: '1' }) }));
  expect(router.push).not.toHaveBeenCalled();
  expect(app.probe.current!.selectedServer).toBe('B');
});

test('a widget tap shows its tab with dismissTo for the selected Servidor it follows', async () => {
  seed([serverA, serverB], unlocked); polling(serverA, [agentA]); polling(serverB, [agentA]);
  const app = renderApp(<><WidgetTarget /><LockGate><WidgetBridge /></LockGate></>); await app.ready();
  await act(async () => app.probe.current!.selectServer('B'));
  const scopeB = widgetScope(serverB.id, serverB.deviceId, serverB.url);
  await waitFor(() => expect(widgetFollows()?.scope).toBe(scopeB));
  await act(async () => { openWidget({ scope: scopeB, target: 'approvals' }); });
  await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith('/approvals'));
  expect(router.navigate).not.toHaveBeenCalled();
  expect(app.probe.current!.selectedServer).toBe('B');
});

test.each([["soul", <AgentSoulScreen key="soul" serverId="A" agentId="agentA" />, 'ERROR'], ["tools", <AgentToolsScreen key="tools" serverId="A" agentId="agentA" />, 'Herramientas y skills']] as const)('the %s subpage of the ficha returns «‹ Agente A»', async (route, screenElement, shown) => {
  seed([serverA], unlocked); polling(serverA, [agentA]);
  respond(serverA.url, `/v1/agents/agentA/${route}`, json({ error: { code: 'unavailable', message: 'x' } }, 503));
  respond(serverA.url, '/v1/agents/agentA/skills', json({ error: { code: 'unavailable', message: 'x' } }, 503));
  navigation.state = stackOf(tabsRoute('agents'), ficha, { name: `agent/[server]/[agent]/${route}`, key: route, params: { server: 'A', agent: 'agentA' } });
  const app = renderApp(<ChatVisibilityProvider value>{screenElement}</ChatVisibilityProvider>); await app.ready();
  await screen.findAllByText(new RegExp(shown));
  expectReturn('Agente A', router.back);
});
