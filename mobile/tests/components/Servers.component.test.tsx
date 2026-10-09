import { useState } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { demoServerUsage } from '@/core/serverUsageDemo';
import { ConnectScreen } from '@/screens/ConnectScreen';
import { ServerListScreen } from '@/screens/ServerListScreen';
import { ServerScreen } from '@/screens/ServerScreen';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { RelayShell } from '@/ui/RelayShell';
import { agentA, health, polling, seed, serverA, serverB, serverInfo } from '../support/fixtures';
import { drag } from '../support/gestures';
import { clockStart, emitAppState, navigation, resizeWindow, router } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, networkError, requestsFor, respond } from '../support/transport';

const metricsHealth = { ...health, capabilities: { metrics: { version: 1, minAppVersion: 1 } } };
const reading = { cpuPercent: 61, memoryPercent: 31, diskPercent: 82, measuredAt: clockStart };
// 6 days, 4 h and 12 min.
const active = { state: 'active', pid: 2291, port: 8642, uptimeSeconds: 533_520 };
const ready = { paused: false, hermesPaused: false, phase: 'ready', action: null };
const paused = { paused: true, hermesPaused: true, phase: 'ready', action: null };

function ficha({ metrics = true } = {}) {
  seed([serverA, serverB]); polling(serverA, [agentA]); polling(serverB);
  if (metrics) respond(serverA.url, '/health', json(metricsHealth));
  respond(serverA.url, '/v1/server', json(serverInfo));
  respond(serverA.url, '/v1/gateway', json(active));
  respond(serverA.url, '/v1/jobs', json({ jobs: [] }));
  respond(serverA.url, '/v1/usage?period=week', json(demoServerUsage('week')));
  respond(serverA.url, '/v1/logs?lines=100&level=DEBUG', json({ lines: [] }));
  respond(serverA.url, '/v1/metrics', json(reading));
}

/** The real ficha, which a test can hide (leaving it) or redraw after changing the focus double. */
async function mountFicha() {
  let hide!: () => void;
  let redraw!: () => void;
  function Ficha() {
    const [shown, setShown] = useState(true);
    const [, setTick] = useState(0);
    hide = () => setShown(false); redraw = () => setTick(tick => tick + 1);
    // LockGate provides content visibility in the app; the ficha reads only while it shows.
    return <ChatVisibilityProvider value>{shown ? <ServerScreen serverId="A" /> : null}</ChatVisibilityProvider>;
  }
  const app = renderApp(<Ficha />); await app.ready();
  await waitFor(() => expect(screen.getByText('ACTIVO')).toBeVisible());
  return { ...app, hide: () => act(() => hide()), redraw: () => act(() => redraw()) };
}
const metricReads = () => requestsFor(serverA.url, '/v1/metrics').length;
const advance = (ms: number) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });

describe('the instrument row', () => {
  test('with metrics the three needles read it, asked every 5 s only while the ficha shows', async () => {
    ficha();
    const app = await mountFicha();
    await waitFor(() => expect(screen.getByText('61 %')).toBeVisible());
    expect(screen.getByText('31 %')).toBeVisible();
    expect(screen.getByText('82 %')).toBeVisible();
    for (const label of ['CPU', 'MEM', 'DISCO']) expect(screen.getByText(label)).toBeVisible();
    expect(screen.queryByText('VIEJA')).toBeNull();
    const first = metricReads();
    await advance(5000);
    expect(metricReads()).toBe(first + 1);
    await advance(5000);
    expect(metricReads()).toBe(first + 2);

    // Leaving the ficha: no more readings.
    navigation.focused = false; app.redraw();
    await advance(20_000);
    expect(metricReads()).toBe(first + 2);
    navigation.focused = true; app.redraw();
    await advance(0);
    expect(metricReads()).toBe(first + 3);

    // Relay in the background: no more readings.
    await act(async () => { emitAppState('background'); });
    await advance(20_000);
    expect(metricReads()).toBe(first + 3);
    await act(async () => { emitAppState('active'); });
    await advance(0);
    expect(metricReads()).toBe(first + 4);

    app.hide();
    await advance(20_000);
    expect(metricReads()).toBe(first + 4);
  });

  test('a Puente without metrics says so instead of the needles and is never asked', async () => {
    ficha({ metrics: false });
    await mountFicha();
    expect(await screen.findByText('Actualiza el Puente para ver CPU, MEM y DISCO')).toBeVisible();
    expect(screen.queryByText('CPU')).toBeNull();
    await advance(15_000);
    expect(metricReads()).toBe(0);
  });

  test('a failed reading keeps the last one, marked VIEJA, until a good one comes', async () => {
    ficha();
    await mountFicha();
    await waitFor(() => expect(screen.getByText('61 %')).toBeVisible());
    respond(serverA.url, '/v1/metrics', networkError);
    await advance(5000);
    expect(screen.getByText('61 %')).toBeVisible();
    expect(screen.getAllByText('VIEJA')).toHaveLength(3);
    respond(serverA.url, '/v1/metrics', json({ ...reading, cpuPercent: 12, measuredAt: clockStart + 10_000 }));
    await advance(5000);
    expect(screen.getByText('12 %')).toBeVisible();
    expect(screen.queryByText('VIEJA')).toBeNull();
  });

  test('the odometer reads uptimeSeconds as seconds: 533 520 s is 6 D 04:12', async () => {
    ficha();
    await mountFicha();
    expect(screen.getByLabelText('6D04:12')).toBeVisible();
  });

  test.each([
    ['Herramientas', () => expect(router.push).toHaveBeenCalledWith({ pathname: '/tools/[server]', params: { server: 'A' } })],
    ['Tareas programadas', () => expect(router.dismissTo).toHaveBeenCalledWith('/jobs')],
    ['Uso y costo', () => expect(router.push).toHaveBeenCalledWith({ pathname: '/usage/[server]', params: { server: 'A' } })],
  ])('the destination %s opens this Servidor\'s section and leaves it selected', async (title, opened) => {
    ficha();
    const app = await mountFicha();
    act(() => app.probe.current!.selectServer('B'));
    expect(screen.getByText('PIDE HUELLA')).toBeVisible();
    await waitFor(() => expect(screen.getByText('≈ $1.08 SEM.')).toBeVisible());
    fireEvent.press(screen.getByText(title));
    opened();
    expect(app.probe.current!.selectedServer).toBe('A');
  });
});

