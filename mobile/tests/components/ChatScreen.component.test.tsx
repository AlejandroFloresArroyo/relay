import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { ChatScreen } from '@/screens/ChatScreen';
import { agentA, conversationA, health, polling, seed, serverA, serverInfo } from '../support/fixtures';
import { deferred, router, subscriptionCounts } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, networkError, requestsFor, respond, streamCount, streamFixture } from '../support/transport';

const transcriptPath = '/v1/agents/agentA/transcript';
const recovered = { sessionId: 'fixture-conversation', conversation: conversationA, items: [{ kind: 'assistant', id: 'fixture-message', text: 'Conversación recuperada', at: 1791028800000 }] };
function setup() {
  seed(); polling(serverA, [agentA]); respond(serverA.url, '/v1/server', json(serverInfo));
  respond(serverA.url, `${transcriptPath}?sessionId=fixture-conversation`, json(recovered));
}
function mountChat() { return renderApp(<ChatScreen serverId="A" agentId="agentA" />); }
async function poll() { await act(async () => { await jest.advanceTimersByTimeAsync(5000); }); }

test('the same mounted chat recovers on reachability, waits for approvals and does not reload on later healthy polls', async () => {
  setup();
  respond(serverA.url, '/health', networkError); respond(serverA.url, '/v1/agents', networkError);
  respond(serverA.url, transcriptPath, networkError);
  const app = mountChat(); await app.ready();
  await waitFor(() => expect(screen.getByText('SERVIDOR A · SIN RESPUESTA')).toBeVisible());
  expect(app.probe.current!.snapshot('A').reachable).toBe(false);
  const transcripts = requestsFor(serverA.url, transcriptPath).length;
  const approvals = requestsFor(serverA.url, '/v1/approvals').length;
  polling(serverA, [agentA]); respond(serverA.url, transcriptPath, json(recovered));
  // The first approval response belongs to provider polling; hold the chat reconciliation only.
  const approvalResponse = deferred<Response>();
  let approvalReads = 0;
  respond(serverA.url, '/v1/approvals', () => ++approvalReads === 1 ? json({ approvals: [] }) : approvalResponse.promise);
  await poll();
  await waitFor(() => expect(app.probe.current!.snapshot('A').reachable).toBe(true));
  expect(requestsFor(serverA.url, transcriptPath)).toHaveLength(transcripts + 1);
  expect(requestsFor(serverA.url, '/v1/approvals')).toHaveLength(approvals + 2);
  expect(screen.queryByText('Conversación recuperada')).toBeNull();
  expect(screen.getByText('SERVIDOR A · SIN RESPUESTA')).toBeVisible();
  await act(async () => { approvalResponse.resolve(json({ approvals: [] })); });
  expect(screen.getByText('Conversación recuperada')).toBeVisible();
  expect(screen.queryByText('SERVIDOR A · SIN RESPUESTA')).toBeNull();
  polling(serverA, [agentA]);
  await poll();
  expect(requestsFor(serverA.url, transcriptPath)).toHaveLength(transcripts + 1);
  expect(screen.getByText('Conversación recuperada')).toBeVisible();
});

test.each([['key_unknown', 401, 'LLAVE RECHAZADA'], ['rate_limited', 429, 'DEMASIADOS INTENTOS']] as const)('%s suspends transcript on reachability recovery and a real retry resumes it', async (code, status, label) => {
  setup(); respond(serverA.url, '/health', networkError); respond(serverA.url, '/v1/agents', networkError);
  respond(serverA.url, transcriptPath, json({ error: { code, message: 'Fixture denied' } }, status));
  const app = mountChat(); await app.ready();
  await waitFor(() => expect(app.probe.current!.snapshot('A').reachable).toBe(false));
  const count = requestsFor(serverA.url, transcriptPath).length;
  polling(serverA, [agentA]); respond(serverA.url, transcriptPath, json(recovered));
  await poll();
  await waitFor(() => expect(app.probe.current!.snapshot('A').reachable).toBe(true));
  expect(requestsFor(serverA.url, transcriptPath)).toHaveLength(count);
  expect(screen.getByText(new RegExp(label))).toBeVisible();
  expect(screen.queryByText('Conversación recuperada')).toBeNull();
  await act(async () => { fireEvent.press(screen.getByText('Reintentar')); });
  expect(requestsFor(serverA.url, transcriptPath)).toHaveLength(count + 1);
  expect(screen.getByText('Conversación recuperada')).toBeVisible();
  expect(screen.queryByText(new RegExp(label))).toBeNull();
});

