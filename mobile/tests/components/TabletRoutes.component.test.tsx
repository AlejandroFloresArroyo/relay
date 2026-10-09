import { StyleSheet } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import NotificationSettingsRoute from '@/app/notifications/[server]';
import AppUpdateRoute from '@/app/app-update/[server]';
import { NotificationProvider } from '@/state/notifications';
import { LockGate } from '@/screens/LockGate';
import { RelayShell } from '@/ui/RelayShell';
import { polling, seed, serverA, serverB, serverInfo, settings } from '../support/fixtures';
import { biometrics, clockStart, deferred, navigation, resizeWindow, router, stackOf, tabsRoute } from '../support/native';
import { animatedStyle } from '../support/motion';
import { notificationNative } from '../support/notifications';
import { apkNative, fixtureManifest, resetApkNative } from '../support/appUpdate';
import { renderApp } from '../support/renderApp';
import { json, requests, requestsFor, respond } from '../support/transport';

jest.mock('expo', () => ({ ...jest.requireActual('expo'), requireOptionalNativeModule: (name: string) => name === 'RelayApkUpdate' ? jest.requireActual('../support/appUpdate').apkNative : null }));
beforeEach(() => resetApkNative());

const notificationStatus = { schema: 1, configured: true, transport: 'ntfy-unifiedpush', availableKinds: ['approval'], preferences: { enabled: false, types: { approval: true, task: true, error: true, server: true }, preview: 'generic' }, revision: 0, registration: null, delivery: 'disabled', serverNow: clockStart };
const routes = [
  { path: 'notifications', endpoint: '/v1/notifications', title: 'Avisos', ready: 'Configurado', active: 'Ajustes', back: '‹ Ajustes',
    state: stackOf(tabsRoute('settings'), { name: 'notifications/[server]', params: { server: 'B' } }) },
  { path: 'app-update', endpoint: '/v1/app-update', title: 'Actualización APK', ready: 'Revisar versiones', active: 'Servidores', back: '‹ Servidor B',
    state: stackOf(tabsRoute('servers'), { name: 'server/[server]', params: { server: 'B' } }, { name: 'app-update/[server]', params: { server: 'B' } }) },
] as const;
type Route = typeof routes[number];

function setup(route: Route, width: number, locked = false) {
  seed([serverA, serverB], { ...settings, faceid: locked });
  polling(serverA); polling(serverB);
  for (const server of [serverA, serverB]) respond(server.url, '/v1/server', json(serverInfo));
  respond(serverA.url, '/v1/discovery', json({ bridges: [], truncated: false }));
  respond(serverB.url, '/v1/notifications', json(notificationStatus));
  respond(serverB.url, '/v1/app-update', { ...json(fixtureManifest), headers: new Headers({ ETag: '"' + fixtureManifest.revision + '"' }) });
  navigation.pathname = `/${route.path}/B`;
  navigation.params = { server: 'B' };
  navigation.state = route.state;
  resizeWindow(width, 844);
  return renderApp(<SafeAreaInsetsContext.Provider value={{ top: 24, bottom: 48, left: 10, right: 10 }}>
    <NotificationProvider><LockGate><RelayShell>
      {route.path === 'notifications' ? <NotificationSettingsRoute /> : <AppUpdateRoute />}
    </RelayShell></LockGate></NotificationProvider>
  </SafeAreaInsetsContext.Provider>);
}

