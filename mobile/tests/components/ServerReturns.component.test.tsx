import type { ReactElement } from 'react';
import { BackHandler } from 'react-native';
import { act, cleanupAsync, fireEvent, screen } from '@testing-library/react-native';
import { ConnectScreen } from '@/screens/ConnectScreen';
import { AppUpdateScreen } from '@/screens/AppUpdateScreen';
import { JobDetailScreen } from '@/screens/JobsScreen';
import { NotificationNoticeScreen } from '@/screens/NotificationNoticeScreen';
import { NotificationSettingsScreen } from '@/screens/NotificationSettingsScreen';
import { PersonalityPresetsScreen } from '@/screens/PersonalityPresetsScreen';
import { ServerListScreen } from '@/screens/ServerListScreen';
import { ServerScreen } from '@/screens/ServerScreen';
import { UsageScreen } from '@/screens/UsageScreen';
import { WorkLink } from '@/screens/WorkLink';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { ShellNavigationContext } from '@/ui/layoutContext';
import { NotificationProvider } from '@/state/notifications';
import { renderApp } from '../support/renderApp';
import { polling, seed, serverA, serverB } from '../support/fixtures';
import { navigation, pressBack, router, stackOf, tabsRoute } from '../support/native';
import { networkError, respond } from '../support/transport';
jest.mock('expo', () => ({ ...jest.requireActual('expo'), requireOptionalNativeModule: (name: string) => name === 'RelayApkUpdate' ? require('../support/appUpdate').apkNative : null }));

const ficha = { name: 'server/[server]', params: { server: 'A' } };
// The screens' own reads fail: these tests are about their returns only.
const offline = (server: typeof serverA, ...paths: string[]) => { for (const path of paths) respond(server.url, path, networkError); };

/** The visible return and Android's back key make the same router call, and the app never exits. */
async function expectReturn(ui: ReactElement, label: string, call: () => void) {
  const view = renderApp(ui); await view.ready();
  const link = await view.findByText(`‹ ${label}`);
  expect(view.queryByText(/^Volver$/)).toBeNull(); expect(view.queryByLabelText('Volver')).toBeNull();
  fireEvent.press(link);
  call();
  for (const mock of Object.values(router)) mock.mockClear();
  act(() => pressBack());
  call();
  expect(BackHandler.exitApp).not.toHaveBeenCalled();
  return view;
}

test.each([
  ['usage/[server]', <UsageScreen serverId="A" />, ['/v1/usage?period=day', '/v1/usage?period=week', '/v1/usage?period=month']],
  ['presets/[server]', <ChatVisibilityProvider value><PersonalityPresetsScreen serverId="A" /></ChatVisibilityProvider>, ['/v1/personality-presets']],
  ['app-update/[server]', <ChatVisibilityProvider value><AppUpdateScreen serverId="A" /></ChatVisibilityProvider>, ['/v1/app-update']],
])('%s opened from the ficha returns «‹ <server>» to it', async (name, ui, paths) => {
  seed(); polling(serverA); offline(serverA, ...paths);
  navigation.state = stackOf(tabsRoute('servers'), ficha, { name, params: { server: 'A' } });
  await expectReturn(ui, serverA.name, () => { expect(router.back).toHaveBeenCalledTimes(1); expect(router.dismissTo).not.toHaveBeenCalled(); });
  await cleanupAsync();
});

test('Avisos opened from Ajustes returns «‹ Ajustes»', async () => {
  seed(); polling(serverA);
  navigation.state = stackOf(tabsRoute('settings'), { name: 'notifications/[server]', params: { server: 'A' } });
  const view = await expectReturn(<NotificationProvider><NotificationSettingsScreen serverId="A" /></NotificationProvider>, 'Ajustes', () => expect(router.back).toHaveBeenCalledTimes(1));
  expect(view.getByLabelText('Volver a Ajustes')).toHaveStyle({ alignSelf: 'flex-start' });
  await cleanupAsync();
});