test('revocation offers pairing with the chat server identity', async () => {
  setup(); respond(serverA.url, '/health', json(health));
  respond(serverA.url, transcriptPath, json({ error: { code: 'device_revoked', message: 'Fixture revoked' } }, 403));
  const app = mountChat(); await app.ready();
  await waitFor(() => expect(screen.getByText(/DISPOSITIVO REVOCADO/)).toBeVisible());
  fireEvent.press(screen.getByText('Emparejar de nuevo'));
  expect(router.push).toHaveBeenCalledTimes(1);
  expect(router.push).toHaveBeenCalledWith({ pathname: '/connect', params: { serverId: 'A' } });
});


test('unmount aborts an active real chat stream and retires subscriptions and polling', async () => {
  setup(); respond(serverA.url, transcriptPath, json(recovered));
  respond(serverA.url, '/v1/agents/agentA/runs', json({ runId: 'fixture-run', sessionId: 'fixture-conversation' }), 'POST');
  const stream = streamFixture();
  const eventsPath = '/v1/runs/fixture-run/events';
  respond(serverA.url, eventsPath, stream.reply);
  const app = mountChat(); await app.ready();
  await waitFor(() => expect(screen.getByText('Conversación recuperada')).toBeVisible());
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Mensaje de prueba');
  fireEvent.press(screen.getByLabelText('Enviar'));
  await waitFor(() => expect(stream.reader.read).toHaveBeenCalledTimes(1));
  expect(requestsFor(serverA.url, '/v1/agents/agentA/runs')[0].body).toEqual({ input: 'Mensaje de prueba', sessionId: 'fixture-conversation' });
  const request = requestsFor(serverA.url, eventsPath)[0];
  expect(request.signal?.aborted).toBe(false);
  expect(streamCount()).toBe(1);
  await act(async () => { app.unmount(); });
  expect(request.signal?.aborted).toBe(true);
  expect(streamCount()).toBe(0);
  expect(subscriptionCounts()).toEqual({ app: 0, links: 0 });
  await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
  expect(jest.getTimerCount()).toBe(0);
});


test('inactive image and dictation slots keep empty drafts unsent and preserve the exact nonempty payload', async () => {
  setup(); respond(serverA.url, transcriptPath, json(recovered));
  respond(serverA.url, '/v1/agents/agentA/runs', json({ runId: 'fixture-run', sessionId: 'fixture-conversation' }), 'POST');
  const stream = streamFixture();
  respond(serverA.url, '/v1/runs/fixture-run/events', stream.reply);
  const app = mountChat(); await app.ready();
  await waitFor(() => expect(screen.getByText('Conversación recuperada')).toBeVisible());
  const input = screen.getByPlaceholderText('Mensaje a Agente A…');
  fireEvent.press(screen.getByLabelText('Dictar'));
  fireEvent(input, 'submitEditing');
  fireEvent.changeText(input, '   ');
  fireEvent(input, 'submitEditing');
  expect(requestsFor(serverA.url, '/v1/agents/agentA/runs')).toHaveLength(0);
  fireEvent.changeText(input, '  Mensaje de prueba  ');
  fireEvent(input, 'submitEditing');
  await waitFor(() => expect(stream.reader.read).toHaveBeenCalledTimes(1));
  expect(requestsFor(serverA.url, '/v1/agents/agentA/runs')).toHaveLength(1);
  expect(requestsFor(serverA.url, '/v1/agents/agentA/runs')[0].body).toEqual({ input: 'Mensaje de prueba', sessionId: 'fixture-conversation' });
  await act(async () => { app.unmount(); });
  expect(streamCount()).toBe(0);
});
