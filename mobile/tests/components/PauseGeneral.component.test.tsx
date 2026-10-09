import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { ChatRunEvent } from '../../../protocol/protocol';
import { AgentsScreen } from '@/screens/AgentsScreen';
import { ChatScreen } from '@/screens/ChatScreen';
import { LockGate } from '@/screens/LockGate';
import { agentA, conversationA, polling, seed, serverA, serverB, serverInfo, settings } from '../support/fixtures';
import { biometrics, clockStart, deferred, emitAppState } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, networkError, requestsFor, respond, streamFixture } from '../support/transport';

const paused = { paused: true, hermesPaused: true, phase: 'ready', action: null };
const resumed = { paused: false, hermesPaused: false, phase: 'ready', action: null };
const agentB = { ...agentA, id: 'agentB', name: 'Agente B' };
const pause = (server = serverA) => respond(server.url, '/v1/server/control', json(paused));

test('a paused Servidor shows a fixed strip and the pause symbol on its own Agentes only', async () => {
  seed([serverA, serverB]); polling(serverA, [agentA]); polling(serverB, [agentB]); pause();
  const app = renderApp(<AgentsScreen />); await app.ready();
  expect(await screen.findByText('PAUSA GENERAL · SERVIDOR A')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Reanudar Servidor A con huella' })).toBeVisible();
  expect(screen.queryByText('PAUSA GENERAL · SERVIDOR B')).toBeNull();
  expect(await screen.findByText('Agente B')).toBeVisible();
  expect(screen.getAllByLabelText('Agente en pausa')).toHaveLength(1);
  expect(screen.getAllByText('EN PAUSA')).toHaveLength(2); // Servidor A header and its Agente.
});

test('Reanudar needs a strong fingerprint and the strip leaves once the Puente confirms', async () => {
  seed(); polling(serverA, [agentA]); pause();
  const app = renderApp(<AgentsScreen />); await app.ready();
  const resume = await screen.findByRole('button', { name: 'Reanudar Servidor A con huella' });
  await act(async () => { fireEvent.press(resume); });
  expect(biometrics.authenticateAsync).toHaveBeenCalledWith(expect.objectContaining({ disableDeviceFallback: true, biometricsSecurityLevel: 'strong' }));
  expect(requestsFor(serverA.url, '/v1/server/resume')).toHaveLength(0);
  expect(screen.getByText('NO SE CONFIRMÓ LA HUELLA · SIGUE EN PAUSA')).toBeVisible();
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  respond(serverA.url, '/v1/server/resume', () => { respond(serverA.url, '/v1/server/control', json(resumed)); return json(resumed); }, 'POST');
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Reanudar Servidor A con huella' })); });
  await waitFor(() => expect(screen.queryByText('PAUSA GENERAL · SERVIDOR A')).toBeNull());
  expect(requestsFor(serverA.url, '/v1/server/resume')).toHaveLength(1);
  expect(screen.queryByLabelText('Agente en pausa')).toBeNull();
});

async function lateFingerprint() {
  seed(); polling(serverA, [agentA]); pause();
  const app = renderApp(<AgentsScreen />); await app.ready();
  respond(serverA.url, '/v1/server/resume', json(resumed), 'POST');
  const auth = deferred<{ success: boolean }>();
  biometrics.authenticateAsync.mockReturnValueOnce(auth.promise);
  await act(async () => { fireEvent.press(await screen.findByRole('button', { name: 'Reanudar Servidor A con huella' })); });
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1);
  return { app, auth };
}

test('a fingerprint that lands with Relay in the background does not resume', async () => {
  const { auth } = await lateFingerprint();
  await act(async () => { emitAppState('background'); });
  await act(async () => { auth.resolve({ success: true }); });
  expect(requestsFor(serverA.url, '/v1/server/resume')).toHaveLength(0);
  expect(screen.getByText('NO SE CONFIRMÓ LA HUELLA · SIGUE EN PAUSA')).toBeVisible();
});

test('a fingerprint that lands after the Servidor changed client does not resume', async () => {
  const { app, auth } = await lateFingerprint();
  await act(async () => { await app.probe.current!.replaceServer('A', { ...serverA, deviceId: 'new-synthetic-device', key: 'new-synthetic-key' }); });
  await act(async () => { auth.resolve({ success: true }); });
  expect(requestsFor(serverA.url, '/v1/server/resume')).toHaveLength(0);
});

