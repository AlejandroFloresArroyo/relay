import { act, fireEvent, screen } from '@testing-library/react-native';
import { SettingsScreen } from '@/screens/SettingsScreen';
import { polling, seed, serverA, serverB, serverInfo, settings } from '../support/fixtures';
import { secureStore, storageFailures, stored } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, respond } from '../support/transport';

function setupServers() {
  for (const server of [serverA, serverB]) {
    polling(server); respond(server.url, '/v1/server', json(serverInfo));
  }
}
test.each(['{', JSON.stringify({ faceid: 'yes', faceApprove: 1, autoLockMs: 60 }), 'null', '[]'])('corrupt/invalid settings %s preserve paired servers and normalize all fields', async (raw) => {
  seed([serverA, serverB]); setupServers();
  stored.set('relay.settings.v1', raw);
  const app = renderApp(<SettingsScreen />); await app.ready();
  for (const label of screen.getAllByText('Servidor A')) expect(label).toBeVisible();
  expect(screen.queryByText('Servidor B')).toBeNull(); // Ajustes no longer lists the Servidores
  expect(app.probe.current!.servers).toEqual([serverA, serverB]);
  expect(app.probe.current!.settings).toEqual({ faceid: true, faceApprove: true, autoLockMs: 60000 });
  for (const [key, rawServers] of secureStore.setItemAsync.mock.calls) {
    if (key === 'relay.servers.v1') expect(JSON.parse(rawServers)).toEqual([serverA, serverB]);
  }
});

test.each(['{', '{"invalid":true}'])('corrupt servers %s do not discard valid nondefault settings', async (raw) => {
  seed([], { faceid: false, faceApprove: false, autoLockMs: 900000 });
  stored.set('relay.servers.v1', raw);
  const app = renderApp(<SettingsScreen />); await app.ready();
  expect(app.probe.current!.servers).toEqual([]);
  expect(app.probe.current!.settings).toEqual({ faceid: false, faceApprove: false, autoLockMs: 900000 });
  expect(screen.getByRole('switch', { name: /Desbloquear con huella/ })).not.toBeChecked();
  expect(screen.getByText('15 MIN')).toBeVisible();
});

test.each([false, true])('legacy migration preserves metadata, removes the old key and keeps settings if saving fails=%s', async (fails) => {
  seed([], { ...settings, faceid: false, autoLockMs: 300000 });
  const legacy = { id: 'A', name: 'Servidor A', url: serverA.url, key: 'fixture-legacy-key', isDefault: true };
  stored.set('relay.servers.v1', JSON.stringify([legacy]));
  respond(serverA.url, '/health', json({ ok: true, service: 'relayd', version: 'fixture', protocolVersion: 1, minAppProtocolVersion: 1 }));
  if (fails) storageFailures.write.add('relay.servers.v1');
  const app = renderApp(<SettingsScreen />); await app.ready();
  const migrated = { ...legacy, key: '' };
  for (const label of screen.getAllByText('Servidor A')) expect(label).toBeVisible();
  expect(app.probe.current!.servers).toEqual([migrated]);
  expect(app.probe.current!.settings).toEqual({ faceid: false, faceApprove: true, autoLockMs: 300000 });
  const writes = secureStore.setItemAsync.mock.calls.filter(([key]) => key === 'relay.servers.v1');
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0][1])).toEqual([migrated]);
  expect(JSON.parse(stored.get('relay.servers.v1')!)).toEqual([fails ? legacy : migrated]);
  expect(app.probe.current!.serverStorageError !== null).toBe(fails);
});

test('a real setting press persists only normalized settings and never overwrites paired servers', async () => {
  seed([serverA, serverB]); setupServers();
  const app = renderApp(<SettingsScreen />); await app.ready();
  const serverStorage = stored.get('relay.servers.v1');
  secureStore.setItemAsync.mockClear();
  await act(async () => { fireEvent.press(screen.getByRole('switch', { name: /Desbloquear con huella/ })); });
  expect(app.probe.current!.settings).toEqual({ faceid: false, faceApprove: true, autoLockMs: 60000 });
  expect(JSON.parse(stored.get('relay.settings.v1')!)).toEqual({ faceid: false, faceApprove: true, autoLockMs: 60000 });
  expect(secureStore.setItemAsync.mock.calls).toEqual([['relay.settings.v1', '{"faceid":false,"faceApprove":true,"autoLockMs":60000}']]);
  expect(stored.get('relay.servers.v1')).toBe(serverStorage);
});
