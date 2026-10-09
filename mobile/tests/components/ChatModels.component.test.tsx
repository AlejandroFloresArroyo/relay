import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { ChatScreen } from '@/screens/ChatScreen';
import { agentA, approval, conversationA, polling, seed, serverA, serverInfo } from '../support/fixtures';
import { clockStart, deferred, navigation, stackOf, tabsRoute } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, requestsFor, respond, streamFixture } from '../support/transport';
const root = '/v1/agents/agentA';
const chosen = { provider: 'openrouter', model: 'chosen-model' };
const actual = { provider: 'fallback', model: 'served-model' };
function setup() {
  seed(); polling(serverA, [agentA]); respond(serverA.url, '/v1/server', json(serverInfo));
  respond(serverA.url, `${root}/chat`, json({ available: true, reason: null }));
  const history = { sessionId: conversationA.sessionId, conversation: conversationA, items: [{ kind: 'assistant', id: 'history', text: 'Historial anterior', at: clockStart }] };
  respond(serverA.url, `${root}/transcript`, json(history));
  respond(serverA.url, `${root}/transcript?sessionId=${conversationA.sessionId}`, json(history));
  respond(serverA.url, `${root}/models`, json({ defaultModel: { provider: agentA.provider, model: agentA.model }, models: [{ ...chosen, label: 'Modelo elegido' }] }));
  respond(serverA.url, `${root}/conversations/${conversationA.id}/model`, (request) => json({ ...conversationA, model: (request.body as { model: unknown }).model }), 'PUT');
}
async function mount() {
  const app = renderApp(<ChatScreen serverId="A" agentId="agentA" />);
  await app.ready(); await screen.findByText('Historial anterior'); return app;
}
test('idle selection saves immediately, preserves history and draft, and reopening shows the selected model', async () => {
  setup(); await mount();
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Borrador pendiente');
  fireEvent.press(screen.getByLabelText('Cambiar modelo de esta conversación'));
  fireEvent.press(await screen.findByRole('radio', { name: 'openrouter · Modelo elegido' }));
  await screen.findByLabelText('Modelo de esta conversación: openrouter / chosen-model');
  expect(requestsFor(serverA.url, `${root}/conversations/${conversationA.id}/model`)[0].body).toEqual({ model: chosen });
  expect(screen.getByText('Historial anterior')).toBeVisible();
  expect(screen.getByPlaceholderText('Mensaje a Agente A…')).toHaveProp('value', 'Borrador pendiente');
  fireEvent.press(screen.getByLabelText('Cambiar modelo de esta conversación'));
  expect(await screen.findByRole('radio', { name: 'openrouter · Modelo elegido', checked: true })).toBeDisabled();
  expect(requestsFor(serverA.url, `${root}/runs`)).toHaveLength(0);
});
test('mid-Turn selection confirms only for next Turn; actual response attribution stays distinct', async () => {
  setup(); const stream = streamFixture();
  respond(serverA.url, `${root}/runs`, json({ runId: 'model-turn', sessionId: conversationA.sessionId, conversationId: conversationA.id, inputMessageId: 'model-input' }), 'POST');
  respond(serverA.url, '/v1/runs/model-turn/events', stream.reply);
  await mount(); fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Consulta'); fireEvent.press(screen.getByLabelText('Enviar'));
  await waitFor(() => expect(stream.reader.read).toHaveBeenCalled());
  fireEvent.press(screen.getByLabelText('Cambiar modelo de esta conversación'));
  fireEvent.press(await screen.findByRole('radio', { name: 'openrouter · Modelo elegido' }));
  expect(requestsFor(serverA.url, `${root}/conversations/${conversationA.id}/model`)).toHaveLength(0);
  fireEvent.press(screen.getByText('Cancelar cambio'));
  expect(requestsFor(serverA.url, `${root}/conversations/${conversationA.id}/model`)).toHaveLength(0);
  fireEvent.press(screen.getByRole('radio', { name: 'openrouter · Modelo elegido' })); fireEvent.press(screen.getByText('Cambiar modelo'));
  await screen.findByLabelText('Modelo del siguiente Turno: openrouter / chosen-model');
  expect(requestsFor(serverA.url, `${root}/runs`)).toHaveLength(1);
  expect(requestsFor(serverA.url, '/v1/runs/model-turn/stop')).toHaveLength(0);
  await act(async () => { stream.emit(`id: 0\ndata: ${JSON.stringify({ type: 'run.completed', output: 'Respuesta real', runtime: actual })}\n\n`); });
  await screen.findByText('RESPONDIÓ · fallback / served-model');
  expect(screen.getByLabelText('Modelo de esta conversación: openrouter / chosen-model')).toBeVisible();
  expect(screen.queryByText('RESPONDIÓ · openrouter / chosen-model')).toBeNull();
});

test('a history read started before model save cannot overwrite the acknowledged model', async () => {
  setup(); const app = await mount();
  fireEvent.press(screen.getByLabelText('Cambiar modelo de esta conversación'));
  await screen.findByRole('radio', { name: 'openrouter · Modelo elegido' });
  const pending = deferred<Response>();
  respond(serverA.url, `${root}/transcript?sessionId=${conversationA.sessionId}`, pending.promise);
  respond(serverA.url, '/v1/approvals', json({ approvals: [approval().approval] }));
  await act(async () => { await app.probe.current!.refresh('A'); });
  await waitFor(() => expect(requestsFor(serverA.url, `${root}/transcript?sessionId=${conversationA.sessionId}`)).toHaveLength(1));
  fireEvent.press(screen.getByRole('radio', { name: 'openrouter · Modelo elegido' }));
  await screen.findByLabelText('Modelo de esta conversación: openrouter / chosen-model');
  await act(async () => { pending.resolve(json({ sessionId: conversationA.sessionId, conversation: conversationA, items: [{ kind: 'assistant', id: 'refreshed', text: 'Historial actualizado', at: clockStart }] })); });
  await screen.findByText('Historial actualizado');
  expect(screen.getByLabelText('Modelo de esta conversación: openrouter / chosen-model')).toBeVisible();
});

test('the model sheet hides background navigation and restores it on dismissal', async () => {
  setup(); navigation.state = stackOf(tabsRoute('agents'), { name: 'chat/[server]/[agent]', key: 'chat', params: { server: 'A', agent: 'agentA' } }); await mount();
  expect(screen.getByLabelText('Volver a Agentes')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Cambiar modelo de esta conversación'));
  await screen.findByRole('radio', { name: 'openrouter · Modelo elegido' });
  const back = screen.getByLabelText('Volver a Agentes', { includeHiddenElements: true });
  let ancestor = back.parent;
  while (ancestor && ancestor.props.importantForAccessibility !== 'no-hide-descendants') ancestor = ancestor.parent;
  expect(ancestor).not.toBeNull();
  expect(screen.queryByLabelText('Volver a Agentes')).toBeNull();
  expect(screen.queryByLabelText('Cambiar modelo de esta conversación')).toBeNull();
  expect(screen.queryByText('Historial anterior')).toBeNull();
  fireEvent.press(screen.getByText('Cancelar'));
  expect(screen.getByLabelText('Volver a Agentes')).toBeVisible();
  expect(screen.getByLabelText('Cambiar modelo de esta conversación')).toBeVisible();
  expect(screen.getByText('Historial anterior')).toBeVisible();
});
