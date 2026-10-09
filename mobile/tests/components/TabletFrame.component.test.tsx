import { act, fireEvent, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import { TABS } from '@/core/navigation';
import { LIST_WIDTHS_KEY } from '@/core/relayLayout';
import { RelayShell } from '@/ui/RelayShell';
import { agentA, polling, seed, serverA, serverB, serverInfo, settings } from '../support/fixtures';
import { drag, tap } from '../support/gestures';
import { animatedStyle } from '../support/motion';
import { navigation, resizeWindow, router, showRoute, stored } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, respond } from '../support/transport';

function setup(pathname: string, width: number) {
  seed([serverA, serverB], { ...settings, faceid: false });
  polling(serverA, [agentA]); polling(serverB);
  for (const server of [serverA, serverB]) {
    respond(server.url, '/v1/discovery', json({ bridges: [], truncated: false }));
    respond(server.url, '/v1/server', json(serverInfo));
  }
  navigation.pathname = pathname; resizeWindow(width, 800);
}

async function mount() {
  const app = renderApp(<RelayShell><Text>Detalle</Text></RelayShell>); await app.ready();
  await act(async () => { await jest.advanceTimersByTimeAsync(0); });
  return app;
}

const widthOf = (label: string) => animatedStyle(screen.getByLabelText(label)).width as number;
/** The detail takes what the window leaves after the edges, the rail, the list and the two gaps. */
const detail = (window: number, rail: number, list: number) => window - 2 * 16 - rail - 2 * 12 - list;

test('☰ and a swipe open the rail to 240 in the row, pushing the list, and folding it restores the list', async () => {
  setup('/usage/A', 1000);
  const app = await mount();
  expect(widthOf('Navegación principal')).toBe(72);
  expect(widthOf('Lista de Servidores')).toBe(320);
  expect(screen.getByLabelText('Contenido principal')).not.toHaveStyle({ maxWidth: 820 });
  fireEvent.press(screen.getByLabelText('Desplegar menú'));
  await act(async () => { await jest.advanceTimersByTimeAsync(280); });
  const rail = animatedStyle(screen.getByLabelText('Navegación principal'));
  expect(rail.width).toBe(240);
  expect(rail.position).not.toBe('absolute');
  expect(widthOf('Lista de Servidores')).toBe(314);
  expect(screen.getByRole('tab', { name: 'Servidores' })).toBeSelected();
  drag('riel', [{ x: -60 }]);
  await act(async () => { await jest.advanceTimersByTimeAsync(280); });
  expect(widthOf('Navegación principal')).toBe(72);
  expect(widthOf('Lista de Servidores')).toBe(320);
  expect(stored.has(LIST_WIDTHS_KEY)).toBe(false);
  drag('riel', [{ x: 30 }]);
  expect(screen.getByLabelText('Desplegar menú')).toBeVisible();
  drag('riel', [{ x: 60 }]);
  await act(async () => { await jest.advanceTimersByTimeAsync(280); });
  expect(widthOf('Navegación principal')).toBe(240);
  fireEvent.press(screen.getByLabelText('Plegar menú'));
  await act(async () => { await jest.advanceTimersByTimeAsync(280); });
  expect(widthOf('Navegación principal')).toBe(72);
  app.unmount();
});

test('a narrow tablet hides the list while the rail is open instead of covering the detail', async () => {
  setup('/chat/A/agentA', 800);
  const app = await mount();
  expect(widthOf('Lista de Agentes')).toBe(282);
  fireEvent.press(screen.getByLabelText('Desplegar menú'));
  await act(async () => { await jest.advanceTimersByTimeAsync(280); });
  expect(screen.queryByLabelText('Lista de Agentes')).toBeNull();
  expect(screen.getByText('Detalle')).toBeVisible();
  app.unmount();
});

test.each([[1180, 560], [1000, 482]])('the list edge stops at 280 and its maximum at width %d, keeping the detail at least 390', async (window, max) => {
  setup('/chat/A/agentA', window);
  const app = await mount();
  expect(widthOf('Lista de Agentes')).toBe(294);
  drag('borde-lista', [{ x: 100 }, { x: 600 }]);
  expect(widthOf('Lista de Agentes')).toBe(max);
  expect(detail(window, 72, max)).toBeGreaterThanOrEqual(390);
  drag('borde-lista', [{ x: -600 }]);
  expect(widthOf('Lista de Agentes')).toBe(280);
  expect(JSON.parse(stored.get(LIST_WIDTHS_KEY)!)).toEqual({ agents: 280 });
  app.unmount();
});

test('each section remembers its own width across remounts and a double tap restores the default', async () => {
  setup('/chat/A/agentA', 1180);
  let app = await mount();
  drag('borde-lista', [{ x: 106 }]);
  expect(widthOf('Lista de Agentes')).toBe(400);
  await act(async () => showRoute('/usage/A'));
  expect(widthOf('Lista de Servidores')).toBe(320);
  drag('borde-lista', [{ x: 130 }]);
  expect(JSON.parse(stored.get(LIST_WIDTHS_KEY)!)).toEqual({ agents: 400, servers: 450 });
  app.unmount();
  navigation.pathname = '/chat/A/agentA';
  app = await mount();
  expect(widthOf('Lista de Agentes')).toBe(400);
  tap('borde-lista-doble');
  expect(widthOf('Lista de Agentes')).toBe(294);
  expect(JSON.parse(stored.get(LIST_WIDTHS_KEY)!)).toEqual({ servers: 450 });
  await act(async () => showRoute('/usage/A'));
  expect(widthOf('Lista de Servidores')).toBe(450);
  app.unmount();
});

test('the list edge resizes from accessibility actions, not only by dragging', async () => {
  setup('/chat/A/agentA', 1180);
  const app = await mount();
  const edge = screen.getByLabelText('Ancho de la lista');
  expect(edge.props.accessibilityRole).toBe('adjustable');
  const act11y = (actionName: string) => fireEvent(screen.getByLabelText('Ancho de la lista'), 'accessibilityAction', { nativeEvent: { actionName } });
  act11y('increment');
  expect(widthOf('Lista de Agentes')).toBe(334);
  act11y('decrement'); act11y('decrement');
  expect(widthOf('Lista de Agentes')).toBe(280);
  for (let i = 0; i < 10; i++) act11y('increment');
  expect(widthOf('Lista de Agentes')).toBe(560);
  act11y('activate');
  expect(widthOf('Lista de Agentes')).toBe(294);
  app.unmount();
});

test('the rail keys switch tabs with dismissTo and mark the destination; tool screens take the full width', async () => {
  setup('/board', 1180);
  const app = await mount();
  expect(screen.queryByLabelText(/^Lista de/)).toBeNull();
  expect(screen.getByLabelText('Contenido principal')).toHaveStyle({ maxWidth: 820 });
  expect(screen.getAllByRole('tab').map(tab => tab.props.accessibilityLabel)).toEqual(TABS.map(tab => tab.name));
  expect(screen.getByRole('tab', { name: 'Tablero' })).toBeSelected();
  for (const tab of TABS) {
    fireEvent.press(screen.getByRole('tab', { name: tab.name }));
    expect(router.dismissTo).toHaveBeenLastCalledWith(`/${tab.key}`);
  }
  expect(router.navigate).not.toHaveBeenCalled();
  expect(router.push).not.toHaveBeenCalled();
  act(() => showRoute('/tools'));
  expect(StyleSheet.flatten(screen.getByLabelText('Contenido principal').props.style).maxWidth).toBeUndefined();
  expect(screen.getByRole('tab', { name: 'Herramientas' })).toBeSelected();
  app.unmount();
});
