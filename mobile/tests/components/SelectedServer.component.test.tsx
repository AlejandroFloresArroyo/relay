import { useEffect } from 'react';
import { Text } from 'react-native';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { ServerConnectionStatus } from '@/ui/ServerConnectionStatus';
import { SelectorToast, ServerDown, ServerSection, ServerSelector } from '@/ui/ServerSelector';
import { agentA, polling, seed, serverA, serverB, settings } from '../support/fixtures';
import { LockGate } from '@/screens/LockGate';
import { secureStore, showRoute, stackOf, stored, tabsRoute } from '../support/native';
import { ServerToolsHost } from '@/screens/ServerToolsHost';
import { renderApp } from '../support/renderApp';
import { networkError, requestsFor, respond } from '../support/transport';

const KEY = 'relay.selectedServer.v1';
const selectionWrites = () => secureStore.setItemAsync.mock.calls.filter(([key]) => key === KEY);

test('the first time the default Servidor is selected and remembered, so a later default does not move it', async () => {
  seed([serverB, serverA]); polling(serverA); polling(serverB);
  const app = renderApp(null); await app.ready();
  expect(app.probe.current!.selectedServer).toBe('A');
  await waitFor(() => expect(stored.get(KEY)).toBe('A'));
  expect(selectionWrites()).toHaveLength(1);
  await act(async () => { await app.probe.current!.setDefaultServer('B'); });
  expect(app.probe.current!.selectedServer).toBe('A');
  expect(selectionWrites()).toHaveLength(1);
});

test('the chosen Servidor is remembered across launches', async () => {
  seed([serverA, serverB]); polling(serverA); polling(serverB);
  const first = renderApp(null); await first.ready();
  await act(async () => { first.probe.current!.selectServer('B'); });
  expect(first.probe.current!.selectedServer).toBe('B');
  expect(stored.get(KEY)).toBe('B');
  first.unmount();
  const second = renderApp(null); await second.ready();
  expect(second.probe.current!.selectedServer).toBe('B');
});

test('an unpaired id never replaces the selection nor reaches storage', async () => {
  seed([serverA, serverB]); polling(serverA); polling(serverB); stored.set(KEY, 'B');
  const app = renderApp(null); await app.ready();
  await act(async () => { app.probe.current!.selectServer('ghost'); });
  expect(app.probe.current!.selectedServer).toBe('B');
  expect(selectionWrites()).toEqual([]);
});

test('removing the selected Servidor falls back to the default, and to none when none is left', async () => {
  seed([serverA, serverB]); polling(serverA); polling(serverB); stored.set(KEY, 'B');
  const app = renderApp(null); await app.ready();
  expect(app.probe.current!.selectedServer).toBe('B');
  await act(async () => { await app.probe.current!.removeServer('B'); });
  expect(app.probe.current!.selectedServer).toBe('A');
  // The fallback is stored once, like a choice.
  await waitFor(() => expect(stored.get(KEY)).toBe('A'));
  await act(async () => { await app.probe.current!.removeServer('A'); });
  expect(app.probe.current!.selectedServer).toBeNull();
});

const down = (server: typeof serverB) => { respond(server.url, '/health', networkError); respond(server.url, '/v1/agents', networkError); };
// Stepped, so the shake timer's close renders before the sheet's slide-out runs.
const advance = async (ms: number) => { for (let t = 0; t < ms; t += 50) await act(async () => { await jest.advanceTimersByTimeAsync(50); }); };

test('an unresponsive Servidor stays selected and its section shows the compact row, not the big block', async () => {
  seed([serverA, serverB]); polling(serverA); down(serverB); stored.set(KEY, 'B');
  const app = renderApp(<ChatVisibilityProvider value={true}><ServerSection>{id => <><ServerDown serverId={id} /><ServerConnectionStatus serverId={id} /></>}</ServerSection></ChatVisibilityProvider>); await app.ready();
  await waitFor(() => expect(screen.getByText('SERVIDOR B · SIN RESPUESTA')).toBeVisible());
  expect(app.probe.current!.selectedServer).toBe('B');
  expect(screen.queryByText(/Relay no alcanza/)).toBeNull();
  const count = requestsFor(serverB.url).length;
  await act(async () => { fireEvent.press(screen.getByText('Reintentar')); });
  await waitFor(() => expect(requestsFor(serverB.url).length).toBeGreaterThan(count));
});

