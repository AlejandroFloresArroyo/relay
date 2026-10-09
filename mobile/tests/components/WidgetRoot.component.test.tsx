import { act, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootLayout from '@/app/_layout';
import { widgetScope } from '@/core/widget';
import { agentA, polling, seed, serverA, settings } from '../support/fixtures';
import { biometrics, deferred, emitAppState, navigation, router } from '../support/native';
import { openWidget, widgetFollows } from '../support/widget';
import { requests } from '../support/transport';

jest.mock('expo-font', () => require('../support/native').fonts);
jest.mock('expo-splash-screen', () => require('../support/native').splash);
jest.mock('expo-status-bar', () => ({ StatusBar: require('../support/native').StatusBar }));
test('the actual root hands the widget its Servidor outside LockGate and keeps cold-open requests under it, without an action or consent', async () => {
  seed([serverA], settings); polling(serverA, [agentA]); navigation.pathname = '/agents';
  const unlock = deferred<{ success: boolean }>(); biometrics.authenticateAsync.mockReturnValueOnce(unlock.promise);
  render(<SafeAreaProvider><RootLayout /></SafeAreaProvider>);
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(widgetFollows()).toMatchObject({ serverId: serverA.id, scope: widgetScope(serverA.id, serverA.deviceId, serverA.url) }));
  await act(async () => { openWidget({ target: 'approvals', scope: widgetScope(serverA.id, serverA.deviceId, serverA.url) }); });
  expect(router.dismissTo).not.toHaveBeenCalled();
  await act(async () => { unlock.resolve({ success: true }); });
  await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith('/approvals'));
  await act(async () => { emitAppState('background'); });
  expect(widgetFollows()).toMatchObject({ serverId: serverA.id });
  expect(requests.filter(value => value.method === 'POST')).toHaveLength(0);
});
