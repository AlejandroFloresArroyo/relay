import { useEffect } from 'react';
import { Text } from 'react-native';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { LockGate } from '@/screens/LockGate';
import { Sheet } from '@/ui/sheet';
import { biometrics, deferred, emitAppState } from '../support/native';
import { polling, seed, serverA, settings } from '../support/fixtures';
import { renderApp } from '../support/renderApp';

function mountGate() {
  const lifecycle = { mounts: 0, cleanups: 0 };
  function ProtectedProbe() {
    useEffect(() => { lifecycle.mounts++; return () => { lifecycle.cleanups++; }; }, []);
    return <Text>Conversación protegida</Text>;
  }
  return { ...renderApp(<LockGate><ProtectedProbe /></LockGate>), lifecycle };
}
function expectHidden() {
  expect(screen.getByText('Relay está bloqueado')).toBeVisible();
  expect(screen.queryByText('Conversación protegida')).toBeNull();
  const text = screen.getByText('Conversación protegida', { includeHiddenElements: true });
  expect(text).not.toBeVisible();
  let container = text.parent;
  while (container && container.props.importantForAccessibility !== 'no-hide-descendants') container = container.parent;
  expect(container).not.toBeNull();
  expect(container).toHaveStyle({ display: 'none' });
}
async function absence(ms: number) {
  await act(async () => { emitAppState('background'); });
  jest.setSystemTime(Date.now() + ms);
  await act(async () => { emitAppState('active'); });
}

test('the initial prompt hides accessible content but preserves its mounted effect until a successful unlock', async () => {
  seed(); polling(serverA);
  const auth = deferred<{ success: boolean }>();
  biometrics.authenticateAsync.mockReturnValueOnce(auth.promise);
  const app = mountGate();
  await app.ready();
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
  expectHidden();
  expect(app.lifecycle).toEqual({ mounts: 1, cleanups: 0 });
  await act(async () => { auth.resolve({ success: true }); });
  expect(screen.getByText('Conversación protegida')).toBeVisible();
  await act(async () => { app.probe.current!.refresh(); });
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1);
  expect(app.lifecycle).toEqual({ mounts: 1, cleanups: 0 });
  app.unmount();
  expect(app.lifecycle).toEqual({ mounts: 1, cleanups: 1 });
});

test.each(['cancel', 'reject'])('%s leaves content hidden and a manual press runs another real prompt', async (outcome) => {
  seed(); polling(serverA);
  if (outcome === 'reject') biometrics.authenticateAsync.mockRejectedValueOnce(new Error('Fixture cancelled authentication'));
  const app = mountGate(); await app.ready();
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
  expectHidden();
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  await act(async () => { fireEvent.press(screen.getByText('Usar el código del teléfono')); });
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Conversación protegida')).toBeVisible();
  expect(app.lifecycle).toEqual({ mounts: 1, cleanups: 0 });
});

test.each(['first server', 'enable faceid'])('adding %s after startup does not create a late initial prompt', async (change) => {
  seed(change === 'first server' ? [] : [serverA], { ...settings, faceid: change === 'first server' });
  polling(serverA);
  const app = mountGate(); await app.ready();
  expect(screen.getByText('Conversación protegida')).toBeVisible();
  await act(async () => {
    if (change === 'first server') await app.probe.current!.addServer(serverA);
    else app.probe.current!.setSetting('faceid', true);
  });
  expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
  expect(screen.getByText('Conversación protegida')).toBeVisible();
  expect(app.lifecycle).toEqual({ mounts: 1, cleanups: 0 });
});

test('return prompts at the selected exact threshold, including changes to one minute and AHORA without remounting', async () => {
  seed([serverA], { ...settings, autoLockMs: 300000 }); polling(serverA);
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  const app = mountGate(); await app.ready();
  await waitFor(() => expect(screen.getByText('Conversación protegida')).toBeVisible());
  expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1);
  for (const [delay, below] of [[300000, 299999], [60000, 59999], [0, null]] as const) {
    await act(async () => { app.probe.current!.setSetting('autoLockMs', delay); });
    const calls = biometrics.authenticateAsync.mock.calls.length;
    if (below !== null) {
      await absence(below);
      expect(screen.getByText('Conversación protegida')).toBeVisible();
      expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(calls);
    }
    const auth = deferred<{ success: boolean }>();
    biometrics.authenticateAsync.mockReturnValueOnce(auth.promise);
    await absence(delay);
    await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(calls + 1));
    expectHidden();
    expect(app.lifecycle).toEqual({ mounts: 1, cleanups: 0 });
    await act(async () => { auth.resolve({ success: true }); });
    expect(screen.getByText('Conversación protegida')).toBeVisible();
  }
});

test('a sheet opened before the lock leaves while locked and comes back after unlock', async () => {
  seed(); polling(serverA);
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  const app = renderApp(<LockGate><Sheet visible title="Red privada" onClose={() => {}}><Text>contenido</Text></Sheet></LockGate>); await app.ready();
  await waitFor(() => expect(screen.getByTestId('sheet')).toBeVisible());
  const auth = deferred<{ success: boolean }>();
  biometrics.authenticateAsync.mockReturnValueOnce(auth.promise);
  await absence(settings.autoLockMs);
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(2));
  expect(screen.getByText('Relay está bloqueado')).toBeVisible();
  // A native Modal is its own window: hiding its parent does not hide it, so it must not exist at all.
  expect(screen.queryByTestId('sheet', { includeHiddenElements: true })).toBeNull();
  await act(async () => { auth.resolve({ success: true }); });
  expect(screen.getByTestId('sheet')).toBeVisible();
});

test.each(['hardware', 'enrollment'] as const)('missing biometric %s requires successful phone authentication instead of opening Relay', async (missing) => {
  seed(); polling(serverA);
  if (missing === 'hardware') biometrics.hasHardwareAsync.mockResolvedValue(false);
  else biometrics.isEnrolledAsync.mockResolvedValue(false);
  const app = mountGate(); await app.ready();
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
  expect(biometrics.authenticateAsync).toHaveBeenCalledWith(expect.objectContaining({ disableDeviceFallback: false }));
  expectHidden();
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  await act(async () => { fireEvent.press(screen.getByText('Usar el código del teléfono')); });
  expect(screen.getByText('Conversación protegida')).toBeVisible();
});
