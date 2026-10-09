import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { LockGate } from '@/screens/LockGate';
import { WidgetDemoScreen } from '@/screens/WidgetDemoScreen';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { DARK_PALETTE } from '@/theme/tokens';
import { SettingsScreen } from '@/screens/SettingsScreen';
import { WidgetBridge, WidgetTarget } from '@/state/WidgetBridge';
import { widgetScope } from '@/core/widget';
import { renderApp } from '../support/renderApp';
import { agentA, approval, polling, seed, serverA, serverB, serverInfo, settings } from '../support/fixtures';
import { biometrics, deferred, emitAppBlur, emitAppState, router } from '../support/native';
import { json, requests, respond } from '../support/transport';
import { openWidget, widgetFollows, widgetNative } from '../support/widget';
function setup() {
  seed([serverA, serverB], settings); polling(serverA, [{ ...agentA, lastMessage: { text: 'PRIVATE TRANSCRIPT', at: Date.now() } }]); polling(serverB, [{ ...agentA, name: 'Other scope' }]);
  respond(serverA.url, '/v1/approvals', json({ approvals: [{ ...approval().approval, command: 'PRIVATE COMMAND' }] }));
}
const scopeA = widgetScope(serverA.id, serverA.deviceId, serverA.url);
const scopeB = widgetScope(serverB.id, serverB.deviceId, serverB.url);

test('the widget follows the selected Servidor before unlock with names only, and idle lock, blur and background keep it', async () => {
  setup(); const unlock = deferred<{ success: boolean }>(); biometrics.authenticateAsync.mockReturnValueOnce(unlock.promise);
  renderApp(<><WidgetTarget /><LockGate><WidgetBridge /><Text>Relay content</Text></LockGate></>);
  await waitFor(() => expect(widgetFollows()).toMatchObject({ serverId: serverA.id, deviceId: serverA.deviceId, url: serverA.url, scope: scopeA, label: 'Servidor A' }));
  expect(JSON.stringify(widgetFollows())).not.toMatch(/fixture-key|PRIVATE|Other scope/);
  await act(async () => { unlock.resolve({ success: true }); });
  await act(async () => { await jest.advanceTimersByTimeAsync(60000); });
  expect(screen.getByText('Relay está bloqueado')).toBeVisible();
  await act(async () => { emitAppBlur(); emitAppState('background'); });
  expect(widgetFollows()).toMatchObject({ serverId: serverA.id, scope: scopeA });
  expect(widgetNative.target).not.toHaveBeenCalledWith(null);
  expect(requests.filter(value => value.method === 'POST')).toHaveLength(0);
});

test('revocation retires the widget at once while Relay is locked; removal and re-pairing replace the Servidor it follows', async () => {
  setup(); biometrics.authenticateAsync.mockReturnValueOnce(deferred<{ success: boolean }>().promise);
  const app = renderApp(<><WidgetTarget /><LockGate><WidgetBridge /></LockGate></>);
  await waitFor(() => expect(widgetFollows()?.scope).toBe(scopeA));
  respond(serverA.url, '/v1/agents', json({ error: { code: 'device_revoked', message: 'SYNTHETIC PRIVATE ERROR' } }, 403));
  await act(async () => { app.probe.current!.refresh(); });
  await waitFor(() => expect(widgetFollows()).toBeNull());
  await act(async () => { await app.probe.current!.removeServer('A'); });
  await waitFor(() => expect(widgetFollows()?.scope).toBe(scopeB));
  await act(async () => { await app.probe.current!.replaceServer('B', { ...serverB, key: 'SYNTHETIC-REPLACEMENT', deviceId: 'replacement-device' }); });
  await waitFor(() => expect(widgetFollows()).toMatchObject({ serverId: serverB.id, deviceId: 'replacement-device', scope: widgetScope(serverB.id, 'replacement-device', serverB.url) }));
  expect(JSON.stringify(widgetNative.target.mock.calls)).not.toMatch(/SYNTHETIC-REPLACEMENT|fixture-key/);
});

test('widget taps wait for the real gate and only open a read surface; forged payloads and retired scope never navigate or send a command', async () => {
  setup(); const unlock = deferred<{ success: boolean }>(); biometrics.authenticateAsync.mockReturnValueOnce(unlock.promise);
  const app = renderApp(<><WidgetTarget /><LockGate><WidgetBridge /></LockGate></>);
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
  await act(async () => { openWidget({ scope: scopeA, target: 'approvals' }); });
  expect(router.dismissTo).not.toHaveBeenCalled();
  await act(async () => { unlock.resolve({ success: true }); });
  await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith('/approvals'));
  router.dismissTo.mockClear();
  for (const payload of [{ scope: scopeA, target: 'approvals', choice: 'once' }, { scope: scopeB, target: 'agents' }]) {
    await act(async () => { openWidget(payload); }); expect(router.dismissTo).not.toHaveBeenCalled();
  }
  await act(async () => { app.probe.current!.selectServer('B'); });
  await waitFor(() => expect(widgetFollows()?.scope).toBe(scopeB));
  await act(async () => { openWidget({ scope: scopeA, target: 'approvals' }); });
  expect(router.dismissTo).not.toHaveBeenCalled();
  await act(async () => { emitAppBlur(); });
  await act(async () => { openWidget({ scope: scopeB, target: 'approvals' }); }); expect(router.dismissTo).not.toHaveBeenCalled();
  await act(async () => { emitAppState('background'); });
  expect(requests.filter(value => value.method === 'POST')).toHaveLength(0);
});

