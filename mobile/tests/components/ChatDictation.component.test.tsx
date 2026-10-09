import { useState } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { ChatScreen } from '@/screens/ChatScreen';
import { LockGate } from '@/screens/LockGate';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { biometrics } from '../support/native';
import { agentA, conversationA, polling, seed, serverA, serverInfo } from '../support/fixtures';
import { renderApp } from '../support/renderApp';
import { json, requestsFor, respond } from '../support/transport';
import { emitSpeech, speech } from '../support/dictation';

function setup() {
  seed(); polling(serverA, [agentA]); respond(serverA.url, '/v1/server', json(serverInfo));
  respond(serverA.url, '/v1/agents/agentA/transcript', json({ sessionId: conversationA.sessionId, conversation: conversationA, items: [] }));
  speech.supportsOnDeviceRecognition.mockReturnValue(true);
  speech.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true, status: 'granted' });
  speech.getSupportedLocales.mockResolvedValue({ locales: ['es-US'], installedLocales: ['es-US'] });
  speech.start.mockImplementation(() => {});
}
async function mount() {
  let updateScope!: (scope: { serverId: string; agentId: string }) => void;
  function ContextChat() {
    const [scope, setScope] = useState({ serverId: 'A', agentId: 'agentA' });
    updateScope = setScope;
    return <ChatScreen {...scope} />;
  }
  const app = renderApp(<ChatVisibilityProvider value={true}><ContextChat /></ChatVisibilityProvider>); await app.ready();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Dictar' })).toBeEnabled());
  return { ...app, switchContext: (scope: { serverId: string; agentId: string }) => act(() => updateScope(scope)) };
}
async function hold() {
  fireEvent(screen.getByRole('button', { name: 'Dictar' }), 'pressIn', { nativeEvent: { pageX: 300 } });
  await waitFor(() => expect(speech.start).toHaveBeenCalled());
}
function result(transcript: string, isFinal = false) {
  act(() => emitSpeech('result', { isFinal, results: [{ transcript, confidence: 1, segments: [] }] }));
}
test('an online supported language without an installed local model never opens the microphone', async () => {
  setup(); speech.getSupportedLocales.mockResolvedValue({ locales: ['es-US'], installedLocales: ['en-US'] }); await mount();
  fireEvent(screen.getByRole('button', { name: 'Dictar' }), 'pressIn', { nativeEvent: { pageX: 300 } });
  await waitFor(() => expect(screen.getByText('FALTA EL MODELO DE VOZ')).toBeVisible());
  expect(speech.start).not.toHaveBeenCalled(); expect(speech.requestPermissionsAsync).not.toHaveBeenCalled();
});

test('partials, paused phrases and the release tail become a reviewable draft without sending', async () => {
  setup(); await mount(); await hold();
  expect(speech.getSupportedLocales.mock.invocationCallOrder[0]).toBeLessThan(speech.start.mock.invocationCallOrder[0]);
  expect(speech.start).toHaveBeenCalledWith({ lang: 'es-US', requiresOnDeviceRecognition: true, continuous: true, interimResults: true, recordingOptions: { persist: false } });
  result('Revisa'); result('Revisa los pagos.', true); result('También el');
  expect(screen.getByText('Revisa los pagos. También el')).toBeVisible();
  expect(screen.getByText('DICTANDO')).toBeVisible();
  fireEvent(screen.getByRole('button', { name: 'Dictar' }), 'pressOut');
  expect(screen.getByText('TERMINANDO…')).toBeVisible();
  result('También el último test');
  await act(async () => { await jest.advanceTimersByTimeAsync(999); }); expect(speech.stop).not.toHaveBeenCalled();
  await act(async () => { await jest.advanceTimersByTimeAsync(1); }); expect(speech.stop).toHaveBeenCalledTimes(1);
  await act(async () => { await jest.advanceTimersByTimeAsync(250); });
  expect(screen.getByDisplayValue('Revisa los pagos. También el último test')).toBeVisible();
  expect(requestsFor(serverA.url, '/v1/agents/agentA/runs')).toHaveLength(0);
  expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled();
});

test('denied microphone permission offers settings and never starts recognition', async () => {
  setup(); speech.getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true, status: 'undetermined' });
  speech.requestPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false, status: 'denied' }); await mount();
  fireEvent(screen.getByRole('button', { name: 'Dictar' }), 'pressIn', { nativeEvent: { pageX: 300 } });
  await waitFor(() => expect(screen.getByText('SIN PERMISO DE MICRÓFONO')).toBeVisible());
  expect(speech.start).not.toHaveBeenCalled(); expect(speech.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  const { Linking } = require('react-native'); const settings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
  fireEvent.press(screen.getByRole('button', { name: 'Abrir ajustes' })); expect(settings).toHaveBeenCalledTimes(1);
});

