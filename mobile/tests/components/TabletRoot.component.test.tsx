import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootLayout from '@/app/_layout';
import { ChatScreen } from '@/screens/ChatScreen';
import { useApp } from '@/state/app';
import { useEffect } from 'react';
import { agentA, approval, conversationA, polling, seed, serverA, settings } from '../support/fixtures';
import { biometrics, deferred, emitAppState, navigation, resizeWindow } from '../support/native';
import { json, requests, respond } from '../support/transport';

jest.mock('expo-font', () => require('../support/native').fonts);
jest.mock('expo-splash-screen', () => require('../support/native').splash);
jest.mock('expo-status-bar', () => ({ StatusBar: require('../support/native').StatusBar }));

function setup() {
  seed([serverA], settings); polling(serverA, [agentA]);
  respond(serverA.url, '/v1/server', json({ host: 'fixture', hermesVersion: 'fixture', profiles: 1, chat: { available: true, reason: null } }));
  respond(serverA.url, '/v1/agents/agentA/transcript', json({ sessionId: conversationA.id, conversation: conversationA, items: [{ kind: 'assistant', id: 'message', text: 'Contenido privado', at: conversationA.startedAt }] }));
  navigation.pathname = '/chat/A/agentA'; resizeWindow(1200, 800);
}

test('the actual root keeps both tablet panes and approval actions inside LockGate, including a late authentication after idle lock', async () => {
  setup();
  let app: ReturnType<typeof useApp> | undefined;
  function Probe() { const value = useApp(); useEffect(() => { app = value; }); return null; }
  navigation.stackContent = <><ChatScreen serverId="A" agentId="agentA" /><Probe /></>;
  const unlock = deferred<{ success: boolean }>();
  biometrics.authenticateAsync.mockReturnValueOnce(unlock.promise);
  render(<SafeAreaProvider><RootLayout /></SafeAreaProvider>);
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
  expect(screen.getByText('Relay está bloqueado')).toBeVisible();
  expect(screen.queryByText('Agentes')).toBeNull();
  expect(screen.queryAllByRole('tab')).toHaveLength(0);
  await act(async () => { unlock.resolve({ success: true }); });
  await waitFor(() => expect(screen.getByText('Contenido privado')).toBeVisible());
  expect(screen.getByText('Agentes')).toBeVisible();
  expect(screen.getAllByRole('tab')).toHaveLength(8);
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Borrador privado');
  await act(async () => { app!.openApproval(approval()); });
  const approving = deferred<{ success: boolean }>();
  biometrics.authenticateAsync.mockReturnValueOnce(approving.promise);
  fireEvent.press(screen.getByRole('switch', { name: 'Seguro' }));
  fireEvent(screen.getByRole('button', { name: 'Aprobar' }), 'pressIn');
  await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(2));
  await act(async () => { await jest.advanceTimersByTimeAsync(60000); });
  expect(screen.getByText('Relay está bloqueado')).toBeVisible();
  expect(screen.queryByText('Agentes')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Aprobar' })).toBeNull();
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  await act(async () => { fireEvent.press(screen.getByText('Usar el código del teléfono')); });
  await act(async () => { approving.resolve({ success: true }); });
  expect(requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  // Under the open Aprobación the chat is hidden from screen readers but keeps its draft.
  expect(screen.getByPlaceholderText('Mensaje a Agente A…', { includeHiddenElements: true }).props.value).toBe('Borrador privado');
  await act(async () => { emitAppState('background'); });
  // Background still invalidates visibility; the next return at the threshold covers the rail too.
  jest.setSystemTime(Date.now() + 60000);
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: false });
  await act(async () => { emitAppState('active'); });
  expect(screen.queryAllByRole('tab')).toHaveLength(0);
});
