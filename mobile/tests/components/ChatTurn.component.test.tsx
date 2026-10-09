import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { ChatRunEvent, RunSnapshot, SteerRequest } from '../../../protocol/protocol';
import { ChatScreen } from '@/screens/ChatScreen';
import { agentA, conversationA, polling, seed, serverA, serverB, serverInfo } from '../support/fixtures';
import { clockStart, deferred } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, networkError, requestsFor, respond, streamFixture } from '../support/transport';

const root = '/v1/agents/agentA';
const runPath = '/v1/runs/turn-fixture';
const firstInput = 'Revisa la integración';
const history = { sessionId: conversationA.sessionId, conversation: conversationA, items: [{ kind: 'assistant', id: 'history', text: 'Historial anterior', at: clockStart }] };
const composer = () => screen.getByPlaceholderText(/^(Mensaje a Agente A|Redirigir sin detener)/);

function setup() {
  seed(); polling(serverA, [agentA]);
  respond(serverA.url, '/v1/server', json(serverInfo));
  respond(serverA.url, `${root}/chat`, json({ available: true, reason: null }));
  respond(serverA.url, `${root}/transcript`, json(history));
  respond(serverA.url, `${root}/transcript?sessionId=${conversationA.sessionId}`, json(history));
  respond(serverA.url, `${root}/runs`, json({ runId: 'turn-fixture', sessionId: conversationA.sessionId, conversationId: conversationA.id, inputMessageId: 'wire-input' }), 'POST');
}
async function mount() {
  const app = renderApp(<ChatScreen serverId="A" agentId="agentA" />);
  await app.ready(); await screen.findByText('Historial anterior');
  return app;
}
async function start() {
  setup();
  const stream = streamFixture(); respond(serverA.url, `${runPath}/events`, stream.reply);
  const app = await mount();
  fireEvent.changeText(composer(), firstInput); fireEvent.press(screen.getByLabelText('Enviar'));
  await waitFor(() => expect(stream.reader.read).toHaveBeenCalled());
  return { app, stream };
}
async function emit(stream: { emit(text: string): void }, event: ChatRunEvent, sequence = 1) {
  await act(async () => { stream.emit(`id: ${sequence}\ndata: ${JSON.stringify(event)}\n\n`); });
}
function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: 'turn-fixture', conversationId: conversationA.id, sessionId: conversationA.sessionId,
    phase: 'running', connection: 'connected', lastEventId: 7, complete: true, steers: [], terminal: null,
    items: [
      { kind: 'user', id: 'wire-input', text: firstInput, at: clockStart },
      { kind: 'assistant', id: 'turn-fixture:message:1', text: 'Respuesta parcial', at: clockStart },
    ],
    ...overrides,
  };
}

test('busy typing redirects to the accepted Turn without stopping or sending a new Turn; HTTP and SSE acknowledge only once', async () => {
  const { stream } = await start();
  const reply = deferred<Response>(); respond(serverA.url, `${runPath}/steer`, reply.promise, 'POST');
  expect(screen.getByLabelText('Detener')).toBeEnabled();
  fireEvent.changeText(composer(), 'Solo integración');
  fireEvent(composer(), 'submitEditing');
  await waitFor(() => expect(requestsFor(serverA.url, `${runPath}/steer`)).toHaveLength(1));
  const request = requestsFor(serverA.url, `${runPath}/steer`)[0].body as SteerRequest;
  expect(request).toEqual({ requestId: expect.any(String), input: 'Solo integración' });
  expect(composer()).toHaveProp('value', 'Solo integración');
  expect(screen.queryByText(/REDIRIGIDO/)).toBeNull();
  fireEvent.changeText(composer(), 'No toques migrations/');
  await emit(stream, { type: 'run.steered', requestId: request.requestId, accepted: true });
  await act(async () => { reply.resolve(json({ runId: 'turn-fixture', requestId: request.requestId, accepted: true })); });
  expect(composer()).toHaveProp('value', 'No toques migrations/');
  expect(screen.getAllByText('Solo integración')).toHaveLength(1);
  expect(screen.getAllByText(/REDIRIGIDO/)).toHaveLength(1);
  expect(screen.getByLabelText('Detener')).toBeEnabled();
  expect(requestsFor(serverA.url, `${root}/runs`)).toHaveLength(1);
  expect(requestsFor(serverA.url, `${runPath}/stop`)).toHaveLength(0);
});

