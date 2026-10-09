import { Linking } from 'react-native';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { TailnetPill } from '@/ui/TailnetSheet';
import { polling, seed, serverA, serverB } from '../support/fixtures';
import { renderApp } from '../support/renderApp';
import { networkError, requestsFor, respond } from '../support/transport';

async function openSheet() {
  seed([serverA, serverB]); polling(serverA);
  respond(serverB.url, '/health', networkError); respond(serverB.url, '/v1/agents', networkError);
  const app = renderApp(<ChatVisibilityProvider value={true}><TailnetPill /></ChatVisibilityProvider>); await app.ready();
  await waitFor(() => expect(app.probe.current!.snapshot('B').reachable).toBe(false));
  fireEvent.press(screen.getByLabelText('TAILNET'));
  await act(async () => { await jest.advanceTimersByTimeAsync(300); });
}

test('the pill opens the Red privada sheet with each Servidor\'s latency or SIN RESPUESTA', async () => {
  await openSheet();
  expect(screen.getByText('Red privada')).toBeVisible();
  expect(screen.getByText('TAILSCALE · FIXTURE')).toBeVisible();
  expect(screen.getByText('SIN COMPROBAR')).toBeVisible();
  expect(screen.getByText(/^\d+ MS$/)).toBeVisible();
  expect(screen.getByText('SIN RESPUESTA')).toBeVisible();
  expect(screen.getByLabelText('TAILNET')).toBeExpanded();
});

test('Reintentar polls the unresponsive Servidor again', async () => {
  await openSheet();
  const count = requestsFor(serverB.url).length;
  await act(async () => { fireEvent.press(screen.getByText('Reintentar')); });
  await waitFor(() => expect(requestsFor(serverB.url).length).toBeGreaterThan(count));
});

test('Abrir Tailscale opens the Tailscale app', async () => {
  await openSheet();
  await act(async () => { fireEvent.press(screen.getByText('Abrir Tailscale')); });
  expect(Linking.openURL).toHaveBeenCalledWith('tailscale://navigate');
});
