import type { VpnReading } from '@/native/vpnContract';
import { deferred, emitAppState, emitAppBlur, emitAppFocus } from '../support/native';
import { Linking } from 'react-native';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { ServerConnectionStatus } from '@/ui/ServerConnectionStatus';
import { seed, serverA, polling, health, serverB } from '../support/fixtures';
import { renderApp } from '../support/renderApp';
import { networkError, respond, requestsFor, json } from '../support/transport';
import { vpn, vpnReading, emitVpn } from '../support/vpn';

test('a verified absence for Relay offers Tailscale and retry without declaring it globally off', async () => {
  seed(); respond(serverA.url, '/health', networkError); respond(serverA.url, '/v1/agents', networkError);
  vpn.observe.mockImplementation(async generation => vpnReading(generation, 'absent'));
  const app = renderApp(<ServerConnectionStatus serverId="A" subject />); await app.ready();
  await screen.findByText('SIN VPN PARA RELAY');
  expect(screen.getByText('Abrir Tailscale')).toBeVisible(); expect(screen.queryByText('VPN APAGADA')).toBeNull();
  jest.mocked(Linking.openURL).mockResolvedValueOnce(undefined);
  await act(async () => { fireEvent.press(screen.getByText('Abrir Tailscale')); });
  expect(Linking.openURL).toHaveBeenCalledWith('tailscale://navigate');
  const before = requestsFor(serverA.url).length; await act(async () => { fireEvent.press(screen.getByText('Reintentar')); });
  await waitFor(() => expect(requestsFor(serverA.url).length).toBeGreaterThan(before));
});

