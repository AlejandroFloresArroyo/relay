import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootLayout from '@/app/_layout';
import { ChatScreen } from '@/screens/ChatScreen';
import { SettingsScreen } from '@/screens/SettingsScreen';
import { useApp } from '@/state/app';
import { THEME_KEY } from '@/core/theme';
import { agentA, approval, conversationA, polling, seed, serverA, serverB, serverInfo, settings } from '../support/fixtures';
import { biometrics, deferred, emitAppState, emitColorScheme, navigation, resizeWindow, StatusBar, stored } from '../support/native';
import { json, requests, requestsFor, respond, streamCount, streamFixture } from '../support/transport';

jest.mock('expo-font', () => require('../support/native').fonts);
jest.mock('expo-splash-screen', () => require('../support/native').splash);
jest.mock('expo-status-bar', () => ({ StatusBar: require('../support/native').StatusBar }));

function setup() {
  seed([serverA, serverB], settings); polling(serverA, [agentA]); polling(serverB);
  respond(serverA.url, '/v1/server', json(serverInfo)); respond(serverB.url, '/v1/server', json(serverInfo));
  respond(serverA.url, '/v1/agents/agentA/transcript', json({ sessionId: conversationA.id, conversation: conversationA, items: [{ kind: 'assistant', id: 'message', text: 'Contenido privado', at: conversationA.startedAt }] }));
  navigation.pathname = '/chat/A/agentA'; resizeWindow(1200, 800);
}

test('actual root reacts while locked, keeps chat draft, Turno, scope and pending approval across theme changes, and rejects late approval authentication', async () => {
  setup(); stored.set(THEME_KEY, '"system"');
  let app: ReturnType<typeof useApp> | undefined;
  function Probe() { const value = useApp(); useEffect(() => { app = value; }); return null; }
  navigation.stackContent = <><ChatScreen serverId="A" agentId="agentA" /><SettingsScreen /><Probe /></>;
  const unlock = deferred<{ success: boolean }>(); biometrics.authenticateAsync.mockReturnValueOnce(unlock.promise);
  const view = render(<SafeAreaProvider><RootLayout /></SafeAreaProvider>);
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
  expect(screen.getByText('Relay está bloqueado')).toBeVisible();
  expect(screen.queryByRole('radio', { name: 'Oscuro' })).toBeNull();
  expect(screen.queryAllByRole('tab')).toHaveLength(0);
  await act(async () => { emitColorScheme('dark'); });
  expect(screen.getByText('Relay está bloqueado')).toHaveStyle({ color: '#E8E6E1' });
  expect(StatusBar.mock.calls.at(-1)![0].style).toBe('light');
  await act(async () => { unlock.resolve({ success: true }); });
  await waitFor(() => expect(screen.queryByText('Contenido privado')).not.toBeNull());
  expect(screen.getByText('Contenido privado')).toBeVisible();
  expect(screen.getByLabelText('Contenido principal')).toHaveStyle({ backgroundColor: '#141413' });
  expect(screen.getByRole('tab', { name: 'Agentes' })).toHaveStyle({ backgroundColor: '#E8E6E1' });
  expect(screen.getByRole('tab', { name: 'Agentes' })).toBeSelected();
  const stream = streamFixture();
  respond(serverA.url, '/v1/agents/agentA/runs', json({ runId: 'theme-run', sessionId: conversationA.id }), 'POST');
  respond(serverA.url, '/v1/runs/theme-run/events', stream.reply);
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Turno sintético');
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Enviar' })); });
  await waitFor(() => expect(streamCount()).toBe(1));
  await act(async () => { stream.emit('id: 1\ndata: {"type":"message.delta","text":"Respuesta en curso"}\n\n'); });
  fireEvent.changeText(screen.getByPlaceholderText('Redirigir sin detener…'), 'Borrador privado');
  await act(async () => { app!.selectServer('B'); app!.openApproval(approval()); });
  const reads = requestsFor(serverA.url, '/v1/agents/agentA/transcript').length;
  const approving = deferred<{ success: boolean }>(); biometrics.authenticateAsync.mockReturnValueOnce(approving.promise);
  fireEvent.press(screen.getByRole('switch', { name: 'Seguro' }));
  fireEvent(screen.getByRole('button', { name: 'Aprobar' }), 'pressIn');
  await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(2));
  // Under the open Aprobación the screen is hidden from screen readers, so these reach it as hidden elements.
  await act(async () => { fireEvent.press(screen.getByLabelText('Claro', { includeHiddenElements: true })); });
  expect(screen.getByPlaceholderText('Redirigir sin detener…', { includeHiddenElements: true }).props.value).toBe('Borrador privado');
  expect(screen.getByText('Respuesta en curso', { includeHiddenElements: true })).toBeOnTheScreen();
  expect(app!.selectedServer).toBe('B');
  expect(app!.sheet?.approval.id).toBe('approval-A');
  expect(streamCount()).toBe(1);
  expect(requestsFor(serverA.url, '/v1/agents/agentA/transcript')).toHaveLength(reads);
  expect(StatusBar.mock.calls.at(-1)![0].style).toBe('dark');
  await act(async () => { emitAppState('background'); });
  await act(async () => { approving.resolve({ success: true }); });
  expect(requests.filter(r => r.path.includes('/decision'))).toHaveLength(0);
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(1);
  await view.unmountAsync();
});