test('the strip cannot resume an unreachable Servidor', async () => {
  seed(); polling(serverA, [agentA]); pause();
  const app = renderApp(<AgentsScreen />); await app.ready();
  expect(await screen.findByRole('button', { name: 'Reanudar Servidor A con huella' })).toBeEnabled();
  respond(serverA.url, '/health', networkError); respond(serverA.url, '/v1/agents', networkError);
  await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
  expect(screen.getByText('PAUSA GENERAL · SERVIDOR A')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Reanudar Servidor A con huella' })).toBeDisabled();
});

test('a pending change on the Servidor disables the strip button', async () => {
  seed(); polling(serverA, [agentA]);
  respond(serverA.url, '/v1/server/control', json({ ...paused, phase: 'pending', action: 'pause' }));
  const app = renderApp(<AgentsScreen />); await app.ready();
  expect(await screen.findByText('CAMBIO PENDIENTE EN EL SERVIDOR')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Reanudar Servidor A con huella' })).toBeDisabled();
});

test('the lock screen never offers to resume', async () => {
  seed([serverA], { ...settings, faceid: true }); polling(serverA, [agentA]); pause();
  const app = renderApp(<LockGate><AgentsScreen /></LockGate>); await app.ready();
  expect(await screen.findByText('Relay está bloqueado')).toBeVisible();
  await act(async () => { await jest.advanceTimersByTimeAsync(5000); });
  expect(screen.queryByRole('button', { name: 'Reanudar Servidor A con huella' })).toBeNull();
});

const root = '/v1/agents/agentA';
const runPath = '/v1/runs/turn-fixture';
const cancelled: ChatRunEvent = { type: 'run.cancelled' };
const markerText = /^PAUSA GENERAL · \d\d:\d\d · EL TURNO SE DETUVO AQUÍ$/;
const poll = () => act(async () => { await jest.advanceTimersByTimeAsync(5000); });

async function startTurn() {
  seed(); polling(serverA, [agentA]);
  const history = { sessionId: conversationA.sessionId, conversation: conversationA, items: [{ kind: 'assistant', id: 'history', text: 'Historial anterior', at: clockStart }] };
  respond(serverA.url, '/v1/server', json(serverInfo));
  respond(serverA.url, `${root}/transcript`, json(history));
  respond(serverA.url, `${root}/transcript?sessionId=${conversationA.sessionId}`, json(history));
  respond(serverA.url, `${root}/runs`, json({ runId: 'turn-fixture', sessionId: conversationA.sessionId, conversationId: conversationA.id, inputMessageId: 'wire-input' }), 'POST');
  const stream = streamFixture(); respond(serverA.url, `${runPath}/events`, stream.reply);
  const app = renderApp(<ChatScreen serverId="A" agentId="agentA" />); await app.ready();
  await screen.findByText('Historial anterior');
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Prueba la migración en staging.');
  fireEvent.press(screen.getByLabelText('Enviar'));
  await waitFor(() => expect(stream.reader.read).toHaveBeenCalled());
  return { cancel: () => act(async () => { stream.emit(`id: 1\ndata: ${JSON.stringify(cancelled)}\n\n`); }) };
}

test('during the pause the chat refuses messages and marks where the Relay Turn stopped', async () => {
  const turn = await startTurn();
  pause();
  await turn.cancel();
  expect(await screen.findByText(markerText)).toBeVisible();
  const composer = screen.getByPlaceholderText('El chat no acepta mensajes en pausa');
  expect(composer).toHaveProp('editable', false);
  expect(screen.getByLabelText('Adjuntar imagen')).toBeDisabled();
  expect(screen.getByLabelText('Dictar')).toBeDisabled();
  expect(screen.getByLabelText('Agente en pausa')).toBeVisible();
  fireEvent.changeText(composer, 'Otro mensaje'); fireEvent(composer, 'submitEditing');
  await act(async () => {});
  expect(requestsFor(serverA.url, `${root}/runs`)).toHaveLength(1);
});

test('a Turn cancelled before the pause gets no marker when the Servidor pauses later', async () => {
  const turn = await startTurn();
  await turn.cancel();
  await poll(); // The Servidor is still running after the cancellation.
  pause(); await poll();
  expect(screen.getByPlaceholderText('El chat no acepta mensajes en pausa')).toBeVisible();
  expect(screen.queryByText(markerText)).toBeNull();
});

test('the marker leaves on resume and does not come back with the next pause', async () => {
  const turn = await startTurn();
  pause();
  await turn.cancel();
  expect(await screen.findByText(markerText)).toBeVisible();
  respond(serverA.url, '/v1/server/control', json(resumed)); await poll();
  expect(screen.getByPlaceholderText('Mensaje a Agente A…')).toBeVisible();
  pause(); await poll();
  expect(screen.getByPlaceholderText('El chat no acepta mensajes en pausa')).toBeVisible();
  expect(screen.queryByText(markerText)).toBeNull();
});

test('a Turn this phone stopped gets no pause marker', async () => {
  const turn = await startTurn();
  respond(serverA.url, `${runPath}/stop`, json({ stopped: true }), 'POST');
  fireEvent.press(screen.getByLabelText('Detener'));
  await waitFor(() => expect(requestsFor(serverA.url, `${runPath}/stop`)).toHaveLength(1));
  pause();
  await turn.cancel(); await poll();
  expect(screen.getByPlaceholderText('El chat no acepta mensajes en pausa')).toBeVisible();
  expect(screen.queryByText(markerText)).toBeNull();
});
