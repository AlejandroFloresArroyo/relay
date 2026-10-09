import { act, fireEvent, screen } from '@testing-library/react-native';
import { PixelRatio, ScrollView } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '@/state/app';
import { TABS } from '@/core/navigation';
import { TabBar } from '@/ui/TabBar';
import { approval, polling, seed, serverA } from '../support/fixtures';
import { resizeWindow } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, respond } from '../support/transport';

async function mountBar(pendingApprovals = false) {
  seed([serverA]); polling(serverA);
  if (pendingApprovals) respond(serverA.url, '/v1/approvals', json({ approvals: [approval().approval] }));
  const onSelect = jest.fn();
  const app = renderApp(<TabBar active="agents" onSelect={onSelect} />);
  await app.ready();
  if (pendingApprovals) await act(async () => { await app.probe.current!.refresh(serverA.id); });
  return { ...app, onSelect };
}
const bar = () => screen.UNSAFE_getByType(ScrollView);
const badge = () => screen.queryByRole('button', { name: 'Ver 1 Aprobaciones pendientes' });

test('the eight tabs in order, the active one selected, and a press selects its key', async () => {
  const { onSelect } = await mountBar();
  expect(screen.getAllByRole('tab').map(tab => tab.props.accessibilityLabel)).toEqual(['Agentes', 'Herramientas', 'Tablero', 'Trabajo', 'Tareas', 'Aprobaciones', 'Servidores', 'Ajustes']);
  expect(screen.getByRole('tab', { name: 'Agentes' })).toBeSelected();
  expect(screen.getByRole('tab', { name: 'Tareas' })).not.toBeSelected();
  fireEvent.press(screen.getByRole('tab', { name: 'Tareas' }));
  expect(onSelect).toHaveBeenCalledWith('jobs');
});

// Martian Mono advances 0.707 em: «AGENTES» is 47 px at 9.5 in the canvas (D-0-barra).
test('at 130 % system font every tab label fits its 66-wide key on one line', async () => {
  resizeWindow(390, 844, 1.3);
  await mountBar();
  for (const { short } of TABS) {
    expect(screen.getByText(short).props.numberOfLines).toBe(1);
    expect(short.length * (47 / 7) * PixelRatio.getFontScale()).toBeLessThanOrEqual(66);
  }
});

test('no badge without pending Aprobaciones', async () => {
  await mountBar();
  expect(badge()).toBeNull();
});

test('the badge shows while APROB. is out of view and pressing it brings APROB. in', async () => {
  await mountBar(true);
  expect(badge()).toHaveTextContent('1 ›');
  fireEvent.press(badge()!);
  // 390 wide: APROB. ends at 438, plus the 12 margin.
  expect(bar().props.contentOffset).toEqual({ x: 60, y: 0 });
  expect(badge()).toBeNull();
});

test('the bar remembers its position across remounts', async () => {
  const { rerender } = await mountBar(true);
  fireEvent.scroll(bar(), { nativeEvent: { contentOffset: { x: 200, y: 0 } } });
  expect(badge()).toBeNull();
  const tree = (shown: boolean) => <SafeAreaProvider><AppProvider>{shown ? <TabBar active="agents" onSelect={jest.fn()} /> : null}</AppProvider></SafeAreaProvider>;
  rerender(tree(false));
  expect(screen.queryAllByRole('tab')).toHaveLength(0);
  rerender(tree(true));
  expect(bar().props.contentOffset).toEqual({ x: 200, y: 0 });
  expect(badge()).toBeNull();
  fireEvent.scroll(bar(), { nativeEvent: { contentOffset: { x: 0, y: 0 } } });
  expect(badge()).not.toBeNull();
});
