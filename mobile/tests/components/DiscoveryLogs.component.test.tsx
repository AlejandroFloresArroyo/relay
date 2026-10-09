import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { createDemoClient, resetDemo } from '@/core/demo';
import { ServerListScreen } from '@/screens/ServerListScreen';
import { AgentLogs } from '@/screens/AgentLogs';
import { polling, seed, serverA, agentA, serverInfo } from '../support/fixtures';
import { renderApp } from '../support/renderApp';
import { json, respond, requests } from '../support/transport';
import { deferred, router } from '../support/native';

test('discovery needs a paired Puente and leads a found candidate to pairing', async () => {
  seed(); polling(serverA); respond(serverA.url, '/v1/server', json(serverInfo));
  respond(serverA.url, '/v1/discovery', json({ bridges: [{ name: 'nuevo', url: 'http://nuevo.fixture.ts.net:17651', protocolVersion: 2, minAppProtocolVersion: 2 }], truncated: false }));
  const app = renderApp(<ServerListScreen />); await app.ready();
  await waitFor(() => expect(screen.getByText('nuevo')).toBeVisible());
  fireEvent.press(screen.getByRole('button', { name: 'Emparejar nuevo' }));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/connect', params: { discoveredUrl: 'http://nuevo.fixture.ts.net:17651' } });
  expect(requests.filter(r => r.path === '/v1/discovery')).toHaveLength(1);
});

test('no paired Puente means no discovery requests', async () => {
  seed([]); const app = renderApp(<ServerListScreen />); await app.ready();
  expect(screen.getByText('SIN SERVIDORES')).toBeVisible();
  expect(requests.filter(r => r.path === '/v1/discovery')).toHaveLength(0);
});

test('logs default scope, agent and severity filters, and safe error', async () => {
  seed(); polling(serverA, [agentA]);
  respond(serverA.url, '/v1/logs?lines=100&level=DEBUG', json({ lines: [{ t: '10:00', level: 'INFO', msg: 'default text' }] }));
  respond(serverA.url, '/v1/logs?lines=100&level=DEBUG&agentId=agentA', json({ lines: [{ t: '10:01', level: 'WARN', msg: 'agent text' }] }));
  respond(serverA.url, '/v1/logs?lines=100&level=ERROR&agentId=agentA', json({ error: { code: 'upstream', message: 'synthetic-private' } }, 502));
  const app = renderApp(<AgentLogs serverId="A" />); await app.ready();
  await waitFor(() => expect(screen.getByText('default text')).toBeVisible());
  fireEvent.press(screen.getByText('Agente A'));
  await waitFor(() => expect(screen.getByText('agent text')).toBeVisible());
  fireEvent.press(screen.getByText('ERROR'));
  await waitFor(() => expect(screen.getByText('No se pudieron cargar los logs. Reintenta.')).toBeVisible());
  expect(screen.queryByText('synthetic-private')).toBeNull();
  expect(screen.queryByText('default text')).toBeNull();
});

test('discovery shows incompatibility, empty result and safe retry errors', async () => {
  seed(); polling(serverA); respond(serverA.url, '/v1/server', json(serverInfo));
  respond(serverA.url, '/v1/discovery', json({ bridges: [{ name: 'viejo', url: 'http://viejo.fixture.ts.net:17651', protocolVersion: 1, minAppProtocolVersion: 1 }], truncated: false }));
  const app = renderApp(<ServerListScreen />); await app.ready();
  await waitFor(() => expect(screen.getByText('Actualiza el Puente')).toBeVisible());
  respond(serverA.url, '/v1/discovery', json({ bridges: [], truncated: false }));
  fireEvent.press(screen.getByText('Buscar otra vez'));
  await waitFor(() => expect(screen.getByText('No se encontraron Puentes sin emparejar.')).toBeVisible());
  respond(serverA.url, '/v1/discovery', json({ error: { code: 'unavailable', message: 'synthetic-private' } }, 503));
  fireEvent.press(screen.getByText('Buscar otra vez'));
  await waitFor(() => expect(screen.getByText('No se pudo consultar la tailnet. Reintenta.')).toBeVisible());
  expect(screen.queryByText('synthetic-private')).toBeNull();
});

