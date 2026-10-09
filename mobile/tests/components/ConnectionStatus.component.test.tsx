import { Linking } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ConnectionStatus } from '@/ui/ConnectionStatus';
import { ServerConnectionStatus } from '@/ui/ServerConnectionStatus';
import { ConnectScreen } from '@/screens/ConnectScreen';
import { health, polling, seed, serverA } from '../support/fixtures';
import { deferred, router } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, networkError, requestsFor, respond } from '../support/transport';

async function fallback() {
  await act(async () => { fireEvent.press(screen.getByText('Abrir Tailscale')); });
  await waitFor(() => expect(screen.getByText('Volver a detectar')).toBeVisible());
}

test('a rejected Tailscale link becomes a repeatable retry and never opens the link again', async () => {
  const retry = jest.fn();
  render(<ConnectionStatus serverName="Servidor ficticio" subject onRetry={retry} />);
  await fallback();
  expect(Linking.openURL).toHaveBeenCalledTimes(1);
  expect(Linking.openURL).toHaveBeenCalledWith('tailscale://navigate');
  fireEvent.press(screen.getByText('Volver a detectar'));
  fireEvent.press(screen.getByText('Volver a detectar'));
  expect(retry).toHaveBeenCalledTimes(2);
  expect(Linking.openURL).toHaveBeenCalledTimes(1);
});

test('a pending opening disables the button and a second press cannot launch again', async () => {
  const open = deferred<void>();
  jest.mocked(Linking.openURL).mockReturnValueOnce(open.promise);
  render(<ConnectionStatus serverName="Servidor ficticio" subject onRetry={jest.fn()} />);
  await act(async () => { fireEvent.press(screen.getByText('Abrir Tailscale')); });
  expect(screen.getByText('Abrir Tailscale')).toBeDisabled();
  fireEvent.press(screen.getByText('Abrir Tailscale'));
  expect(Linking.openURL).toHaveBeenCalledTimes(1);
  await act(async () => { open.reject(new Error('Fixture link rejected')); });
  expect(screen.getByText('Volver a detectar')).toBeVisible();
});

test('the provider panel fallback polls its own server again through the real parent callback', async () => {
  seed();
  respond(serverA.url, '/health', networkError); respond(serverA.url, '/v1/agents', networkError);
  const app = renderApp(<ServerConnectionStatus serverId="A" subject />); await app.ready();
  await waitFor(() => expect(screen.getByText('SIN RESPUESTA · REVISA TAILNET')).toBeVisible());
  const count = requestsFor(serverA.url).length;
  await fallback();
  await act(async () => { fireEvent.press(screen.getByText('Volver a detectar')); });
  expect(requestsFor(serverA.url).length).toBeGreaterThan(count);
  expect(Linking.openURL).toHaveBeenCalledTimes(1);
  expect(Linking.openURL).toHaveBeenCalledWith('tailscale://navigate');
});

test('manual pairing fallback repeats the pairing request rather than opening Tailscale again', async () => {
  seed([]); respond(serverA.url, '/health', json(health));
  respond(serverA.url, '/v1/pair', networkError, 'POST');
  const app = renderApp(<ConnectScreen />); await app.ready();
  fireEvent.press(screen.getByText('Escribir el código a mano'));
  fireEvent.changeText(screen.getByLabelText('Dirección del Servidor'), serverA.url);
  fireEvent.changeText(screen.getByLabelText('Código de emparejamiento de diez caracteres'), 'ABCDE12345');
  await act(async () => { fireEvent.press(screen.getByText('Emparejar')); });
  await waitFor(() => expect(screen.getByText('SIN RESPUESTA')).toBeVisible());
  expect(requestsFor(serverA.url, '/v1/pair')).toHaveLength(1);
  expect(requestsFor(serverA.url, '/v1/pair')[0].body).toEqual({ code: 'ABCDE12345' });
  await fallback();
  expect(Linking.openURL).toHaveBeenCalledWith('tailscale://');
  await act(async () => { fireEvent.press(screen.getByText('Volver a detectar')); });
  expect(requestsFor(serverA.url, '/v1/pair')).toHaveLength(2);
  expect(Linking.openURL).toHaveBeenCalledTimes(1);
});

test('a revoked server panel pairs again using that Server identity', async () => {
  seed(); polling(serverA);
  respond(serverA.url, '/v1/agents', json({ error: { code: 'device_revoked', message: 'Fixture revoked' } }, 403));
  const app = renderApp(<ServerConnectionStatus serverId="A" subject />); await app.ready();
  await screen.findByText('DISPOSITIVO REVOCADO');
  fireEvent.press(screen.getByText('Emparejar de nuevo'));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/connect', params: { serverId: 'A' } });
});

test('outside its ficha an unresponsive Servidor is the compact row: no big block, no Tailscale, only «Reintentar»', async () => {
  seed();
  respond(serverA.url, '/health', networkError); respond(serverA.url, '/v1/agents', networkError);
  const app = renderApp(<ServerConnectionStatus serverId="A" />); await app.ready();
  await waitFor(() => expect(screen.getByText(`${serverA.name.toUpperCase()} · SIN RESPUESTA`)).toBeVisible());
  expect(screen.queryByText('Abrir Tailscale')).toBeNull();
  expect(screen.queryByText(/Relay no alcanza/)).toBeNull();
  const count = requestsFor(serverA.url).length;
  await act(async () => { fireEvent.press(screen.getByText('Reintentar')); });
  await waitFor(() => expect(requestsFor(serverA.url).length).toBeGreaterThan(count));
});

test('outside its ficha a revoked Servidor is the compact row naming the cause that pairs again', async () => {
  seed(); polling(serverA);
  respond(serverA.url, '/v1/agents', json({ error: { code: 'device_revoked', message: 'Fixture revoked' } }, 403));
  const app = renderApp(<ServerConnectionStatus serverId="A" />); await app.ready();
  await screen.findByText(`${serverA.name.toUpperCase()} · DISPOSITIVO REVOCADO`);
  fireEvent.press(screen.getByText('Emparejar de nuevo'));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/connect', params: { serverId: 'A' } });
});