test.each(['run_not_accepting_steer', 'steer_not_accepted'])('%s leaves rejected instructions in the compositor, unmarked and unsent', async (code) => {
  await start();
  respond(serverA.url, `${runPath}/steer`, json({ error: { code, message: 'La instrucción no se entregó.' } }, 409), 'POST');
  fireEvent.changeText(composer(), 'Conserva esta instrucción'); fireEvent.press(screen.getByLabelText('Redirigir'));
  await screen.findByText('La instrucción no se entregó.');
  expect(composer()).toHaveProp('value', 'Conserva esta instrucción');
  expect(screen.queryByText(/REDIRIGIDO/)).toBeNull();
  expect(requestsFor(serverA.url, `${root}/runs`)).toHaveLength(1);
  expect(requestsFor(serverA.url, `${runPath}/stop`)).toHaveLength(0);
});

test('a definite steer rejection restores its text alongside edits made while awaiting the receipt', async () => {
  const { stream } = await start();
  let restored = '';
  for (const [attempt, newer] of ['Borrador posterior', 'Nueva edición posterior'].entries()) {
    const reply = deferred<Response>(); respond(serverA.url, `${runPath}/steer`, reply.promise, 'POST');
    fireEvent.changeText(composer(), 'Instrucción rechazada'); fireEvent.press(screen.getByLabelText('Redirigir'));
    await waitFor(() => expect(requestsFor(serverA.url, `${runPath}/steer`)).toHaveLength(attempt + 1));
    fireEvent.changeText(composer(), newer);
    await act(async () => { reply.resolve(json({ error: { code: 'steer_not_accepted', message: 'La instrucción no se entregó.' } }, 409)); });
    await screen.findByText('La instrucción no se entregó.');
    restored = composer().props.value as string;
    expect(restored).toContain('Instrucción rechazada');
    expect(restored).toContain(newer);
    expect(screen.queryByText(/REDIRIGIDO/)).toBeNull();
  }
  await emit(stream, { type: 'run.cancelled' });
  expect(composer()).toHaveProp('value', restored);
  expect(requestsFor(serverA.url, `${root}/runs`)).toHaveLength(1);
  expect(requestsFor(serverA.url, `${runPath}/steer`)).toHaveLength(2);
});

test('an uncertain steer retries its original receipt and input, preserving newer edits until confirmed', async () => {
  await start(); respond(serverA.url, `${runPath}/steer`, networkError, 'POST');
  fireEvent.changeText(composer(), 'Instrucción incierta'); fireEvent.press(screen.getByLabelText('Redirigir'));
  await waitFor(() => expect(requestsFor(serverA.url, `${runPath}/steer`)).toHaveLength(1));
  await waitFor(() => expect(screen.getByLabelText('Redirigir')).toBeEnabled());
  expect(composer()).toHaveProp('value', 'Instrucción incierta');
  expect(screen.queryByText(/REDIRIGIDO/)).toBeNull();
  fireEvent.changeText(composer(), 'Borrador más reciente');
  respond(serverA.url, `${runPath}/steer`, (request) => json({ runId: 'turn-fixture', requestId: (request.body as SteerRequest).requestId, accepted: true }), 'POST');
  fireEvent.press(screen.getByLabelText('Redirigir'));
  await screen.findByText(/REDIRIGIDO/);
  const requests = requestsFor(serverA.url, `${runPath}/steer`);
  expect(requests).toHaveLength(2); expect(requests[1].body).toEqual(requests[0].body);
  expect(composer()).toHaveProp('value', 'Borrador más reciente');
  expect(screen.getAllByText('Instrucción incierta')).toHaveLength(1);
});