test('a release during a pending locale check never starts recording when the check resolves late', async () => {
  const { deferred } = require('../support/native');
  setup(); const locales = deferred(); speech.getSupportedLocales.mockReturnValue(locales.promise); await mount();
  fireEvent(screen.getByRole('button', { name: 'Dictar' }), 'pressIn', { nativeEvent: { pageX: 300 } });
  fireEvent(screen.getByRole('button', { name: 'Dictar' }), 'pressOut');
  await act(async () => { locales.resolve({ locales: ['es-US'], installedLocales: ['es-US'] }); });
  expect(speech.start).not.toHaveBeenCalled(); expect(screen.queryByText('DICTANDO')).toBeNull();
});
test('background cancellation discards partials and tail results without altering the draft', async () => {
  const { emitAppState } = require('../support/native');
  setup(); await mount(); await hold(); result('Texto que se cancela');
  act(() => emitAppState('background'));
  expect(speech.abort).toHaveBeenCalledTimes(1); result('Texto tardío', true);
  act(() => emitAppState('active'));
  expect(screen.getByDisplayValue('')).toBeVisible(); expect(screen.queryByText('Texto tardío')).toBeNull();
  expect(requestsFor(serverA.url, '/v1/agents/agentA/runs')).toHaveLength(0);
});
test('a horizontal swipe cancels the gesture and a later release never stops or delivers it', async () => {
  setup(); await mount(); await hold(); result('Descartar');
  fireEvent(screen.getByRole('button', { name: 'Dictar' }), 'touchMove', { nativeEvent: { pageX: 220 } });
  fireEvent(screen.getByRole('button', { name: 'Dictar' }), 'pressOut');
  await act(async () => { await jest.advanceTimersByTimeAsync(1250); });
  expect(speech.abort).toHaveBeenCalledTimes(1); expect(speech.stop).not.toHaveBeenCalled(); expect(screen.getByDisplayValue('')).toBeVisible();
});
test('a queued keyboard submit cannot send while listening or finishing', async () => {
  setup(); await mount(); await hold();
  const composer = () => screen.getByPlaceholderText('Mensaje a Agente A…', { includeHiddenElements: true });
  fireEvent.changeText(composer(), 'Borrador del teclado'); fireEvent(composer(), 'submitEditing');
  expect(requestsFor(serverA.url, '/v1/agents/agentA/runs')).toHaveLength(0);
  fireEvent(screen.getByRole('button', { name: 'Dictar' }), 'pressOut');
  fireEvent(composer(), 'submitEditing');
  expect(requestsFor(serverA.url, '/v1/agents/agentA/runs')).toHaveLength(0);
  result('Texto del dictado', true); act(() => emitSpeech('end', null));
  expect(screen.getByDisplayValue('Borrador del teclado Texto del dictado')).toBeVisible();
});

