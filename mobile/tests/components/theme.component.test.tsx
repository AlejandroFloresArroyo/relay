import { act, cleanupAsync, fireEvent, waitFor, within } from '@testing-library/react-native';
import { SettingsScreen, AutoLockSheet } from '@/screens/SettingsScreen';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { THEME_KEY } from '@/core/theme';
import { T } from '@/ui/primitives';
import { LIGHT_PALETTE } from '@/theme/tokens';
import { stored, deferred, secureStore, storageFailures, emitColorScheme, router } from '../support/native';
import { polling, seed, serverA, serverB, settings } from '../support/fixtures';
import { renderApp } from '../support/renderApp';

const mount = () => renderApp(<ThemeProvider><SettingsScreen /><AutoLockSheet /></ThemeProvider>);
const choose = async (view: ReturnType<typeof mount>, label: string) => {
  await act(async () => { fireEvent.press(view.getByRole('radio', { name: label })); });
};

test('theme selection by gesture persists outside app settings and returns after a fresh mount', async () => {
  const view = mount(); await view.ready();
  await choose(view, 'Oscuro');
  expect(view.getByText('Ajustes')).toHaveStyle({ color: '#E8E6E1' });
  await waitFor(() => expect(stored.get(THEME_KEY)).toBe('"dark"'));
  expect(view.getByRole('radio', { name: 'Oscuro' })).toBeChecked();
  const settingsBefore = stored.get('relay.settings.v1');
  await cleanupAsync();
  const restarted = mount(); await act(async () => {}); await restarted.ready();
  await waitFor(() => expect(restarted.getByRole('radio', { name: 'Oscuro' })).toBeChecked());
  expect(restarted.getByText('Ajustes')).toHaveStyle({ color: '#E8E6E1' });
  expect(stored.get('relay.settings.v1')).toBe(settingsBefore);
});

test('the default remains light even on a dark device; System reacts live and explicit modes ignore native changes', async () => {
  emitColorScheme('dark');
  const view = mount(); await view.ready();
  expect(view.getByText('Ajustes')).toHaveStyle({ color: '#1A1A19' });
  await choose(view, 'Sistema');
  expect(view.getByText('Ajustes')).toHaveStyle({ color: '#E8E6E1' });
  await act(async () => { emitColorScheme('light'); });
  expect(view.getByText('Ajustes')).toHaveStyle({ color: '#1A1A19' });
  await choose(view, 'Oscuro');
  await act(async () => { emitColorScheme('unspecified'); emitColorScheme('light'); });
  expect(view.getByText('Ajustes')).toHaveStyle({ color: '#E8E6E1' });
  await choose(view, 'Sistema');
  await act(async () => { emitColorScheme('unspecified'); });
  expect(view.getByText('Ajustes')).toHaveStyle({ color: '#1A1A19' });
});

test('late preference loading cannot overwrite a newer gesture', async () => {
  const read = deferred<string | null>();
  secureStore.getItemAsync.mockImplementation(async key => key === THEME_KEY ? read.promise : stored.get(key) ?? null);
  const view = mount(); await view.ready();
  await choose(view, 'Oscuro');
  await act(async () => { read.resolve('"light"'); });
  expect(view.getByRole('radio', { name: 'Oscuro' })).toBeChecked();
  expect(view.getByText('Ajustes')).toHaveStyle({ color: '#E8E6E1' });
});

test('writes remain ordered while a native write is pending', async () => {
  const write = deferred<void>();
  let first = true;
  secureStore.setItemAsync.mockImplementation(async (key, value) => {
    if (key === THEME_KEY && first) { first = false; await write.promise; }
    stored.set(key, value);
  });
  const view = mount(); await view.ready();
  await choose(view, 'Oscuro'); await choose(view, 'Sistema'); await choose(view, 'Claro');
  expect(secureStore.setItemAsync.mock.calls.filter(([key]) => key === THEME_KEY)).toHaveLength(1);
  await act(async () => { write.resolve(); });
  await waitFor(() => expect(stored.get(THEME_KEY)).toBe('"light"'));
  expect(view.getByRole('radio', { name: 'Claro' })).toBeChecked();
});

test('invalid storage falls back; failed persistence is honest and does not prevent a later gesture', async () => {
  stored.set(THEME_KEY, '"automatic"'); storageFailures.write.add(THEME_KEY);
  const view = mount(); await view.ready();
  expect(view.getByRole('radio', { name: 'Claro' })).toBeChecked();
  await choose(view, 'Oscuro');
  expect(await view.findByText('El tema elegido no se guardó; se conserva hasta cerrar Relay.')).toBeVisible();
  expect(view.getByText('Ajustes')).toHaveStyle({ color: '#E8E6E1' });
  storageFailures.write.delete(THEME_KEY); await choose(view, 'Claro');
  expect(stored.get(THEME_KEY)).toBe('"light"');
  expect(view.queryByRole('alert')).toBeNull();
});

