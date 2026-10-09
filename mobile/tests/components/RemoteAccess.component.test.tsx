import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { LockGate } from '@/screens/LockGate';
import { ServerToolsScreen } from '@/screens/ServerToolsScreen';
import { useRemoteAccess, type ServerRemoteAccess } from '@/state/remoteAccess';
import { polling, seed, serverA, serverB, settings } from '../support/fixtures';
import { biometrics, deferred, emitAppState } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, networkError, requests, respond } from '../support/transport';

// The tools of one Servidor behind the system verification, with the real LockGate, AppProvider,
// poll and access core. Only the system prompt (expo-local-authentication), the clock and the
// transport are doubles. `tool` stands where a terminal channel or a transfer will register.
let tool: ServerRemoteAccess;
function Tool() { tool = useRemoteAccess(serverA.id); return null; }

const ENTRY = 'Entrar con huella';
const OPEN = 'Terminal';

async function setup(paused = false) {
  seed([serverA, serverB], { ...settings, faceid: true, autoLockMs: 60_000 });
  polling(serverA); polling(serverB);
  if (paused) respond(serverA.url, '/v1/server/control', json({ paused: true, hermesPaused: true, phase: 'ready', action: null }));
  // Relay starts locked: the launch unlock.
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  const app = renderApp(<LockGate><ServerToolsScreen serverId={serverA.id} /><Tool /></LockGate>);
  await app.ready();
  await waitFor(() => expect(screen.getByText('PON TU HUELLA PARA ENTRAR')).toBeVisible());
  await act(async () => { await jest.advanceTimersByTimeAsync(10); });
  return app;
}

async function enter(result: Promise<{ success: boolean; error?: string }> | { success: boolean; error?: string }) {
  biometrics.authenticateAsync.mockReturnValueOnce(Promise.resolve(result));
  await act(async () => { fireEvent.press(screen.getByLabelText(ENTRY)); });
}

function opened() {
  const closed: string[] = [];
  const release = tool.admit((reason) => { closed.push(reason); });
  return { closed, release };
}

const remoteRequests = () => requests.filter((request) => request.path.startsWith('/v1/remote'));

test('without fingerprint or phone code there is no entry, and nothing can open', async () => {
  await setup();
  await enter({ success: false, error: 'not_enrolled' });
  expect(biometrics.authenticateAsync).toHaveBeenLastCalledWith(expect.objectContaining({ disableDeviceFallback: false }));
  expect(screen.getByText('Este teléfono no tiene huella ni código configurados. Configura uno en los ajustes del teléfono para entrar.')).toBeVisible();
  expect(screen.queryByLabelText(OPEN)).toBeNull();
  expect(tool.admit(() => {})).toBeNull();
});

test('the phone code opens the tools once per Servidor; switching tools does not ask again', async () => {
  await setup();
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  await act(async () => { fireEvent.press(screen.getByText('Usar el código del teléfono')); });
  expect(biometrics.authenticateAsync).toHaveBeenLastCalledWith(expect.objectContaining({ disableDeviceFallback: false }));
  expect(screen.getByLabelText(OPEN)).toBeVisible();
  // This Puente advertises no capability: the terminal this build includes asks for the Puente's update.
  expect(screen.getByText('ACTUALIZA EL PUENTE')).toBeVisible();
  for (const label of ['Archivos', 'Web', 'Navegador', 'Terminal']) fireEvent.press(screen.getByLabelText(label));
  expect(screen.getByLabelText('Terminal')).toBeSelected();
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(2);
  expect(opened().release).not.toBeNull();
  expect(remoteRequests()).toEqual([]);
});

test('a cancelled verification keeps the tools closed', async () => {
  await setup();
  await enter({ success: false, error: 'user_cancel' });
  expect(screen.getByText('No se verificó. Las herramientas siguen cerradas.')).toBeVisible();
  expect(screen.queryByLabelText(OPEN)).toBeNull();
  expect(tool.admit(() => {})).toBeNull();
});

test('a lock in the middle of the entry discards a later success, also after unlocking', async () => {
  await setup();
  const prompt = deferred<{ success: boolean }>();
  await enter(prompt.promise);
  expect(screen.getByText('VERIFICANDO…')).toBeVisible();
  await act(async () => { await jest.advanceTimersByTimeAsync(61_000); });
  expect(screen.getByText('Relay está bloqueado')).toBeVisible();
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  await act(async () => { fireEvent.press(screen.getByText('Usar el código del teléfono')); });
  await waitFor(() => expect(screen.queryByText('Relay está bloqueado')).toBeNull());
  // The entry prompt answers only now, after Relay was unlocked again.
  await act(async () => { prompt.resolve({ success: true }); });
  expect(screen.getByText('Relay se bloqueó durante la verificación. Vuelve a entrar.')).toBeVisible();
  expect(screen.queryByLabelText(OPEN)).toBeNull();
  expect(tool.admit(() => {})).toBeNull();
});