test('an agent replacement cancels ownership and waits for native end before accepting another recording', async () => {
  setup(); const second = { ...agentA, id: 'agentB', name: 'Agente B' };
  polling(serverA, [agentA, second]);
  respond(serverA.url, '/v1/agents/agentB/transcript', json({ sessionId: 'conversation-B', conversation: { ...conversationA, id: 'conversation-B', sessionId: 'conversation-B' }, items: [] }));
  const app = await mount(); await hold(); result('Texto de A'); speech.abort.mockImplementation(() => {});
  app.switchContext({ serverId: 'A', agentId: 'agentB' });
  await waitFor(() => expect(screen.getByPlaceholderText('Mensaje a Agente B…')).toBeVisible());
  expect(speech.abort).toHaveBeenCalledTimes(1);
  result('Resultado tardío de A', true);
  fireEvent(screen.getByRole('button', { name: 'Dictar' }), 'pressIn', { nativeEvent: { pageX: 300 } });
  expect(speech.start).toHaveBeenCalledTimes(1); expect(screen.getByDisplayValue('')).toBeVisible();
  act(() => emitSpeech('end', null));
  await hold(); result('Texto de B');
  fireEvent(screen.getByRole('button', { name: 'Dictar' }), 'pressOut');
  result('Texto de B listo', true); act(() => emitSpeech('end', null));
  expect(screen.getByDisplayValue('Texto de B listo')).toBeVisible();
  expect(screen.queryByText('Resultado tardío de A')).toBeNull();
  speech.abort.mockImplementation(() => emitSpeech('end', null));
});
test('a server replacement during a pending permission request never starts a stale microphone', async () => {
  const { serverB } = require('../support/fixtures'); const { deferred } = require('../support/native');
  setup(); seed([serverA, serverB]); polling(serverB, [agentA]);
  respond(serverB.url, '/v1/server', json(serverInfo));
  respond(serverB.url, '/v1/agents/agentA/transcript', json({ sessionId: conversationA.sessionId, conversation: conversationA, items: [] }));
  const permission = deferred(); speech.getPermissionsAsync.mockReturnValue(permission.promise);
  const app = await mount();
  fireEvent(screen.getByRole('button', { name: 'Dictar' }), 'pressIn', { nativeEvent: { pageX: 300 } });
  await waitFor(() => expect(speech.getPermissionsAsync).toHaveBeenCalled());
  app.switchContext({ serverId: 'B', agentId: 'agentA' });
  await waitFor(() => expect(screen.getByText(/SERVIDOR B/i)).toBeVisible());
  await act(async () => { permission.resolve({ granted: true, canAskAgain: true, status: 'granted' }); });
  expect(speech.start).not.toHaveBeenCalled(); expect(screen.getByDisplayValue('')).toBeVisible();
});
test('unmounting during the release tail aborts and cancels every dictation timer and listener', async () => {
  setup(); const app = await mount(); await hold(); result('Texto sin confirmar');
  fireEvent(screen.getByRole('button', { name: 'Dictar' }), 'pressOut'); app.unmount();
  await act(async () => { await jest.advanceTimersByTimeAsync(1250); });
  expect(speech.abort).toHaveBeenCalledTimes(1); expect(speech.stop).not.toHaveBeenCalled();
  const { speechListenerCount } = require('../support/dictation'); expect(speechListenerCount()).toBe(0);
});
test('failed local capability checks fail closed without requesting permission or recording', async () => {
  setup(); speech.getSupportedLocales.mockRejectedValue(new Error('Private native details')); await mount();
  fireEvent(screen.getByRole('button', { name: 'Dictar' }), 'pressIn', { nativeEvent: { pageX: 300 } });
  await waitFor(() => expect(screen.getByText('NO SE PUDO DICTAR')).toBeVisible());
  expect(screen.queryByText('Private native details')).toBeNull(); expect(speech.start).not.toHaveBeenCalled();
  expect(speech.getPermissionsAsync).not.toHaveBeenCalled();
});

test('the final result arriving after stop supersedes the last partial exactly once', async () => {
  setup(); await mount(); await hold(); result('Última palabra incompleta');
  fireEvent(screen.getByRole('button', { name: 'Dictar' }), 'pressOut');
  await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
  result('Última palabra completa.', true); act(() => emitSpeech('end', null));
  await act(async () => { await jest.advanceTimersByTimeAsync(500); });
  result('Final tardío duplicado', true);
  expect(screen.getByDisplayValue('Última palabra completa.')).toBeVisible();
  expect(requestsFor(serverA.url, '/v1/agents/agentA/runs')).toHaveLength(0);
});
test('opening another conversation cancels recording without depositing text into either draft', async () => {
  setup(); const other = { ...conversationA, id: 'other-conversation', sessionId: 'other-conversation', title: 'Otra conversación' };
  respond(serverA.url, '/v1/agents/agentA/conversations?background=false&limit=50&offset=0', json({ conversations: [conversationA, other], nextOffset: null }));
  respond(serverA.url, '/v1/agents/agentA/transcript?sessionId=other-conversation', json({ sessionId: other.sessionId, conversation: other, items: [] }));
  await mount(); await hold(); result('Parcial del chat anterior');
  fireEvent.press(screen.getByRole('button', { name: 'Abrir conversaciones' }));
  expect(speech.abort).toHaveBeenCalledTimes(1);
  fireEvent.press(await screen.findByRole('button', { name: 'Abrir conversación Otra conversación' }));
  await waitFor(() => expect(screen.getByDisplayValue('')).toBeVisible()); result('Evento tardío', true);
  expect(screen.getByDisplayValue('')).toBeVisible();
});


test('locking Relay cancels accessible dictation and late results cannot enter the hidden draft', async () => {
  setup(); biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  const app = renderApp(<LockGate><ChatScreen serverId="A" agentId="agentA" /></LockGate>); await app.ready();
  await screen.findByRole('button', { name: 'Dictar' });
  fireEvent(screen.getByRole('button', { name: 'Dictar' }), 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
  await waitFor(() => expect(speech.start).toHaveBeenCalledTimes(1));
  result('Texto privado antes del bloqueo');
  await act(async () => { await jest.advanceTimersByTimeAsync(60000); });
  expect(screen.getByText('Relay está bloqueado')).toBeVisible();
  expect(speech.abort).toHaveBeenCalledTimes(1);
  result('Resultado tardío que debe descartarse', true);
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  await act(async () => { fireEvent.press(screen.getByText('Usar el código del teléfono')); });
  expect(screen.getByPlaceholderText('Mensaje a Agente A…')).toHaveProp('value', '');
  expect(requestsFor(serverA.url, '/v1/agents/agentA/runs')).toHaveLength(0);
});