test('terminal pendingSteer returns undelivered text alongside a newer draft and never automatically resends it', async () => {
  const { stream } = await start();
  respond(serverA.url, `${runPath}/steer`, (request) => json({ runId: 'turn-fixture', requestId: (request.body as SteerRequest).requestId, accepted: true }), 'POST');
  fireEvent.changeText(composer(), 'No entregada'); fireEvent.press(screen.getByLabelText('Redirigir'));
  await screen.findByText(/REDIRIGIDO/);
  fireEvent.changeText(composer(), 'Pregunta más reciente');
  await emit(stream, { type: 'run.completed', output: 'Terminé', pendingSteer: 'No entregada' }, 2);
  const draft = screen.getByPlaceholderText('Mensaje a Agente A…').props.value as string;
  expect(draft).toContain('No entregada'); expect(draft).toContain('Pregunta más reciente');
  expect(draft.split('No entregada')).toHaveLength(2);
  expect(requestsFor(serverA.url, `${root}/runs`)).toHaveLength(1);
  expect(requestsFor(serverA.url, `${runPath}/steer`)).toHaveLength(1);
  expect(screen.queryByLabelText('Detener')).toBeNull();
});

test('stop targets the current run, preserves draft on rejection, and remains disabled after HTTP success until terminal evidence', async () => {
  const { stream } = await start();
  fireEvent.changeText(composer(), 'Borrador intacto');
  respond(serverA.url, `${runPath}/stop`, json({ error: { code: 'upstream_failure', message: 'No se confirmó la detención.' } }, 502), 'POST');
  fireEvent.press(screen.getByLabelText('Detener')); await screen.findByText('No se confirmó la detención.');
  expect(composer()).toHaveProp('value', 'Borrador intacto');
  expect(screen.getByLabelText('Detener')).toBeEnabled();
  respond(serverA.url, `${runPath}/stop`, json({ stopped: true }), 'POST');
  fireEvent.press(screen.getByLabelText('Detener'));
  await waitFor(() => expect(requestsFor(serverA.url, `${runPath}/stop`)).toHaveLength(2));
  expect(screen.getByLabelText('Detener')).toBeDisabled();
  fireEvent(composer(), 'submitEditing');
  expect(requestsFor(serverA.url, `${root}/runs`)).toHaveLength(1);
  await emit(stream, { type: 'run.cancelled' });
  expect(screen.getByPlaceholderText('Mensaje a Agente A…')).toHaveProp('value', 'Borrador intacto');
  expect(screen.getByLabelText('Enviar')).toBeEnabled();
});

test('lost response keeps history and current run; retry resumes from snapshot cursor without replay, new input or transcript replacement', async () => {
  const { stream } = await start();
  await emit(stream, { type: 'message.delta', text: 'Respuesta parcial' });
  fireEvent.changeText(composer(), 'No perder este borrador');
  const resumed = streamFixture();
  respond(serverA.url, runPath, json(snapshot({ connection: 'lost' })));
  respond(serverA.url, `${runPath}/reconnect`, json(snapshot()), 'POST');
  respond(serverA.url, `${runPath}/events`, resumed.reply);
  const historyReads = requestsFor(serverA.url, `${root}/transcript`).length;
  await act(async () => { stream.fail(); });
  expect(screen.getByText('Respuesta parcial')).toBeVisible();
  expect(screen.getByText('Historial anterior')).toBeVisible();
  expect(screen.getByText(/CONEXIÓN PERDIDA CON SERVIDOR A/)).toBeVisible();
  expect(screen.getByDisplayValue('No perder este borrador')).toHaveProp('editable', false);
  fireEvent(screen.getByDisplayValue('No perder este borrador'), 'submitEditing');
  fireEvent.press(screen.getByText('Reintentar'));
  await waitFor(() => expect(resumed.reader.read).toHaveBeenCalled());
  expect(requestsFor(serverA.url, runPath)).toHaveLength(1);
  expect(requestsFor(serverA.url, `${runPath}/reconnect`)).toHaveLength(1);
  const subscriptions = requestsFor(serverA.url, `${runPath}/events`);
  expect(subscriptions).toHaveLength(2); expect(subscriptions[1].headers.get('Last-Event-ID')).toBe('7');
  expect(screen.getAllByText(firstInput)).toHaveLength(1);
  expect(screen.getByText('Historial anterior')).toBeVisible();
  expect(composer()).toHaveProp('value', 'No perder este borrador');
  await emit(resumed, { type: 'message.delta', text: 'Respuesta parcial' }, 7);
  await emit(resumed, { type: 'message.delta', text: ' y recuperada' }, 8);
  await emit(resumed, { type: 'message.delta', text: ' y recuperada' }, 8);
  expect(screen.getByText('Respuesta parcial y recuperada')).toBeVisible();
  expect(requestsFor(serverA.url, `${root}/runs`)).toHaveLength(1);
  expect(requestsFor(serverA.url, `${root}/transcript`)).toHaveLength(historyReads);
});

