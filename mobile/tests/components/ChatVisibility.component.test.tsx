import { useEffect } from 'react';
import { Text } from 'react-native';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { LockGate } from '@/screens/LockGate';
import { useChatVisible } from '@/state/chatVisibility';
import { biometrics, deferred, emitAppState } from '../support/native';
import { polling, seed, serverA } from '../support/fixtures';
import { renderApp } from '../support/renderApp';

test('chat visibility defaults to false outside LockGate', () => {
  function Probe() { return <Text>{String(useChatVisible())}</Text>; }
  render(<Probe />);
  expect(screen.getByText('false')).toBeVisible();
});

test('chat visibility follows authentication, background and lock while children remain mounted', async () => {
  seed(); polling(serverA);
  const lifecycle = { mounts: 0, cleanups: 0 };
  const values: boolean[] = [];
  function Probe() {
    const visible = useChatVisible();
    useEffect(() => { lifecycle.mounts++; return () => { lifecycle.cleanups++; }; }, []);
    useEffect(() => { values.push(visible); }, [visible]);
    return <Text>{visible ? 'Chat visible' : 'Chat oculto'}</Text>;
  }
  const first = deferred<{ success: boolean }>();
  biometrics.authenticateAsync.mockReturnValueOnce(first.promise);
  const app = renderApp(<LockGate><Probe /></LockGate>); await app.ready();
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(1));
  expect(values.at(-1)).toBe(false);
  await act(async () => { first.resolve({ success: true }); });
  expect(screen.getByText('Chat visible')).toBeVisible();
  await act(async () => { emitAppState('background'); });
  expect(values.at(-1)).toBe(false);
  jest.setSystemTime(Date.now() + 60000);
  const second = deferred<{ success: boolean }>();
  biometrics.authenticateAsync.mockReturnValueOnce(second.promise);
  await act(async () => { emitAppState('active'); });
  await waitFor(() => expect(biometrics.authenticateAsync).toHaveBeenCalledTimes(2));
  expect(values.at(-1)).toBe(false);
  expect(lifecycle).toEqual({ mounts: 1, cleanups: 0 });
  await act(async () => { second.resolve({ success: true }); });
  expect(values.at(-1)).toBe(true);
  app.unmount(); expect(lifecycle).toEqual({ mounts: 1, cleanups: 1 });
});
