import { useState } from 'react';
import { LockGate } from '@/screens/LockGate';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { ServerScreen } from '@/screens/ServerScreen';
import { polling, seed, serverA, serverB, serverInfo, settings } from '../support/fixtures';
import { biometrics, deferred, emitAppState, navigation } from '../support/native';
import { renderApp } from '../support/renderApp';
import { drag } from '../support/gestures';
import { json, respond, requestsFor } from '../support/transport';

async function setup(paused = false, protectedControls = false) {
  seed([serverA, serverB], { ...settings, faceid: protectedControls });
  if (protectedControls) biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  for (const server of [serverA, serverB]) fixtures(server, paused);
  let redraw!: () => void;
  let select!: (id: string) => void;
  let hide!: () => void;
  function Controlled() {
    const [id, setId] = useState('A');
    const [mounted, setMounted] = useState(true);
    const [, setTick] = useState(0);
    redraw = () => setTick((tick) => tick + 1); select = setId; hide = () => setMounted(false);
    return <LockGate>{mounted ? <ServerScreen serverId={id} /> : null}</LockGate>;
  }
  const app = renderApp(<Controlled />); await app.ready();
  await waitFor(() => expect(screen.getByText('DETENIDO')).toBeVisible());
  return { ...app, redraw: () => redraw(), select: (id: string) => select(id), hide: () => hide() };
}
function fixtures(server: typeof serverA, paused: boolean) {
  polling(server);
  respond(server.url, '/v1/server', json(serverInfo));
  respond(server.url, '/v1/gateway', json({ state: 'stopped', pid: null, port: null, uptimeSeconds: null }));
  respond(server.url, '/v1/server/control', json({ paused, hermesPaused: paused, phase: 'ready', action: null }));
  respond(server.url, '/v1/usage?period=week', json({ error: { code: 'unavailable', message: 'Fixture usage unsupported' } }, 503));
  respond(server.url, '/v1/jobs', json({ jobs: [] }));
  respond(server.url, '/v1/logs?lines=100&level=DEBUG', json({ lines: [] }));
}

test('resume requires strong fingerprint, cancellation sends nothing and pending waits for ACK', async () => {
  await setup(true);
  await act(async () => { fireEvent.press(screen.getByText('Reanudar con huella')); });
  expect(requestsFor(serverA.url, '/v1/server/resume')).toHaveLength(0);
  expect(biometrics.authenticateAsync).toHaveBeenCalledWith(expect.objectContaining({ disableDeviceFallback: true, biometricsSecurityLevel: 'strong' }));
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  const pending = deferred<Response>(); respond(serverA.url, '/v1/server/resume', pending.promise, 'POST');
  await act(async () => { fireEvent.press(screen.getByText('Reanudar con huella')); });
  expect(screen.getByText('REANUDANDO…')).toBeVisible();
  expect(screen.queryByText('↑ LEVANTAR')).toBeNull();
  await act(async () => { pending.resolve(json({ paused: false, hermesPaused: false, phase: 'ready', action: null })); });
  expect(screen.getByText('↑ LEVANTAR')).toBeVisible();
});

test('pause is free after lifting the lid and holding the red button; gateway start requires fingerprint and stop requires confirmation', async () => {
  await setup();
  respond(serverA.url, '/v1/server/pause', json({ paused: true, hermesPaused: true, phase: 'ready', action: null }), 'POST');
  drag('pause-lid', [{ y: -60 }]);
  await act(async () => { await jest.advanceTimersByTimeAsync(0); });
  fireEvent(screen.getByLabelText('Mantener para pausar el Servidor'), 'pressIn');
  await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
  expect(screen.getByText('EN PAUSA')).toBeVisible(); expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(screen.getByText('Iniciar')); });
  expect(requestsFor(serverA.url, '/v1/gateway/start')).toHaveLength(0);
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  respond(serverA.url, '/v1/gateway/start', json({ state: 'active', pid: 1, port: null, uptimeSeconds: 0 }), 'POST');
  await act(async () => { fireEvent.press(screen.getByText('Iniciar')); });
  fireEvent.press(screen.getByText('Detener'));
  expect(requestsFor(serverA.url, '/v1/gateway/stop')).toHaveLength(0);
  respond(serverA.url, '/v1/gateway/stop', json({ state: 'stopped', pid: null, port: null, uptimeSeconds: null }), 'POST');
  await act(async () => { fireEvent.press(screen.getByText('Detener gateway')); });
  expect(requestsFor(serverA.url, '/v1/gateway/stop')).toHaveLength(1);
});