describe('Pausa general', () => {
  const pauses = () => requestsFor(serverA.url, '/v1/server/pause').length;
  const holdRed = () => screen.getByRole('button', { name: 'Mantener para pausar el Servidor' });
  async function pausable() {
    ficha();
    respond(serverA.url, '/v1/server/pause', () => { respond(serverA.url, '/v1/server/control', json(paused)); return json(paused); }, 'POST');
    const app = await mountFicha();
    await waitFor(() => expect(screen.getByText('Pausar Servidor A')).toBeVisible());
    return app;
  }

  test('a lid lifted below 55 % falls back and arms nothing', async () => {
    await pausable();
    drag('pause-lid', [{ y: -20 }, { y: -43 }]);
    await advance(300);
    expect(screen.queryByRole('button', { name: 'Mantener para pausar el Servidor' })).toBeNull();
    fireEvent.press(screen.getByLabelText('Levantar tapa de Pausa general'));
    await advance(2000);
    expect(screen.queryByRole('button', { name: 'Mantener para pausar el Servidor' })).toBeNull();
    expect(pauses()).toBe(0);
  });

  test('with the lid open, letting go of the red button before 1 s does not pause', async () => {
    await pausable();
    drag('pause-lid', [{ y: -30 }, { y: -60 }]);
    await advance(0);
    fireEvent(holdRed(), 'pressIn');
    await advance(950);
    expect(pauses()).toBe(0);
    fireEvent(holdRed(), 'pressOut');
    await advance(2000);
    expect(pauses()).toBe(0);
    expect(screen.queryByText('PAUSA GENERAL · SERVIDOR A')).toBeNull();
  });

  test('the whole way, lid from 55 % and 1 s on the red button, pauses and shows the strip with Reanudar', async () => {
    await pausable();
    drag('pause-lid', [{ y: -20 }, { y: -44 }]);
    await advance(0);
    fireEvent(holdRed(), 'pressIn');
    await advance(1000);
    expect(pauses()).toBe(1);
    expect(await screen.findByText('PAUSA GENERAL · SERVIDOR A')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reanudar Servidor A con huella' })).toHaveTextContent('Reanudar');
  });
});

describe('a Servidor that does not answer', () => {
  function down() {
    seed([serverA, serverB]); polling(serverA, [agentA]); polling(serverB);
    for (const path of ['/health', '/v1/agents', '/v1/approvals', '/v1/server/control', '/v1/server', '/v1/gateway', '/v1/jobs', '/v1/usage?period=week', '/v1/logs?lines=100&level=DEBUG']) respond(serverB.url, path, networkError);
    respond(serverA.url, '/v1/server', json(serverInfo));
    respond(serverA.url, '/v1/discovery', json({ bridges: [], truncated: false }));
  }

  test('the list keeps its state inside the card, with Reintentar, and no big block', async () => {
    down();
    const app = renderApp(<ServerListScreen />); await app.ready();
    expect(await screen.findByText('SIN RESPUESTA')).toBeVisible();
    expect(screen.getByText('Revisa Tailscale y que el Puente esté corriendo.')).toBeVisible();
    expect(screen.queryByText('SIN RESPUESTA · REVISA TAILNET')).toBeNull();
    expect(screen.queryByText('Abrir Tailscale')).toBeNull();
    expect(screen.getByText('2 SERVIDORES · 1 EN LÍNEA')).toBeVisible();
    const before = requestsFor(serverB.url, '/health').length;
    fireEvent.press(screen.getByRole('button', { name: 'Reintentar' }));
    await advance(0);
    expect(requestsFor(serverB.url, '/health').length).toBeGreaterThan(before);
  });

  test('its ficha shows the big block with Reintentar and Abrir Tailscale', async () => {
    down();
    const app = renderApp(<ServerScreen serverId="B" />); await app.ready();
    expect(await screen.findByText('SIN RESPUESTA · REVISA TAILNET')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeVisible();
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Abrir Tailscale' })); });
    expect(Linking.openURL).toHaveBeenCalled();
    expect(screen.queryByText('GATEWAY')).toBeNull();
  });
});

test('Agregar Servidor is a mode: no tab bar on the phone and no rail on the tablet', async () => {
  seed(); polling(serverA);
  for (const width of [390, 1280]) {
    navigation.pathname = '/connect'; resizeWindow(width, 800);
    const app = renderApp(<RelayShell><ConnectScreen /></RelayShell>); await app.ready();
    expect(screen.getByText('Agregar Servidor')).toBeVisible();
    expect(screen.getByText('$ relayd pair')).toBeVisible();
    expect(screen.getByText('Escanear código')).toBeVisible();
    expect(screen.getByText('Escribir el código a mano')).toBeVisible();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByLabelText('Navegación principal')).toBeNull();
    app.unmount();
  }
});