test('a recovered Turno snapshot reads its running step on the phone clock: a Puente 30 s behind still reads 17 s', async () => {
  const skew = 30_000;
  setup(); respond(serverA.url, '/v1/approvals', json({ approvals: [], serverNow: Date.now() - skew }));
  const stream = streamFixture(); respond(serverA.url, `${runPath}/events`, stream.reply);
  await mount();
  fireEvent.changeText(composer(), firstInput); fireEvent.press(screen.getByLabelText('Enviar'));
  await waitFor(() => expect(stream.reader.read).toHaveBeenCalled());
  const recovered = snapshot({ items: [
    { kind: 'user', id: 'wire-input', text: firstInput, at: Date.now() - skew - 20_000 },
    { kind: 'tool', id: 'turn-fixture:tool:1', tool: 'terminal', preview: 'npm test', status: 'running', durationSeconds: null, result: null, at: Date.now() - skew - 17_000 },
  ] });
  respond(serverA.url, runPath, json({ ...recovered, connection: 'lost' }));
  respond(serverA.url, `${runPath}/reconnect`, json(recovered), 'POST');
  respond(serverA.url, `${runPath}/events`, streamFixture().reply);
  await act(async () => { stream.fail(); });
  fireEvent.press(screen.getByText('Reintentar'));
  await waitFor(() => expect(requestsFor(serverA.url, `${runPath}/reconnect`)).toHaveLength(1));
  await waitFor(() => expect(screen.getByTestId('aguja-carga').props.accessibilityLabel).toMatch(/^Carga: 1[78] s$/));
});

test('chat capability is per Agent even when the Server advertises chat, and blocks sends while preserving readable history', async () => {
  setup(); respond(serverA.url, `${root}/chat`, json({ available: false, reason: 'Este Agente tiene el chat apagado.' }));
  await mount();
  expect(screen.getByText(/CHAT NO DISPONIBLE/)).toBeVisible();
  expect(screen.getByText('Este Agente tiene el chat apagado.')).toBeVisible();
  expect(screen.getByText('Historial anterior')).toBeVisible();
  expect(screen.getByPlaceholderText(/Chat desactivado/)).toHaveProp('editable', false);
  fireEvent(screen.getByPlaceholderText(/Chat desactivado/), 'submitEditing');
  expect(requestsFor(serverA.url, `${root}/chat`)).toHaveLength(1);
  expect(requestsFor(serverA.url, `${root}/runs`)).toHaveLength(0);
});

test('loading and load error cannot send; explicit retry reveals an empty writable Conversation', async () => {
  setup(); const pending = deferred<Response>(); respond(serverA.url, `${root}/transcript`, pending.promise);
  const app = renderApp(<ChatScreen serverId="A" agentId="agentA" />); await app.ready();
  expect(screen.getAllByText(/CARGANDO CONVERSACIÓN/).length).toBeGreaterThan(0);
  expect(composer()).toHaveProp('editable', false);
  await act(async () => { pending.resolve(json({ error: { code: 'upstream_failure', message: 'Hermes no pudo leer los mensajes.' } }, 502)); });
  await screen.findByText('NO SE PUDO CARGAR LA CONVERSACIÓN');
  expect(composer()).toHaveProp('editable', false);
  respond(serverA.url, `${root}/transcript`, json({ ...history, items: [] }));
  fireEvent.press(screen.getByText('Reintentar'));
  await screen.findByText('CONVERSACIÓN NUEVA');
  expect(composer()).toHaveProp('editable', true);
  expect(requestsFor(serverA.url, `${root}/runs`)).toHaveLength(0);
});