test('failed resume keeps pause visible; unavailable control and a remote pending action disable dispatch', async () => {
  await setup(true);
  biometrics.authenticateAsync.mockResolvedValue({ success: true });
  respond(serverA.url, '/v1/server/resume', json({ error: { code: 'upstream', message: 'Failure' } }, 502), 'POST');
  await act(async () => { fireEvent.press(screen.getByText('Reanudar con huella')); });
  expect(screen.getByText('El cambio quedó sin confirmar. Revisa el estado y reintenta.')).toBeVisible();
  expect(screen.getByText('EN PAUSA')).toBeVisible(); expect(screen.queryByText('↑ LEVANTAR')).toBeNull();
  respond(serverA.url, '/v1/server/control', json({ paused: true, hermesPaused: null, phase: 'pending', action: 'pause' }));
  await act(async () => { jest.advanceTimersByTime(5000); });
  expect(screen.getByText('PENDIENTE…')).toBeVisible(); expect(screen.getByText('Reanudar con huella')).toBeDisabled();
  respond(serverA.url, '/v1/server/control', () => Promise.reject(new Error('offline')));
  await act(async () => { jest.advanceTimersByTime(5000); });
  expect(screen.getByText('SIN RESPUESTA')).toBeVisible(); expect(screen.getByText('Reanudar con huella')).toBeDisabled();
});

test('gateway restart cancel sends nothing and failed ACK never displays success', async () => {
  await setup();
  fireEvent.press(screen.getByText('Reiniciar')); fireEvent.press(screen.getByText('Cancelar'));
  expect(requestsFor(serverA.url, '/v1/gateway/restart')).toHaveLength(0);
  fireEvent.press(screen.getByText('Reiniciar'));
  const pending = deferred<Response>(); respond(serverA.url, '/v1/gateway/restart', pending.promise, 'POST');
  await act(async () => { fireEvent.press(screen.getByText('Reiniciar gateway')); });
  expect(screen.getByText('PENDIENTE…')).toBeVisible(); expect(screen.queryByText('ACTIVO')).toBeNull();
  await act(async () => { pending.resolve(json({ error: { code: 'upstream', message: 'Failure' } }, 502)); });
  expect(screen.getByText('El cambio del gateway quedó sin confirmar. Reintenta cuando vuelva a responder.')).toBeVisible();
  expect(screen.queryByText('ACTIVO')).toBeNull(); expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
});

for (const boundary of ['hardware', 'enrollment'] as const) {
  test(`missing biometric ${boundary} cannot resume or start gateway`, async () => {
    await setup(true);
    if (boundary === 'hardware') biometrics.hasHardwareAsync.mockResolvedValue(false);
    else biometrics.isEnrolledAsync.mockResolvedValue(false);
    await act(async () => { fireEvent.press(screen.getByText('Reanudar con huella')); });
    await act(async () => { fireEvent.press(screen.getByText('Iniciar')); });
    expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
    expect(requestsFor(serverA.url, '/v1/server/resume')).toHaveLength(0);
    expect(requestsFor(serverA.url, '/v1/gateway/start')).toHaveLength(0);
  });
}