test('VPN transport does not identify Tailscale or classify the Server as down', async () => {
  seed(); respond(serverA.url, '/health', networkError); respond(serverA.url, '/v1/agents', networkError);
  vpn.observe.mockImplementation(async generation => vpnReading(generation, 'available'));
  const app = renderApp(<ServerConnectionStatus serverId="A" subject />); await app.ready();
  await screen.findByText('SERVIDOR SIN RESPUESTA');
  expect(screen.getByText(/VPN activa para Relay, sin identificar al proveedor/)).toBeVisible();
  expect(screen.queryByText('Tailscale activo')).toBeNull(); expect(screen.queryByText('Servidor caído')).toBeNull();
});
for (const [code, label] of [['device_revoked', 'DISPOSITIVO REVOCADO'], ['key_unknown', 'LLAVE RECHAZADA']] as const) {
  test(`${code} takes precedence over an absent VPN`, async () => {
    seed(); respond(serverA.url, '/health', networkError); respond(serverA.url, '/v1/agents', json({ error: { code, message: 'synthetic known failure' } }, 403));
    vpn.observe.mockImplementation(async generation => vpnReading(generation, 'absent'));
    const app = renderApp(<ServerConnectionStatus serverId="A" subject />); await app.ready();
    await screen.findByText(label); expect(screen.queryByText('SIN VPN PARA RELAY')).toBeNull();
  });
}
test('a successful Puente response suppresses VPN speculation even if private data timed out', async () => {
  seed(); respond(serverA.url, '/health', json(health)); respond(serverA.url, '/v1/agents', networkError);
  vpn.observe.mockImplementation(async generation => vpnReading(generation, 'absent'));
  const app = renderApp(<ServerConnectionStatus serverId="A" subject />); await app.ready();
  await screen.findByText('EL PUENTE RESPONDE'); expect(screen.queryByText('SIN VPN PARA RELAY')).toBeNull();
});
test('protocol evidence takes precedence over VPN speculation', async () => {
  seed(); respond(serverA.url, '/health', json({ ...health, protocolVersion: 3, minAppProtocolVersion: 3 })); respond(serverA.url, '/v1/agents', networkError);
  vpn.observe.mockImplementation(async generation => vpnReading(generation, 'absent'));
  const app = renderApp(<ServerConnectionStatus serverId="A" subject />); await app.ready();
  await screen.findByText('Actualiza Relay'); expect(screen.queryByText('SIN VPN PARA RELAY')).toBeNull();
  expect(screen.queryByText('SIN RESPUESTA · REVISA TAILNET')).toBeNull(); expect(screen.queryByText('EL PUENTE RESPONDE')).toBeNull();
});
test('a fully reachable Puente never shows an offline VPN panel', async () => {
  seed(); polling(serverA); vpn.observe.mockImplementation(async generation => vpnReading(generation, 'absent'));
  const app = renderApp(<ServerConnectionStatus serverId="A" subject />); await app.ready();
  await waitFor(() => expect(app.probe.current?.snapshot('A').reachable).toBe(true));
  expect(screen.queryByText('SIN VPN PARA RELAY')).toBeNull(); expect(screen.queryByText('SIN RESPUESTA · REVISA TAILNET')).toBeNull();
});
test('a newer event wins over a delayed snapshot and retired events cannot restore background readings', async () => {
  seed(); respond(serverA.url, '/health', networkError); respond(serverA.url, '/v1/agents', networkError);
  const pending = deferred<VpnReading>(); vpn.observe.mockReturnValueOnce(pending.promise);
  const app = renderApp(<ServerConnectionStatus serverId="A" subject />); await app.ready();
  const generation = vpn.observe.mock.calls.at(-1)![0];
  const oldListener = vpn.addListener.mock.calls.at(-1)![1];
  await act(async () => { emitVpn(vpnReading(generation, 'available', 3)); });
  await screen.findByText('SERVIDOR SIN RESPUESTA');
  await act(async () => { pending.resolve(vpnReading(generation, 'absent', 1)); });
  expect(screen.getByText('SERVIDOR SIN RESPUESTA')).toBeVisible();
  await act(async () => { emitAppState('background'); });
  await screen.findByText('SIN RESPUESTA · REVISA TAILNET');
  await act(async () => { oldListener(vpnReading(generation, 'available', 4)); });
  expect(screen.queryByText('SERVIDOR SIN RESPUESTA')).toBeNull();
  const resumed = deferred<VpnReading>(); vpn.observe.mockReturnValueOnce(resumed.promise);
  await act(async () => { emitAppState('active'); });
  expect(screen.getByText('SIN RESPUESTA · REVISA TAILNET')).toBeVisible();
  const current = vpn.observe.mock.calls.at(-1)![0]; expect(current).not.toBe(generation);
  await act(async () => { resumed.resolve(vpnReading(current, 'absent')); });
  await screen.findByText('SIN VPN PARA RELAY');
});
test('changing Server scope retires a pending native snapshot before it can change the new Server label', async () => {
  seed([serverA, serverB]);
  for (const server of [serverA, serverB]) { respond(server.url, '/health', networkError); respond(server.url, '/v1/agents', networkError); }
  const old = deferred<VpnReading>(); vpn.observe.mockReturnValueOnce(old.promise);
  const app = renderApp(<ServerConnectionStatus serverId="B" subject />); await app.ready(); const previous = vpn.observe.mock.calls.at(-1)![0];
  const fresh = deferred<VpnReading>(); vpn.observe.mockReturnValueOnce(fresh.promise);
  await act(async () => { app.probe.current!.selectServer('B'); });
  const generation = vpn.observe.mock.calls.at(-1)![0]; expect(generation).not.toBe(previous);
  await act(async () => { old.resolve(vpnReading(previous, 'absent')); });
  expect(screen.queryByText('SIN VPN PARA RELAY')).toBeNull();
  await act(async () => { fresh.resolve(vpnReading(generation, 'available')); });
  await screen.findByText('SERVIDOR SIN RESPUESTA');
});
test('blur retires metadata and a new focus obtains a fresh generation', async () => {
  seed(); respond(serverA.url, '/health', networkError); respond(serverA.url, '/v1/agents', networkError);
  vpn.observe.mockImplementation(async generation => vpnReading(generation, 'available'));
  const app = renderApp(<ServerConnectionStatus serverId="A" subject />); await app.ready(); await screen.findByText('SERVIDOR SIN RESPUESTA');
  const previous = vpn.observe.mock.calls.at(-1)![0];
  await act(async () => { emitAppBlur(); }); await screen.findByText('SIN RESPUESTA · REVISA TAILNET');
  await act(async () => { emitAppFocus(); }); await screen.findByText('SERVIDOR SIN RESPUESTA');
  expect(vpn.observe.mock.calls.at(-1)![0]).not.toBe(previous);
});