for (const route of routes) {
  test.each([390, 800, 1200])(`${route.path} keeps its Server, phone actions and owning navigation at width %d`, async width => {
    const app = setup(route, width); await app.ready();
    await screen.findByText(route.ready);
    const main = screen.getByLabelText('Contenido principal');
    expect(within(main).getByText(route.title)).toBeVisible();
    expect(within(main).getByText(route.path === 'notifications' ? 'SERVIDOR B · ESTE TELÉFONO' : route.back)).toBeVisible();
    expect(app.probe.current!.selectedServer).toBe('A');
    expect(requestsFor(serverA.url, route.endpoint)).toHaveLength(0);
    expect(requestsFor(serverB.url, route.endpoint)).toHaveLength(1);
    expect(requests.filter(request => request.method !== 'GET')).toEqual([]);
    expect(apkNative.install).not.toHaveBeenCalled();
    expect(apkNative.open).not.toHaveBeenCalled();
    expect(notificationNative.begin).not.toHaveBeenCalled();
    expect(notificationNative.requestPermission).not.toHaveBeenCalled();

    let shell = main.parent;
    while (shell && StyleSheet.flatten(shell.props.style)?.paddingBottom === undefined) shell = shell.parent;
    expect(shell).toHaveStyle({ paddingBottom: width === 390 ? 0 : 64 });
    if (width === 390) {
      expect(screen.queryAllByRole('tab')).toHaveLength(0);
      expect(screen.queryByLabelText('Navegación principal')).toBeNull();
      expect(screen.queryByLabelText('Lista de Servidores')).toBeNull();
    } else {
      // Usage, presets and the APK update sit beside the Servidores list; Avisos keeps the reading width.
      const split = route.path === 'app-update';
      expect(StyleSheet.flatten(main.props.style).maxWidth).toBe(split ? undefined : 820);
      expect(screen.queryAllByRole('tab')).toHaveLength(8);
      expect(screen.getByRole('tab', { name: route.active })).toBeSelected();
      expect(animatedStyle(screen.getByLabelText('Navegación principal')).width).toBe(72);
      if (split) expect(animatedStyle(screen.getByLabelText('Lista de Servidores')).width).toBe(width === 800 ? 282 : 320);
      else expect(screen.queryByLabelText('Lista de Servidores')).toBeNull();
      if (split) {
        const list = within(screen.getByLabelText('Lista de Servidores'));
        expect(list.getByText('Servidor A')).toBeVisible();
        expect(list.getByText('Servidor B')).toBeVisible();
      }
      for (const [name, destination] of [['Agentes', '/agents'], ['Herramientas', '/tools'], ['Tablero', '/board'], ['Trabajo', '/work'], ['Tareas', '/jobs'], ['Aprobaciones', '/approvals'], ['Servidores', '/servers'], ['Ajustes', '/settings']]) {
        fireEvent.press(screen.getByRole('tab', { name }));
        expect(router.dismissTo).toHaveBeenLastCalledWith(destination);
      }
      expect(router.navigate).not.toHaveBeenCalled();
      await act(async () => resizeWindow(width === 800 ? 1200 : 800, 800));
      expect(screen.getByRole('tab', { name: route.active })).toBeSelected();
      expect(within(screen.getByLabelText('Contenido principal')).getByText(route.ready)).toBeVisible();
      expect(requestsFor(serverB.url, route.endpoint)).toHaveLength(1);
      expect(app.probe.current!.selectedServer).toBe('A');
    }
    fireEvent.press(screen.getByText(route.back));
    expect(router.back).toHaveBeenCalledTimes(1);
    if (route.path === 'notifications') {
      fireEvent.press(screen.getByText('Permitir avisos en Android'));
      await waitFor(() => expect(notificationNative.requestPermission).toHaveBeenCalledTimes(1));
    } else {
      fireEvent.press(screen.getByText('Revisar versiones'));
      expect(screen.getByText('Descargar APK')).toBeEnabled();
      expect(requestsFor(serverB.url, '/v1/app-update/apk')).toHaveLength(0);
    }
    expect(requests.filter(request => request.method !== 'GET')).toEqual([]);
  });

  test(`${route.path} and both Shell panes stay behind the real LockGate across unlock and inactivity`, async () => {
    const unlock = deferred<{ success: boolean }>();
    biometrics.authenticateAsync.mockReturnValueOnce(unlock.promise);
    const app = setup(route, 1200, true); await app.ready();
    await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Relay está bloqueado')).toBeVisible();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByText(route.title)).toBeNull();
    expect(requestsFor(serverB.url, route.endpoint)).toHaveLength(0);
    await act(async () => unlock.resolve({ success: true }));
    await screen.findByText(route.ready);
    expect(screen.getByRole('tab', { name: route.active })).toBeSelected();
    await act(async () => jest.advanceTimersByTimeAsync(60001));
    expect(screen.getByText('Relay está bloqueado')).toBeVisible();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByText(route.title)).toBeNull();
    expect(screen.queryByText('Servidor A')).toBeNull();
    expect(screen.queryByText('Servidor B')).toBeNull();
    const nextUnlock = deferred<{ success: boolean }>();
    biometrics.authenticateAsync.mockReturnValueOnce(nextUnlock.promise);
    fireEvent.press(screen.getByText('Usar el código del teléfono'));
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    await act(async () => nextUnlock.resolve({ success: true }));
    await screen.findByText(route.ready);
    expect(screen.getByRole('tab', { name: route.active })).toBeSelected();
    expect(app.probe.current!.selectedServer).toBe('A');
    expect(requestsFor(serverA.url, route.endpoint)).toHaveLength(0);
    expect(requests.filter(request => request.method !== 'GET')).toEqual([]);
    expect(apkNative.install).not.toHaveBeenCalled();
    expect(notificationNative.requestPermission).not.toHaveBeenCalled();
  });
}