test('locking hides the tools and suspends control without sending anything; unlocking asks again', async () => {
  await setup();
  await enter({ success: true });
  const channel = opened();
  await act(async () => { await jest.advanceTimersByTimeAsync(61_000); });
  expect(screen.getByText('Relay está bloqueado')).toBeVisible();
  expect(screen.queryByLabelText(OPEN)).toBeNull();
  expect(channel.closed).toEqual(['suspended']);
  expect(remoteRequests()).toEqual([]);
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  await act(async () => { fireEvent.press(screen.getByText('Usar el código del teléfono')); });
  await waitFor(() => expect(screen.getByText('PON TU HUELLA PARA ENTRAR')).toBeVisible());
  expect(screen.queryByLabelText(OPEN)).toBeNull();
  expect(tool.admit(() => {})).toBeNull();
});

test('hiding Relay without locking suspends control; coming back admits again without asking', async () => {
  await setup();
  await enter({ success: true });
  for (const hidden of ['background', 'inactive'] as const) {
    const channel = opened();
    await act(async () => { emitAppState(hidden); });
    expect(channel.closed).toEqual(['suspended']);
    expect(tool.admit(() => {})).toBeNull();
    await act(async () => { emitAppState('active'); });
    expect(screen.queryByText('Relay está bloqueado')).toBeNull();
    expect(opened().release).not.toBeNull();
  }
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(2);
  expect(remoteRequests()).toEqual([]);
});

test('a lost connection hides the tools and suspends control; reconnecting recovers it without asking again', async () => {
  await setup();
  await enter({ success: true });
  const channel = opened();
  respond(serverA.url, '/health', networkError); respond(serverA.url, '/v1/agents', networkError);
  await act(async () => { await jest.advanceTimersByTimeAsync(5_000); });
  expect(screen.getByText('SIN CONTROL')).toBeVisible();
  expect(screen.queryByLabelText(OPEN)).toBeNull();
  expect(channel.closed).toEqual(['suspended']);
  expect(tool.admit(() => {})).toBeNull();
  polling(serverA);
  await act(async () => { await jest.advanceTimersByTimeAsync(30_000); });
  await waitFor(() => expect(screen.getByLabelText(OPEN)).toBeVisible());
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(2);
  expect(opened().release).not.toBeNull();
  expect(remoteRequests()).toEqual([]);
});

test('the Pausa general leaves the tools of the person available', async () => {
  await setup(true);
  await waitFor(() => expect(screen.getByText('PAUSA GENERAL · LAS HERRAMIENTAS SIGUEN DISPONIBLES')).toBeVisible());
  await enter({ success: true });
  expect(screen.getByLabelText(OPEN)).toBeVisible();
  expect(opened().release).not.toBeNull();
});

test('revocation cuts what is open and allows no new work until it is cut, even after pairing again', async () => {
  const app = await setup();
  await enter({ success: true });
  const reasons: string[] = [];
  const cut = deferred<void>();
  tool.admit((reason) => { reasons.push(reason); return cut.promise; });
  respond(serverA.url, '/v1/agents', json({ error: { code: 'device_revoked', message: 'hidden' } }, 403));
  await act(async () => { await jest.advanceTimersByTimeAsync(5_000); });
  expect(reasons).toEqual(['revoked']);
  expect(screen.getByText('SIN ACCESO')).toBeVisible();
  expect(screen.queryByLabelText(OPEN)).toBeNull();
  const paired = { ...serverA, deviceId: 'fixture-device-A2', key: 'fixture-key-A2' };
  polling(paired);
  await act(async () => { await app.probe.current!.replaceServer(serverA.id, paired); });
  await act(async () => { await jest.advanceTimersByTimeAsync(5_000); });
  expect(screen.getByText('SIN ACCESO')).toBeVisible();
  expect(screen.queryByLabelText(ENTRY)).toBeNull();
  expect(tool.admit(() => {})).toBeNull();
  await act(async () => { cut.resolve(); });
  await waitFor(() => expect(screen.getByText('PON TU HUELLA PARA ENTRAR')).toBeVisible());
  expect(tool.admit(() => {})).toBeNull();
  await enter({ success: true });
  expect(screen.getByLabelText(OPEN)).toBeVisible();
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(3);
});