test('choosing an unresponsive Servidor selects it, shakes the row, toasts and closes the sheet after the shake', async () => {
  seed([serverA, serverB]); polling(serverA); down(serverB);
  const app = renderApp(<ChatVisibilityProvider value={true}><><ServerSelector variant="header" /><SelectorToast /></></ChatVisibilityProvider>); await app.ready();
  await waitFor(() => expect(app.probe.current!.snapshot('B').reachable).toBe(false));
  fireEvent.press(screen.getByLabelText('Servidor Servidor A'));
  await advance(300);
  expect(screen.getByText('SIN RESPUESTA')).toBeVisible();
  await act(async () => { fireEvent.press(screen.getByText('Servidor B')); });
  expect(app.probe.current!.selectedServer).toBe('B');
  expect(screen.getByText('Servidor B sin respuesta')).toBeVisible();
  await advance(350);
  expect(screen.getByText('Servidores')).toBeVisible();
  await advance(400);
  expect(screen.queryByText('Servidores')).toBeNull();
  expect(screen.getByText('Servidor B sin respuesta')).toBeVisible();
  await advance(1300);
  expect(screen.queryByText('Servidor B sin respuesta')).toBeNull();
});

test('choosing an answering Servidor selects it and closes the sheet', async () => {
  seed([serverA, serverB]); polling(serverA); polling(serverB);
  const app = renderApp(<ChatVisibilityProvider value={true}><><ServerSelector variant="header" /><SelectorToast /></></ChatVisibilityProvider>); await app.ready();
  await waitFor(() => expect(app.probe.current!.snapshot('B').reachable).toBe(true));
  fireEvent.press(screen.getByLabelText('Servidor Servidor A'));
  await advance(300);
  expect(screen.getAllByText('EN LÍNEA')).toHaveLength(2);
  await act(async () => { fireEvent.press(screen.getByText('Servidor B')); });
  await advance(400);
  expect(app.probe.current!.selectedServer).toBe('B');
  expect(screen.queryByText('Servidores')).toBeNull();
  expect(screen.queryByText(/sin respuesta/)).toBeNull();
});

test('a section hands its children the selected id and remounts them when it changes', async () => {
  seed([serverA, serverB]); polling(serverA); polling(serverB);
  const mounted = jest.fn();
  function Child({ id }: { id: string }) {
    useEffect(() => { mounted(id); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return <Text>{`hijo ${id}`}</Text>;
  }
  const app = renderApp(<ChatVisibilityProvider value={true}><ServerSection>{id => <Child id={id} />}</ServerSection></ChatVisibilityProvider>); await app.ready();
  expect(screen.getByText('hijo A')).toBeVisible();
  await act(async () => { app.probe.current!.selectServer('B'); });
  expect(screen.getByText('hijo B')).toBeVisible();
  expect(mounted.mock.calls).toEqual([['A'], ['B']]);
});

test('the Herram. tab of an unresponsive Servidor shows the compact row, not the big block', async () => {
  seed([serverA, serverB], { ...settings, faceid: false }); polling(serverA); down(serverB); stored.set(KEY, 'B');
  showRoute('/tools', {}, stackOf(tabsRoute('tools')));
  const app = renderApp(<LockGate><ServerToolsHost /></LockGate>); await app.ready();
  await waitFor(() => expect(screen.getByText('SERVIDOR B · SIN RESPUESTA')).toBeVisible());
  expect(screen.queryByText(/Relay no alcanza/)).toBeNull();
  const count = requestsFor(serverB.url).length;
  await act(async () => { fireEvent.press(screen.getByText('Reintentar')); });
  await waitFor(() => expect(requestsFor(serverB.url).length).toBeGreaterThan(count));
});

test('the rail key sweeps for a busy Servidor and goes dark when it stops answering, despite its last known Agentes', async () => {
  seed([serverA]); polling(serverA, [{ ...agentA, status: 'busy' }]);
  const app = renderApp(<ChatVisibilityProvider value={true}><ServerSelector variant="rail" /></ChatVisibilityProvider>); await app.ready();
  await waitFor(() => expect(screen.getByTestId('server-sweep')).toBeTruthy());
  down(serverA);
  await act(async () => { app.probe.current!.refresh('A'); });
  await waitFor(() => expect(app.probe.current!.snapshot('A').reachable).toBe(false));
  expect(app.probe.current!.snapshot('A').agents).toHaveLength(1);
  expect(screen.queryByTestId('server-sweep')).toBeNull();
});