test('Android cleartext policy takes precedence over VPN status at the real transport boundary', async () => {
  seed(); const blocked = () => Promise.reject(new Error('CLEARTEXT communication to example not permitted by network security policy'));
  respond(serverA.url, '/health', blocked); respond(serverA.url, '/v1/agents', blocked);
  vpn.observe.mockImplementation(async generation => vpnReading(generation, 'absent'));
  const app = renderApp(<ServerConnectionStatus serverId="A" subject />); await app.ready();
  await screen.findByText('HTTP BLOQUEADO POR ANDROID'); expect(screen.queryByText('SIN VPN PARA RELAY')).toBeNull();
});

test('a replaced paired client and the new subscriber reject prior-generation metadata', async () => {
  seed(); respond(serverA.url, '/health', networkError); respond(serverA.url, '/v1/agents', networkError);
  const old = deferred<VpnReading>(); vpn.observe.mockReturnValueOnce(old.promise);
  const app = renderApp(<ServerConnectionStatus serverId="A" subject />); await app.ready(); const previous = vpn.observe.mock.calls.at(-1)![0];
  const fresh = deferred<VpnReading>(); vpn.observe.mockReturnValueOnce(fresh.promise);
  await act(async () => { await app.probe.current!.replaceServer('A', { name: serverA.name, url: serverA.url, key: 'synthetic-new-key', deviceId: 'synthetic-new-device' }); });
  const current = vpn.observe.mock.calls.at(-1)![0]; expect(current).not.toBe(previous);
  await act(async () => { emitVpn(vpnReading(previous, 'absent', 50)); });
  expect(screen.queryByText('SIN VPN PARA RELAY')).toBeNull();
  await act(async () => { fresh.resolve(vpnReading(current, 'available', 2)); });
  await screen.findByText('SERVIDOR SIN RESPUESTA');
  await act(async () => { old.resolve(vpnReading(previous, 'absent', 60)); });
  expect(screen.getByText('SERVIDOR SIN RESPUESTA')).toBeVisible();
});
test('failed native observation stays unknown and does not invent an absent VPN', async () => {
  seed(); respond(serverA.url, '/health', networkError); respond(serverA.url, '/v1/agents', networkError);
  vpn.observe.mockRejectedValue(new Error('Synthetic unavailable native permission'));
  const app = renderApp(<ServerConnectionStatus serverId="A" subject />); await app.ready();
  await screen.findByText(/No se pudo comprobar la VPN de Relay/);
  expect(screen.queryByText('SIN VPN PARA RELAY')).toBeNull();
  const current = vpn.observe.mock.calls.at(-1)![0];
  await act(async () => { emitVpn({ ...vpnReading(current, 'available'), scope: 'global-vpn' } as unknown as VpnReading); });
  expect(screen.queryByText('SERVIDOR SIN RESPUESTA')).toBeNull();
});
test('a native subscription exception fails closed without breaking AppProvider or leaking listeners', async () => {
  seed(); respond(serverA.url, '/health', networkError); respond(serverA.url, '/v1/agents', networkError);
  vpn.addListener.mockImplementationOnce(() => { throw new Error('Synthetic missing native emitter'); });
  const app = renderApp(<ServerConnectionStatus serverId="A" subject />); await app.ready();
  await screen.findByText(/No se pudo comprobar la VPN de Relay/); expect(screen.queryByText('SIN VPN PARA RELAY')).toBeNull();
});

test('an invalid saved address preserves its actionable diagnosis over VPN status', async () => {
  seed([{ ...serverA, url: 'invalid-synthetic-origin' }]);
  vpn.observe.mockImplementation(async generation => vpnReading(generation, 'absent'));
  const app = renderApp(<ServerConnectionStatus serverId="A" subject />); await app.ready();
  await screen.findByText('SOLICITUD RECHAZADA'); expect(screen.queryByText('SIN VPN PARA RELAY')).toBeNull();
});