test('Server replacement aborts the old Turn and a late steering acknowledgement cannot mark or clear the new Conversation', async () => {
  const { app } = await start();
  const pending = deferred<Response>(); respond(serverA.url, `${runPath}/steer`, pending.promise, 'POST');
  fireEvent.changeText(composer(), 'Instrucción del Servidor anterior'); fireEvent.press(screen.getByLabelText('Redirigir'));
  await waitFor(() => expect(requestsFor(serverA.url, `${runPath}/steer`)).toHaveLength(1));
  const request = requestsFor(serverA.url, `${runPath}/steer`)[0].body as SteerRequest;
  polling(serverB, [agentA]); respond(serverB.url, '/v1/server', json(serverInfo));
  respond(serverB.url, `${root}/chat`, json({ available: true, reason: null }));
  const replacement = { ...conversationA, id: 'replacement', sessionId: 'replacement' };
  respond(serverB.url, `${root}/transcript`, json({ sessionId: replacement.sessionId, conversation: replacement, items: [{ kind: 'assistant', id: 'new-history', text: 'Conversación del nuevo Servidor', at: clockStart }] }));
  await act(async () => { await app.probe.current!.replaceServer('A', serverB); });
  await screen.findByText('Conversación del nuevo Servidor');
  fireEvent.changeText(composer(), 'Borrador del nuevo Servidor');
  await act(async () => { pending.resolve(json({ runId: 'turn-fixture', requestId: request.requestId, accepted: true })); });
  expect(requestsFor(serverA.url, `${runPath}/events`)[0].signal?.aborted).toBe(true);
  expect(composer()).toHaveProp('value', 'Borrador del nuevo Servidor');
  expect(screen.queryByText(/REDIRIGIDO/)).toBeNull();
  expect(screen.queryByText('Instrucción del Servidor anterior')).toBeNull();
  expect(screen.getByText('Conversación del nuevo Servidor')).toBeVisible();
});

test('incomplete recovery retains partial response and tool evidence, shows the cut and repairs only authoritative terminal text', async () => {
  const { stream } = await start();
  await emit(stream, { type: 'message.delta', text: 'Respuesta parcial más larga' }, 1);
  await emit(stream, { type: 'tool.started', toolCallId: 'wire-tool', tool: 'terminal', preview: 'npm test' }, 2);
  await emit(stream, { type: 'tool.completed', toolCallId: 'wire-tool', tool: 'terminal', preview: '{"output":"FAIL integración","exit_code":1}', durationSeconds: 1, error: true }, 3);
  fireEvent.changeText(composer(), 'Borrador conservado');
  const resumed = streamFixture();
  const incomplete = snapshot({ complete: false, connection: 'lost', items: [
    { kind: 'user', id: 'wire-input', text: firstInput, at: clockStart },
    { kind: 'assistant', id: 'turn-fixture:message:1', text: 'Respuesta parcial', at: clockStart },
  ] });
  respond(serverA.url, runPath, json(incomplete));
  respond(serverA.url, `${runPath}/reconnect`, json({ ...incomplete, connection: 'connected' }), 'POST');
  respond(serverA.url, `${runPath}/events`, resumed.reply);
  await act(async () => { stream.fail(); });
  fireEvent.press(screen.getByText('Reintentar'));
  await waitFor(() => expect(resumed.reader.read).toHaveBeenCalled());
  expect(screen.getByText('Respuesta parcial más larga')).toBeVisible();
  expect(screen.getByText(/FAIL integración/)).toBeVisible();
  expect(screen.getByText(/La respuesta tiene un corte/)).toBeVisible();
  expect(screen.getByText('Historial anterior')).toBeVisible();
  expect(composer()).toHaveProp('value', 'Borrador conservado');
  await emit(resumed, { type: 'run.completed', output: 'Respuesta final autoritativa' }, 8);
  expect(screen.getByText('Respuesta final autoritativa')).toBeVisible();
  expect(screen.getByText(/FAIL integración/)).toBeVisible();
  expect(screen.getByText(/La respuesta tiene un corte/)).toBeVisible();
  expect(screen.getByLabelText('Enviar')).toBeEnabled();
  expect(requestsFor(serverA.url, `${root}/runs`)).toHaveLength(1);
});

