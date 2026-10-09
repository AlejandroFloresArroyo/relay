import { execFileSync } from 'node:child_process';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Platform, Text } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import { DEMO } from '@/state/app';
import { LockGate } from '@/screens/LockGate';
import { biometrics, resetNative, router, secureStore, stored } from '../support/native';
import { polling, seed, serverA } from '../support/fixtures';
import { renderApp } from '../support/renderApp';
import { controlledFetch, json, resetTransport, respond, unexpectedRequests } from '../support/transport';

test('Android mounts the real gate, runs its effect and presses its biometric handler without unexpected network', async () => {
  expect(Platform.OS).toBe('android');
  expect(DEMO).toBe(false);
  expect(expoFetch).toBe(controlledFetch);
  expect(globalThis.fetch).toBe(controlledFetch);
  seed(); polling(serverA);
  const app = renderApp(<LockGate><Text>Contenido protegido</Text></LockGate>);
  await app.ready();
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
  expect(screen.getByText('Relay está bloqueado')).toBeVisible();
  expect(screen.queryByText('Contenido protegido')).toBeNull();
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  await act(async () => { fireEvent.press(screen.getByText('Usar el código del teléfono')); });
  await waitFor(() => expect(screen.getByText('Contenido protegido')).toBeVisible());
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(2);
  expect(unexpectedRequests).toEqual([]);
});

test('the Babel adapter compiles app components only, with sync/async transforms and distinct cache keys', () => {
  // Probe in Node so Jest does not transform the Babel/compiler implementation itself.
  execFileSync(process.execPath, ['tests/support/check-transformer.cjs'], { cwd: process.cwd(), stdio: 'pipe' });
});


test('fixture reset restores default implementations as well as clearing their state', async () => {
  secureStore.getItemAsync.mockResolvedValueOnce('overridden');
  secureStore.setItemAsync.mockImplementationOnce(async () => {});
  secureStore.deleteItemAsync.mockImplementationOnce(async () => {});
  router.push.mockImplementationOnce(() => { throw new Error('Overridden router'); });
  controlledFetch.mockResolvedValueOnce(json({ overridden: true }));
  resetNative(); resetTransport();
  stored.set('fixture-read', 'value'); stored.set('fixture-delete', 'value');
  expect(await secureStore.getItemAsync('fixture-read')).toBe('value');
  await secureStore.setItemAsync('fixture-write', 'written');
  await secureStore.deleteItemAsync('fixture-delete');
  expect(stored.get('fixture-write')).toBe('written');
  expect(stored.has('fixture-delete')).toBe(false);
  expect(() => router.push('/')).not.toThrow();
  respond(serverA.url, '/health', json({ fixture: true }));
  expect(await (await controlledFetch(`${serverA.url}/health`)).json()).toEqual({ fixture: true });
});