test('the ficha with nothing under it returns «‹ Servidores» to the tab', async () => {
  seed(); polling(serverA); offline(serverA, '/v1/logs?lines=100&level=DEBUG', '/v1/server', '/v1/gateway', '/v1/usage?period=week', '/v1/jobs');
  navigation.state = stackOf(ficha);
  await expectReturn(<ServerScreen serverId="A" />, 'Servidores', () => { expect(router.dismissTo).toHaveBeenCalledWith('/servers'); expect(router.back).not.toHaveBeenCalled(); });
  await cleanupAsync();
});

test('on tablet the ficha draws the same «‹ Servidores» its back key runs', async () => {
  seed(); polling(serverA); offline(serverA, '/v1/logs?lines=100&level=DEBUG', '/v1/server', '/v1/gateway', '/v1/usage?period=week', '/v1/jobs');
  navigation.state = stackOf(ficha);
  await expectReturn(<ShellNavigationContext.Provider value><ServerScreen serverId="A" /></ShellNavigationContext.Provider>, 'Servidores',
    () => { expect(router.dismissTo).toHaveBeenCalledWith('/servers'); expect(router.back).not.toHaveBeenCalled(); });
  await cleanupAsync();
});

test('a notice entry returns «‹ Aprobaciones», never to what was under it', async () => {
  seed(); polling(serverA);
  navigation.state = stackOf(tabsRoute('settings'), { name: 'notices/[server]/[notice]', params: { server: 'A', notice: 'n', entry: '1' } });
  await expectReturn(<NotificationProvider><NotificationNoticeScreen serverId="A" noticeId="n" /></NotificationProvider>, 'Aprobaciones', () => { expect(router.dismissTo).toHaveBeenCalledWith('/approvals'); expect(router.back).not.toHaveBeenCalled(); });
  await cleanupAsync();
});

test('a job detail entry returns «‹ Tareas» and selects its Servidor', async () => {
  seed([serverA, serverB]); polling(serverA); polling(serverB); offline(serverB, '/v1/agents/agentA/jobs/j', '/v1/agents/agentA/jobs/j/history?offset=0');
  navigation.state = stackOf({ name: 'jobs/[server]/[agent]/[job]', params: { server: 'B', agent: 'agentA', job: 'j', entry: '1' } });
  const view = await expectReturn(<JobDetailScreen serverId="B" agentId="agentA" jobId="j" />, 'Tareas', () => expect(router.dismissTo).toHaveBeenCalledWith('/jobs'));
  expect(view.probe.current!.selectedServer).toBe('B');
  await cleanupAsync();
});

test('a Servidores row opens its ficha; WorkLink selects and shows the Trabajo tab', async () => {
  seed([serverA, serverB]); polling(serverA); polling(serverB); offline(serverA, '/v1/server', '/v1/discovery'); offline(serverB, '/v1/server');
  const view = renderApp(<><ServerListScreen /><WorkLink serverId="B" name={serverB.name} /></>); await view.ready();
  fireEvent.press(await view.findByText(serverB.name));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/server/[server]', params: { server: 'B' } });
  fireEvent.press(view.getByLabelText(`Abrir Trabajo de ${serverB.name}`));
  expect(router.dismissTo).toHaveBeenCalledWith('/work');
  expect(view.probe.current!.selectedServer).toBe('B');
  await cleanupAsync();
});

test('with no Servidor paired, /connect has no return and the back key leaves Relay instead of looping through the tabs', async () => {
  seed([]);
  navigation.state = stackOf({ name: 'connect' });
  const app = renderApp(<ConnectScreen />); await app.ready();
  expect(screen.queryByText(/^‹ /)).toBeNull();
  await act(async () => { pressBack(); });
  expect(router.dismissTo).not.toHaveBeenCalled();
  expect(BackHandler.exitApp).toHaveBeenCalledTimes(1);
});