for (const action of ['resume', 'start'] as const) {
  for (const interruption of ['blur', 'background', 'background-batched', 'autolock', 'unmount', 'server', 'client', 'expiry'] as const) {
    test(`${action}: late fingerprint cannot dispatch after ${interruption}, even after visibility or scope returns`, async () => {
      const app = await setup(true, true);
      const auth = deferred<{ success: boolean }>();
      biometrics.authenticateAsync.mockReturnValueOnce(auth.promise);
      const path = action === 'resume' ? '/v1/server/resume' : '/v1/gateway/start';
      for (const server of [serverA, serverB]) respond(server.url, path, json(action === 'resume'
        ? { paused: false, hermesPaused: false, phase: 'ready', action: null }
        : { state: 'active', pid: 1, port: null, uptimeSeconds: 0 }), 'POST');
      await act(async () => { fireEvent.press(screen.getByText(action === 'resume' ? 'Reanudar con huella' : 'Iniciar')); });
      expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(2);
      if (interruption === 'blur') {
        await act(async () => { navigation.focused = false; app.redraw(); });
        await act(async () => { navigation.focused = true; app.redraw(); });
      } else if (interruption === 'background') {
        await act(async () => { emitAppState('background'); });
        await act(async () => { emitAppState('active'); });
      } else if (interruption === 'background-batched') {
        await act(async () => { emitAppState('background'); emitAppState('active'); });
      } else if (interruption === 'autolock') {
        await act(async () => { jest.advanceTimersByTime(60000); });
        expect(screen.getByText('Relay está bloqueado')).toBeVisible();
        biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
        await act(async () => { fireEvent.press(screen.getByText('Usar el código del teléfono')); });
        expect(screen.queryByText('Relay está bloqueado')).toBeNull();
      } else if (interruption === 'unmount') {
        await act(async () => { app.hide(); });
      } else if (interruption === 'server') {
        await act(async () => { app.select('B'); });
        await act(async () => { app.select('A'); });
      } else if (interruption === 'client') {
        await act(async () => { await app.probe.current!.replaceServer('A', { ...serverA, deviceId: 'new-synthetic-device', key: 'new-synthetic-key' }); });
      } else {
        jest.setSystemTime(Date.now() + 60000);
      }
      await act(async () => { auth.resolve({ success: true }); });
      expect(requestsFor(serverA.url, path)).toHaveLength(0);
      expect(requestsFor(serverB.url, path)).toHaveLength(0);
      if (interruption === 'background-batched') {
        biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
        await act(async () => { fireEvent.press(screen.getByText(action === 'resume' ? 'Reanudar con huella' : 'Iniciar')); });
        expect(requestsFor(serverA.url, path)).toHaveLength(1);
      }
    });
  }
}

for (const interruption of ['autolock', 'blur', 'background', 'background-batched', 'server', 'client'] as const) {
  test(`gateway decision closes on ${interruption} and its captured confirm cannot POST after returning`, async () => {
    const app = await setup(false, true);
    respond(serverA.url, '/v1/gateway/restart', json({ state: 'active', pid: 1, port: null, uptimeSeconds: 0 }), 'POST');
    fireEvent.press(screen.getByText('Reiniciar'));
    const confirm = screen.getByText('Reiniciar gateway');
    let button = confirm.parent;
    while (button && typeof button.props.onPress !== 'function') button = button.parent;
    const staleConfirm = button!.props.onPress;
    if (interruption === 'autolock') {
      await act(async () => { jest.advanceTimersByTime(60000); });
    } else if (interruption === 'blur') {
      await act(async () => { navigation.focused = false; app.redraw(); });
    } else if (interruption === 'background') {
      await act(async () => { emitAppState('background'); });
    } else if (interruption === 'background-batched') {
      await act(async () => { emitAppState('background'); emitAppState('active'); });
    } else if (interruption === 'server') {
      await act(async () => { app.select('B'); });
    } else {
      await act(async () => { await app.probe.current!.replaceServer('A', { ...serverA, deviceId: 'new-synthetic-device', key: 'new-synthetic-key' }); });
    }
    expect(screen.queryByText('Reiniciar gateway', { includeHiddenElements: true })).toBeNull();
    if (interruption === 'autolock') {
      expect(screen.getByText('Relay está bloqueado')).toBeVisible();
      biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
      await act(async () => { fireEvent.press(screen.getByText('Usar el código del teléfono')); });
    } else if (interruption === 'blur') {
      await act(async () => { navigation.focused = true; app.redraw(); });
    } else if (interruption === 'background') {
      await act(async () => { emitAppState('active'); });
    } else if (interruption === 'server') {
      await act(async () => { app.select('A'); });
    }
    await act(async () => { staleConfirm(); });
    expect(screen.queryByText('Reiniciar gateway')).toBeNull();
    expect(requestsFor(serverA.url, '/v1/gateway/restart')).toHaveLength(0);
  });
}


test('cancelling a gateway decision retires its callback even if a new decision opens', async () => {
  await setup(false, true);
  respond(serverA.url, '/v1/gateway/restart', json({ state: 'active', pid: 1, port: null, uptimeSeconds: 0 }), 'POST');
  fireEvent.press(screen.getByText('Reiniciar'));
  let button = screen.getByText('Reiniciar gateway').parent;
  while (button && typeof button.props.onPress !== 'function') button = button.parent;
  const staleConfirm = button!.props.onPress;
  fireEvent.press(screen.getByText('Cancelar'));
  fireEvent.press(screen.getByText('Reiniciar'));
  await act(async () => { staleConfirm(); });
  expect(requestsFor(serverA.url, '/v1/gateway/restart')).toHaveLength(0);
  expect(screen.getByText('Reiniciar gateway')).toBeVisible();
});