test('offline discovery is distinct from an empty tailnet and never probes candidates', async () => {
  seed();
  respond(serverA.url, '/health', () => Promise.reject(new Error('Synthetic offline')));
  respond(serverA.url, '/v1/agents', () => Promise.reject(new Error('Synthetic offline')));
  respond(serverA.url, '/v1/server', json(serverInfo));
  const app = renderApp(<ServerListScreen />); await app.ready();
  await waitFor(() => expect(screen.getByText('SIN RESPUESTA · Conecta con un Puente emparejado para buscar.')).toBeVisible());
  expect(requests.filter(r => r.path === '/v1/discovery')).toHaveLength(0);
});


for (const change of ['origin', 'pairing'] as const) {
  test(`logs invalidate the previous client when the same Servidor ID changes ${change}`, async () => {
    seed(); polling(serverA);
    const logPath = '/v1/logs?lines=100&level=DEBUG';
    respond(serverA.url, logPath, json({ lines: [{ t: '10:00', level: 'INFO', msg: 'previous client logs' }] }));
    const app = renderApp(<AgentLogs serverId="A" />); await app.ready();
    await waitFor(() => expect(screen.getByText('previous client logs')).toBeVisible());
    expect(screen.getByText('EN VIVO')).toBeVisible();
    const late = deferred<Response>();
    respond(serverA.url, logPath, late.promise);
    fireEvent.press(screen.getByText('Actualizar logs'));
    await waitFor(() => expect(requests.filter(r => r.path === logPath)).toHaveLength(2));
    const replacement = { ...serverA, url: change === 'origin' ? 'http://replacement.fixture.ts.net:17651' : serverA.url, deviceId: 'fixture-repaired-device', key: 'fixture-repaired-key' };
    polling(replacement);
    const next = deferred<Response>();
    respond(replacement.url, logPath, next.promise);
    await act(async () => { await app.probe.current!.replaceServer(serverA.id, replacement); });
    await waitFor(() => expect(requests.filter(r => r.path === logPath && r.headers.get('Authorization') === `Bearer ${replacement.key}`)).toHaveLength(1));
    expect(screen.queryByText('previous client logs')).toBeNull();
    expect(screen.queryByText('EN VIVO')).toBeNull();
    expect(screen.getByText('Cargando logs…')).toBeVisible();
    await act(async () => { late.resolve(json({ lines: [{ t: '10:01', level: 'INFO', msg: 'late previous client logs' }] })); });
    expect(screen.queryByText('late previous client logs')).toBeNull();
    expect(screen.queryByText('EN VIVO')).toBeNull();
    await act(async () => { next.resolve(json({ lines: [{ t: '10:02', level: 'INFO', msg: 'current client logs' }] })); });
    await waitFor(() => expect(screen.getByText('current client logs')).toBeVisible());
    expect(screen.getByText('EN VIVO')).toBeVisible();
  });
}


test('normal demo content shows INFO, WARN and ERROR through TODO and the INFO chip', async () => {
  resetDemo(); seed(); polling(serverA);
  const demo = createDemoClient('atlas', () => 1_000_000);
  // Serve the actual demo client at the transport boundary; AppProvider and filters stay real.
  for (const level of ['DEBUG', 'INFO'] as const) {
    respond(serverA.url, `/v1/logs?lines=100&level=${level}`, async () => json({ lines: await demo.logs(level, 100) }));
  }
  const app = renderApp(<AgentLogs serverId="A" />); await app.ready();
  const info = 'gateway: session dev#a81 resumed';
  const warn = 'terminal exit=1 (14.3s)';
  const error = 'homelab: connect ETIMEDOUT 100.71.3.9:8642';
  await waitFor(() => expect(screen.getByText(info)).toBeVisible());
  expect(screen.getByText(warn)).toBeVisible();
  expect(screen.getByText(error)).toBeVisible();
  expect(screen.queryByText('Sin logs para este filtro.')).toBeNull();
  fireEvent.press(screen.getAllByText('INFO')[0]);
  await waitFor(() => expect(requests.filter(r => r.path === '/v1/logs?lines=100&level=INFO')).toHaveLength(1));
  await waitFor(() => expect(screen.getByText(info)).toBeVisible());
  expect(screen.getByText(warn)).toBeVisible();
  expect(screen.getByText(error)).toBeVisible();
});