test('terminal before the steering HTTP receipt restores uncertain input, keeps newer edits and ignores a late success', async () => {
  const { stream } = await start();
  const pending = deferred<Response>(); respond(serverA.url, `${runPath}/steer`, pending.promise, 'POST');
  fireEvent.changeText(composer(), 'Instrucción pendiente'); fireEvent.press(screen.getByLabelText('Redirigir'));
  await waitFor(() => expect(requestsFor(serverA.url, `${runPath}/steer`)).toHaveLength(1));
  const request = requestsFor(serverA.url, `${runPath}/steer`)[0].body as SteerRequest;
  fireEvent.changeText(composer(), 'Edición más nueva');
  await emit(stream, { type: 'run.completed', output: 'Terminé', pendingSteer: 'Instrucción pendiente' });
  const retained = composer().props.value as string;
  expect(retained).toContain('Instrucción pendiente'); expect(retained).toContain('Edición más nueva');
  expect(retained.split('Instrucción pendiente')).toHaveLength(2);
  await act(async () => { pending.resolve(json({ runId: 'turn-fixture', requestId: request.requestId, accepted: true })); });
  expect(composer()).toHaveProp('value', retained);
  expect(screen.queryByText(/REDIRIGIDO/)).toBeNull();
  expect(requestsFor(serverA.url, `${root}/runs`)).toHaveLength(1);
});

test('initial input is retained until run acceptance, while edits made during the request remain a separate draft', async () => {
  setup(); const pending = deferred<Response>(); respond(serverA.url, `${root}/runs`, pending.promise, 'POST');
  const stream = streamFixture(); respond(serverA.url, `${runPath}/events`, stream.reply);
  await mount();
  fireEvent.changeText(composer(), 'Primer mensaje'); fireEvent.press(screen.getByLabelText('Enviar'));
  await waitFor(() => expect(requestsFor(serverA.url, `${root}/runs`)).toHaveLength(1));
  expect(composer()).toHaveProp('value', 'Primer mensaje');
  expect(screen.queryByText('Primer mensaje')).toBeNull();
  expect(screen.getByLabelText('Detener')).toBeDisabled();
  fireEvent.changeText(composer(), 'La siguiente instrucción');
  await act(async () => { pending.resolve(json({ runId: 'turn-fixture', sessionId: conversationA.sessionId, inputMessageId: 'wire-input' })); });
  await waitFor(() => expect(stream.reader.read).toHaveBeenCalled());
  expect(composer()).toHaveProp('value', 'La siguiente instrucción');
  expect(screen.getAllByText('Primer mensaje')).toHaveLength(1);
  expect(screen.getByLabelText('Redirigir')).toBeEnabled();
});