test('a revoked scope cannot open from a widget tap', async () => {
  setup(); biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  const app = renderApp(<LockGate><WidgetBridge /></LockGate>);
  await waitFor(() => expect(screen.queryByText('Relay está bloqueado')).toBeNull());
  respond(serverA.url, '/v1/agents', json({ error: { code: 'device_revoked', message: 'SYNTHETIC PRIVATE ERROR' } }, 403));
  await act(async () => { app.probe.current!.refresh(); });
  await act(async () => { await jest.advanceTimersByTimeAsync(1); });
  await act(async () => { openWidget({ scope: scopeA, target: 'approvals' }); });
  expect(router.dismissTo).not.toHaveBeenCalled();
});

test('a cold tap waits for the initial scoped poll', async () => {
  seed([serverA], settings); polling(serverA, [agentA]);
  const initial = deferred<Response>(); respond(serverA.url, '/v1/agents', initial.promise);
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  renderApp(<LockGate><WidgetBridge /></LockGate>);
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
  await act(async () => { openWidget({ scope: scopeA, target: 'approvals' }); });
  expect(router.dismissTo).not.toHaveBeenCalled();
  await act(async () => { initial.resolve(json({ agents: [agentA] })); });
  await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith('/approvals'));
  expect(requests.filter(value => value.method === 'POST')).toHaveLength(0);
});

test('both real primitive previews show the live, stale and neutral states without a stale count, including reactive theme', async () => {
  seed([], { ...settings, faceid: false });
  renderApp(<ThemeProvider><WidgetDemoScreen /><SettingsScreen /></ThemeProvider>);
  await waitFor(() => expect(screen.getByLabelText('Widget amplio')).toBeVisible());
  expect(screen.getByLabelText('Widget compacto')).toBeVisible();
  expect(screen.getAllByText('1')).toHaveLength(2);
  expect(screen.getAllByText(/^LECTURA /)).toHaveLength(2);
  fireEvent.press(screen.getByRole('radio', { name: 'Oscuro' }));
  expect(screen.getByLabelText('Widget amplio')).toHaveStyle({ backgroundColor: DARK_PALETTE.K.background });
  fireEvent.press(screen.getByText('Sin lectura reciente'));
  expect(screen.queryAllByText('1')).toHaveLength(0);
  expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  expect(screen.getAllByText('SIN LECTURA RECIENTE')).toHaveLength(2);
  expect(screen.getAllByText(/^ÚLTIMO DATO /)).toHaveLength(2);
  expect(screen.queryAllByText(/^LECTURA /)).toHaveLength(0);
  expect(screen.queryAllByText('TRABAJANDO')).toHaveLength(0);
  fireEvent.press(screen.getByText('Sin lectura'));
  expect(screen.queryAllByText(/ÚLTIMO DATO|^LECTURA /)).toHaveLength(0);
  expect(screen.queryAllByText('dev')).toHaveLength(0);
  expect(screen.getAllByText('SIN DATOS VISIBLES')).toHaveLength(2);
});

test('the widget follows one Servidor: atlas shows dev and research, ops only on homelab, and says so', async () => {
  seed([], { ...settings, faceid: false });
  renderApp(<ThemeProvider><WidgetDemoScreen /></ThemeProvider>);
  await waitFor(() => expect(screen.getByLabelText('Widget amplio')).toBeVisible());
  expect(screen.getAllByText('dev')).toHaveLength(2); expect(screen.getAllByText('research')).toHaveLength(2); expect(screen.queryAllByText('ops')).toHaveLength(0);
  expect(screen.getByText('ATLAS · TRABAJANDO')).toBeVisible();
  expect(screen.getByText(/muestra hasta tres de sus Agentes; los de otros Servidores no salen/)).toBeVisible();
  fireEvent.press(screen.getByText('homelab'));
  expect(screen.getAllByText('ops')).toHaveLength(2); expect(screen.queryAllByText('dev')).toHaveLength(0);
  expect(screen.getByText('HOMELAB · ERROR')).toBeVisible();
  expect(screen.getByText('Revisar')).toBeVisible();
});

test('changing the real theme updates the native appearance without resetting scope or authentication', async () => {
  setup();
  respond(serverA.url, '/v1/server', json(serverInfo));
  respond(serverB.url, '/v1/server', json(serverInfo)); biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  renderApp(<ThemeProvider><WidgetTarget /><LockGate><WidgetBridge /><SettingsScreen /></LockGate></ThemeProvider>);
  await waitFor(() => expect(widgetFollows()).toMatchObject({ appearance: 'light', scope: scopeA }));
  await waitFor(() => expect(screen.getByRole('radio', { name: 'Oscuro' })).toBeVisible());
  fireEvent.press(screen.getByRole('radio', { name: 'Oscuro' }));
  expect(widgetFollows()).toMatchObject({ appearance: 'dark', scope: scopeA });
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1);
  expect(requests.filter(value => value.method === 'POST')).toHaveLength(0);
});
