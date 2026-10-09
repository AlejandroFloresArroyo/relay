import { useEffect, type ReactNode } from 'react';
import { render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp } from '@/state/app';

export function renderApp(children: ReactNode) {
  const probe: { current: ReturnType<typeof useApp> | null } = { current: null };
  function Probe() {
    const value = useApp();
    useEffect(() => { probe.current = value; });
    return null;
  }
  const result = render(<SafeAreaProvider><AppProvider><Probe />{children}</AppProvider></SafeAreaProvider>);
  return { ...result, probe, ready: () => waitFor(() => expect(probe.current?.ready).toBe(true)) };
}