test('a lost steering receipt is reconciled from the same Turn snapshot without clearing newer input or duplicating delivery', async () => {
  const { stream } = await start();
  respond(serverA.url, `${runPath}/steer`, networkError, 'POST');
  fireEvent.changeText(composer(), 'Recibo perdido'); fireEvent.press(screen.getByLabelText('Redirigir'));
  await waitFor(() => expect(screen.getByLabelText('Redirigir')).toBeEnabled());
  const request = requestsFor(serverA.url, `${runPath}/steer`)[0].body as SteerRequest;
  fireEvent.changeText(composer(), 'Edición conservada');
  const reconciled = snapshot({ steers: [{ requestId: request.requestId, status: 'accepted' }], items: [
    { kind: 'user', id: 'wire-input', text: firstInput, at: clockStart },
    { kind: 'user', id: 'wire-steer', clientMessageId: request.requestId, redirected: true, text: request.input, at: clockStart },
  ] });
  const resumed = streamFixture(); respond(serverA.url, `${runPath}/events`, resumed.reply);
  respond(serverA.url, runPath, json({ ...reconciled, connection: 'lost' }));
  respond(serverA.url, `${runPath}/reconnect`, json(reconciled), 'POST');
  await act(async () => { stream.fail(); });
  fireEvent.press(screen.getByText('Reintentar'));
  await waitFor(() => expect(resumed.reader.read).toHaveBeenCalled());
  await emit(resumed, { type: 'run.steered', requestId: request.requestId, accepted: true }, 8);
  expect(composer()).toHaveProp('value', 'Edición conservada');
  expect(screen.getAllByText('Recibo perdido')).toHaveLength(1);
  expect(screen.getAllByText(/REDIRIGIDO/)).toHaveLength(1);
  expect(requestsFor(serverA.url, `${runPath}/steer`)).toHaveLength(1);
  expect(requestsFor(serverA.url, `${root}/runs`)).toHaveLength(1);
});

test('loss before the first event resumes an empty snapshot and receives event zero without resending input', async () => {
  const { stream } = await start();
  const empty = snapshot({ lastEventId: -1, items: [{ kind: 'user', id: 'wire-input', text: firstInput, at: clockStart }] });
  const resumed = streamFixture();
  respond(serverA.url, runPath, json({ ...empty, connection: 'lost' }));
  respond(serverA.url, `${runPath}/reconnect`, json(empty), 'POST');
  respond(serverA.url, `${runPath}/events`, resumed.reply);
  await act(async () => { stream.fail(); });
  fireEvent.press(screen.getByText('Reintentar'));
  await waitFor(() => expect(resumed.reader.read).toHaveBeenCalled());
  await emit(resumed, { type: 'message.delta', text: 'Primer texto' }, 0);
  expect(screen.getByText('Primer texto')).toBeVisible();
  expect(screen.getByText('Historial anterior')).toBeVisible();
  expect(screen.getAllByText(firstInput)).toHaveLength(1);
  expect(requestsFor(serverA.url, `${root}/runs`)).toHaveLength(1);
});

test('automatic recovery countdown advances from the clock and retries once, without creating a Turn', async () => {
  const { stream } = await start();
  const resumed = streamFixture(); respond(serverA.url, `${runPath}/events`, resumed.reply);
  respond(serverA.url, runPath, json(snapshot({ connection: 'lost' })));
  respond(serverA.url, `${runPath}/reconnect`, json(snapshot()), 'POST');
  await act(async () => { stream.fail(); });
  expect(screen.getByText('REINTENTO AUTOMÁTICO EN 5 S')).toBeVisible();
  await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
  expect(screen.getByText('REINTENTO AUTOMÁTICO EN 4 S')).toBeVisible();
  await act(async () => { await jest.advanceTimersByTimeAsync(4000); });
  await waitFor(() => expect(resumed.reader.read).toHaveBeenCalled());
  expect(requestsFor(serverA.url, runPath)).toHaveLength(1);
  expect(requestsFor(serverA.url, `${runPath}/reconnect`)).toHaveLength(1);
  expect(requestsFor(serverA.url, `${root}/runs`)).toHaveLength(1);
});

test('unmount while recovering retires countdown and ignores a late snapshot instead of subscribing again', async () => {
  const { app, stream } = await start();
  const pending = deferred<Response>(); respond(serverA.url, runPath, pending.promise);
  await act(async () => { stream.fail(); });
  fireEvent.press(screen.getByText('Reintentar'));
  await waitFor(() => expect(requestsFor(serverA.url, runPath)).toHaveLength(1));
  await act(async () => { app.unmount(); pending.resolve(json(snapshot())); });
  await act(async () => { await jest.advanceTimersByTimeAsync(6000); });
  expect(requestsFor(serverA.url, `${runPath}/reconnect`)).toHaveLength(0);
  expect(requestsFor(serverA.url, `${runPath}/events`)).toHaveLength(1);
});