test('palette propagates to an already open global sheet and preserves the selected security setting', async () => {
  const view = mount(); await view.ready();
  fireEvent.press(view.getByText('Bloqueo automático'));
  await choose(view, 'Oscuro');
  expect(view.getByLabelText('Bloqueo automático')).toHaveStyle({ backgroundColor: '#1F1E1C' });
  expect(view.probe.current!.settings.autoLockMs).toBe(60000);
  expect(view.getByRole('radio', { name: /1 MIN/ })).toBeChecked();
});

test('standalone primitives retain the original light fallback', async () => {
  const view = renderApp(<T>Contenido autónomo</T>); await view.ready();
  expect(view.getByText('Contenido autónomo')).toHaveStyle({ color: '#1A1A19' });
});


test('failed native reads use light and a bounded honest message without exception details', async () => {
  secureStore.getItemAsync.mockImplementation(async key => {
    if (key === THEME_KEY) throw new Error('synthetic-private-storage-detail');
    return stored.get(key) ?? null;
  });
  const view = mount(); await view.ready();
  expect(await view.findByText('El tema guardado no se pudo leer.')).toBeVisible();
  expect(view.getByText('Ajustes')).toHaveStyle({ color: '#1A1A19' });
  expect(view.queryByText(/synthetic-private/)).toBeNull();
  await choose(view, 'Oscuro');
  expect(view.queryByRole('alert')).toBeNull();
  expect(stored.get(THEME_KEY)).toBe('"dark"');
});

// AppProvider/Settings/ThemeProvider real; only native storage is retained.
test('review: a pending write from the previous mount cannot overwrite the latest persisted theme',async()=>{
 const pending=deferred<void>();let first=true;
 secureStore.setItemAsync.mockImplementation(async(key,value)=>{
  if(key===THEME_KEY && first){first=false;await pending.promise;}
  stored.set(key,value);
 });
 const old=mount();await old.ready();await choose(old,'Oscuro');
 await waitFor(()=>expect(secureStore.setItemAsync.mock.calls.filter(([key])=>key===THEME_KEY)).toHaveLength(1));
 await cleanupAsync();
 const current=mount();await current.ready();await choose(current,'Sistema');
 expect(current.getByRole('radio',{name:'Sistema'})).toBeChecked();
 await act(async()=>pending.resolve());
 await cleanupAsync();
 const reopened=mount();await reopened.ready();
 await waitFor(()=>expect(reopened.getByRole('radio',{name:'Sistema'})).toBeChecked());
});


test('a fresh theme reader observes a native write already pending in an older mount',async()=>{
 const pending=deferred<void>();let first=true;
 secureStore.setItemAsync.mockImplementation(async(key,value)=>{if(key===THEME_KEY&&first){first=false;await pending.promise;}stored.set(key,value);});
 const old=mount();await old.ready();await choose(old,'Oscuro');
 await waitFor(()=>expect(secureStore.setItemAsync.mock.calls.filter(([key])=>key===THEME_KEY)).toHaveLength(1));
 await cleanupAsync();
 const current=mount();await current.ready();
 await act(async()=>pending.resolve());
 await waitFor(()=>expect(current.getByRole('radio',{name:'Oscuro'})).toBeChecked());
});

describe('Ajustes of 3.1 (D-04)', () => {
  test('the Servidores list and the SIN RESPUESTA block are gone; one row opens Servidores with the selected one', async () => {
    seed([serverA, serverB], settings); polling(serverA); polling(serverB);
    const view = mount(); await view.ready();
    await waitFor(() => expect(view.getByText('Servidor A')).toBeVisible());
    expect(view.queryByText('SERVIDORES')).toBeNull(); expect(view.queryByText('Servidor B')).toBeNull(); expect(view.queryByText(/SIN RESPUESTA/)).toBeNull();
    expect(view.getByText('La lista está en Servidores')).toBeVisible();
    fireEvent.press(view.getByText('Servidor predeterminado'));
    expect(router.dismissTo).toHaveBeenCalledWith('/servers');
  });

  test('the switch LED is green when on and off when off', async () => {
    seed([], settings);
    const view = mount(); await view.ready();
    const led = () => within(view.getByRole('switch', { name: /Desbloquear con huella/ })).getByTestId('switch-led');
    expect(led()).toHaveStyle({ backgroundColor: LIGHT_PALETTE.K.ok });
    await act(async () => { fireEvent.press(view.getByRole('switch', { name: /Desbloquear con huella/ })); });
    expect(led()).toHaveStyle({ backgroundColor: LIGHT_PALETTE.K.ledOff });
  });

  test('Avisos and Acerca de sit under MÁS (Widget only in the demo); Avisos opens the selected Servidor', async () => {
    seed([serverA], settings); polling(serverA);
    const view = mount(); await view.ready();
    expect(view.getByText('ntfy privado')).toBeVisible(); expect(view.queryByText('Widget')).toBeNull(); expect(view.getByText('Acerca de')).toBeVisible();
    fireEvent.press(view.getByText('Avisos'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/notifications/[server]', params: { server: 'A' } });
  });

  test('Confirmar aprobaciones is a read-only switch: role switch, checked, disabled', async () => {
    seed([], settings);
    const view = mount(); await view.ready();
    const row = view.getByRole('switch', { name: /Confirmar aprobaciones/ });
    expect(row).toBeChecked(); expect(row).toBeDisabled();
  });
});
