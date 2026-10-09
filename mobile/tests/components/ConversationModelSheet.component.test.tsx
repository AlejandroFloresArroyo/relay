import { useState } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { Conversation, ModelOptions } from '../../../protocol/protocol';
import { ConversationModelSheet } from '@/screens/chat/ConversationModelSheet';
import { useApp } from '@/state/app';
import { T } from '@/ui/primitives';
import { Keycap } from '@/ui/kit';
import { conversationA, polling, seed, serverA, serverB } from '../support/fixtures';
import { biometrics, deferred } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, requestsFor, respond } from '../support/transport';

const modelsPath = '/v1/agents/agentA/models';
const modelPath = `/v1/agents/agentA/conversations/${conversationA.id}/model`;
const options: ModelOptions = {
  defaultModel: { provider: 'openrouter', model: 'qwen3-coder-480b' },
  models: [
    { provider: 'openrouter', model: 'qwen3-coder-480b', label: 'qwen3-coder-480b' },
    { provider: 'openrouter', model: 'claude-sonnet-4.5', label: 'claude-sonnet-4.5' },
    { provider: 'ollama', model: 'llama-3.3-70b', label: 'llama-3.3-70b' },
  ],
};

function Harness({ initial = conversationA, busy = false }: { initial?: Conversation; busy?: boolean }) {
  const { ready, clientFor } = useApp();
  const [conversation, setConversation] = useState(initial);
  const [open, setOpen] = useState(true);
  const [serverId, setServerId] = useState('A');
  return <>
    <T>{conversation.model ? `${conversation.model.provider}/${conversation.model.model}` : 'Predeterminado del Agente'}</T>
    <Keycap label="Otra Conversación" onPress={() => setConversation({ ...conversationA, id: 'another-conversation', sessionId: 'another-conversation' })} />
    <Keycap label="Otro Servidor" onPress={() => setServerId('B')} />
    {ready && open ? <ConversationModelSheet client={clientFor(serverId)} contextKey={serverId} agentId="agentA" conversation={conversation} busy={busy}
      onApplied={(updated) => { setConversation(updated); setOpen(false); }} onClose={() => setOpen(false)} /> : null}
  </>;
}

async function mount(initial = conversationA, busy = false) {
  seed(); polling(serverA);
  respond(serverA.url, modelsPath, json(options));
  const app = renderApp(<Harness initial={initial} busy={busy} />);
  await app.ready();
  await screen.findByRole('radio', { name: 'openrouter · qwen3-coder-480b' });
  return app;
}

test('groups the available models, marks the effective model and tapping another model immediately saves only this Conversation', async () => {
  await mount();
  expect(screen.getByText('OPENROUTER')).toBeVisible();
  expect(screen.getByText('LOCAL · OLLAMA')).toBeVisible();
  expect(screen.getByRole('radio', { name: 'openrouter · qwen3-coder-480b' })).toBeChecked();
  expect(screen.queryByText('Aplicar')).toBeNull();
  const updated = { ...conversationA, model: { provider: 'openrouter', model: 'claude-sonnet-4.5' } };
  respond(serverA.url, modelPath, json(updated), 'PUT');
  await act(async () => { fireEvent.press(screen.getByRole('radio', { name: 'openrouter · claude-sonnet-4.5' })); });
  expect(requestsFor(serverA.url, modelPath)).toEqual([expect.objectContaining({ method: 'PUT', body: { model: { provider: 'openrouter', model: 'claude-sonnet-4.5' } } })]);
  await waitFor(() => expect(screen.queryByText('MODELO DE ESTA CONVERSACIÓN')).toBeNull());
  expect(screen.getByText('openrouter/claude-sonnet-4.5')).toBeVisible();
  expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
});

test('a running Turn requests confirmation, cancelling sends nothing and confirming changes only the next Turn without huella', async () => {
  await mount(conversationA, true);
  const model = { provider: 'ollama', model: 'llama-3.3-70b' };
  respond(serverA.url, modelPath, json({ ...conversationA, model }), 'PUT');
  fireEvent.press(screen.getByRole('radio', { name: 'ollama · llama-3.3-70b' }));
  expect(screen.getByText('Este Turno sigue con su modelo actual. El cambio se usará en el siguiente Turno.')).toBeVisible();
  expect(requestsFor(serverA.url, modelPath)).toHaveLength(0);
  fireEvent.press(screen.getByText('Cancelar cambio'));
  expect(screen.queryByText('Cambiar modelo')).toBeNull();
  expect(requestsFor(serverA.url, modelPath)).toHaveLength(0);
  fireEvent.press(screen.getByRole('radio', { name: 'ollama · llama-3.3-70b' }));
  await act(async () => { fireEvent.press(screen.getByText('Cambiar modelo')); });
  await screen.findByText('ollama/llama-3.3-70b');
  expect(requestsFor(serverA.url, modelPath)).toEqual([expect.objectContaining({ method: 'PUT', body: { model } })]);
  expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
});

test('while saving, repeated taps and dismiss cannot send duplicate changes', async () => {
  await mount();
  const pending = deferred<Response>();
  respond(serverA.url, modelPath, pending.promise, 'PUT');
  const radio = screen.getByRole('radio', { name: 'openrouter · claude-sonnet-4.5' });
  fireEvent.press(radio); fireEvent.press(radio);
  await screen.findByText('CAMBIANDO MODELO…');
  expect(radio).toBeDisabled();
  expect(screen.getByText('Cancelar')).toBeDisabled();
  fireEvent.press(screen.getByLabelText('Cerrar modelos'));
  expect(screen.getByText('MODELO DE ESTA CONVERSACIÓN')).toBeVisible();
  expect(requestsFor(serverA.url, modelPath)).toHaveLength(1);
  await act(async () => { pending.resolve(json({ ...conversationA, model: { provider: 'openrouter', model: 'claude-sonnet-4.5' } })); });
  await screen.findByText('openrouter/claude-sonnet-4.5');
});

test.each(['conversation', 'server'] as const)('an old save cannot close or change the newly selected %s', async (context) => {
  seed([serverA, serverB]); polling(serverA); polling(serverB);
  respond(serverA.url, modelsPath, json(options)); respond(serverB.url, modelsPath, json(options));
  const pending = deferred<Response>(); respond(serverA.url, modelPath, pending.promise, 'PUT');
  const app = renderApp(<Harness />); await app.ready();
  await screen.findByRole('radio', { name: 'openrouter · claude-sonnet-4.5' });
  fireEvent.press(screen.getByRole('radio', { name: 'openrouter · claude-sonnet-4.5' }));
  await screen.findByText('CAMBIANDO MODELO…');
  fireEvent.press(screen.getByText(context === 'server' ? 'Otro Servidor' : 'Otra Conversación'));
  await screen.findByRole('radio', { name: 'openrouter · qwen3-coder-480b' });
  expect(screen.queryByText('CAMBIANDO MODELO…')).toBeNull();
  await act(async () => { pending.resolve(json({ ...conversationA, model: { provider: 'openrouter', model: 'claude-sonnet-4.5' } })); });
  expect(screen.getByText('MODELO DE ESTA CONVERSACIÓN')).toBeVisible();
  expect(screen.getByRole('radio', { name: 'openrouter · qwen3-coder-480b' })).toBeChecked();
  expect(screen.queryByText('openrouter/claude-sonnet-4.5')).toBeNull();
  expect(requestsFor(serverA.url, modelPath)).toHaveLength(1);
  expect(requestsFor(serverB.url, modelPath)).toHaveLength(0);
});

test('a late catalogue response from the previous server never replaces the current catalogue', async () => {
  seed([serverA, serverB]); polling(serverA); polling(serverB);
  const pending = deferred<Response>(); respond(serverA.url, modelsPath, pending.promise);
  respond(serverB.url, modelsPath, json({ ...options, models: [options.models[2]] }));
  const app = renderApp(<Harness />); await app.ready();
  await screen.findByText('CARGANDO MODELOS…');
  fireEvent.press(screen.getByText('Otro Servidor'));
  await screen.findByRole('radio', { name: 'ollama · llama-3.3-70b' });
  await act(async () => { pending.resolve(json(options)); });
  expect(screen.queryByText('OPENROUTER')).toBeNull();
  expect(screen.getByText('LOCAL · OLLAMA')).toBeVisible();
});

test.each([
  { ...conversationA, origin: 'external' as const },
  { ...conversationA, writable: false },
  { ...conversationA, state: 'deleting' as const },
])('a Conversation outside writable, ready Relay origin cannot change model ($origin/$writable/$state)', async (conversation) => {
  await mount(conversation);
  expect(screen.getByText('CONVERSACIÓN DE SOLO LECTURA')).toBeVisible();
  const radio = screen.getByRole('radio', { name: 'openrouter · claude-sonnet-4.5' });
  expect(radio).toBeDisabled(); fireEvent.press(radio);
  expect(requestsFor(serverA.url, modelPath)).toHaveLength(0);
});

test('the Agent default can be restored with null without selecting an explicit override', async () => {
  await mount({ ...conversationA, model: { provider: 'openrouter', model: 'claude-sonnet-4.5' } });
  expect(screen.getByRole('radio', { name: 'openrouter · claude-sonnet-4.5' })).toBeChecked();
  respond(serverA.url, modelPath, json(conversationA), 'PUT');
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Usar modelo por defecto del Agente' })); });
  await screen.findByText('Predeterminado del Agente');
  expect(requestsFor(serverA.url, modelPath)).toEqual([expect.objectContaining({ method: 'PUT', body: { model: null } })]);
});

test('reselecting the effective model and dismissing do not write an override', async () => {
  await mount();
  fireEvent.press(screen.getByRole('radio', { name: 'openrouter · qwen3-coder-480b' }));
  expect(requestsFor(serverA.url, modelPath)).toHaveLength(0);
  fireEvent.press(screen.getByText('Cancelar'));
  expect(screen.queryByText('MODELO DE ESTA CONVERSACIÓN')).toBeNull();
  expect(requestsFor(serverA.url, modelPath)).toHaveLength(0);
});

test('a rejected model change leaves the current selection and allows retry', async () => {
  await mount();
  respond(serverA.url, modelPath, json({ error: { code: 'model_not_configured', message: 'El modelo ya no está disponible.' } }, 400), 'PUT');
  await act(async () => { fireEvent.press(screen.getByRole('radio', { name: 'openrouter · claude-sonnet-4.5' })); });
  await screen.findByText('El modelo ya no está disponible.');
  expect(screen.getByRole('radio', { name: 'openrouter · qwen3-coder-480b' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'openrouter · claude-sonnet-4.5' })).toBeEnabled();
  respond(serverA.url, modelPath, json({ ...conversationA, model: { provider: 'openrouter', model: 'claude-sonnet-4.5' } }), 'PUT');
  await act(async () => { fireEvent.press(screen.getByRole('radio', { name: 'openrouter · claude-sonnet-4.5' })); });
  await screen.findByText('openrouter/claude-sonnet-4.5');
});

test('a catalogue failure can retry and an empty catalogue never offers changes', async () => {
  seed(); polling(serverA);
  respond(serverA.url, modelsPath, json({ error: { code: 'upstream_failure', message: 'No se pudo leer el catálogo.' } }, 502));
  const app = renderApp(<Harness />); await app.ready();
  await screen.findByText('NO SE PUDIERON CARGAR LOS MODELOS');
  respond(serverA.url, modelsPath, json({ ...options, models: [] }));
  await act(async () => { fireEvent.press(screen.getByText('Reintentar')); });
  await screen.findByText('NO HAY MODELOS DISPONIBLES');
  expect(screen.queryAllByRole('radio')).toHaveLength(0);
  expect(requestsFor(serverA.url, modelPath)).toHaveLength(0);
});

test('search and provider filter combine locally and clearing them restores the catalogue without changing the model', async () => {
  await mount();
  const search = screen.getByLabelText('Buscar modelo');
  fireEvent.changeText(search, '  LLAMA  ');
  expect(screen.getAllByRole('radio')).toHaveLength(1);
  expect(screen.getByRole('radio', { name: 'ollama · llama-3.3-70b' })).toBeVisible();
  fireEvent.press(screen.getByRole('button', { name: 'Filtrar por openrouter' }));
  expect(screen.getByRole('button', { name: 'Filtrar por openrouter', selected: true })).toBeVisible();
  expect(screen.queryAllByRole('radio')).toHaveLength(0);
  expect(screen.getByText('No hay modelos que coincidan. Cambia la búsqueda o el proveedor.')).toBeVisible();
  fireEvent.press(screen.getByRole('button', { name: 'Limpiar búsqueda' }));
  expect(screen.getAllByRole('radio')).toHaveLength(2);
  expect(screen.queryByRole('radio', { name: 'ollama · llama-3.3-70b' })).toBeNull();
  expect(screen.getByRole('radio', { name: 'openrouter · qwen3-coder-480b' })).toBeChecked();
  fireEvent.press(screen.getByRole('button', { name: 'Todos los proveedores' }));
  expect(screen.getAllByRole('radio')).toHaveLength(3);
  expect(requestsFor(serverA.url, modelsPath)).toHaveLength(1);
  expect(requestsFor(serverA.url, modelPath)).toHaveLength(0);
});

test('selecting a search result with the same model identifier on different providers keeps the chosen provider and mid-Turn confirmation', async () => {
  seed(); polling(serverA);
  respond(serverA.url, modelsPath, json({ ...options, models: [...options.models, { provider: 'anthropic', model: 'claude-sonnet-4.5', label: 'claude-sonnet-4.5' }] }));
  const app = renderApp(<Harness busy />); await app.ready();
  await screen.findByRole('radio', { name: 'openrouter · qwen3-coder-480b' });
  fireEvent.changeText(screen.getByLabelText('Buscar modelo'), 'Claude');
  expect(screen.getAllByRole('radio')).toHaveLength(2);
  fireEvent.press(screen.getByRole('button', { name: 'Filtrar por anthropic' }));
  expect(screen.getAllByRole('radio')).toHaveLength(1);
  const model = { provider: 'anthropic', model: 'claude-sonnet-4.5' };
  respond(serverA.url, modelPath, json({ ...conversationA, model }), 'PUT');
  fireEvent.press(screen.getByRole('radio', { name: 'anthropic · claude-sonnet-4.5' }));
  expect(requestsFor(serverA.url, modelPath)).toHaveLength(0);
  expect(screen.getByLabelText('Buscar modelo')).toHaveProp('editable', false);
  expect(screen.getByRole('button', { name: 'Todos los proveedores' })).toBeDisabled();
  fireEvent.press(screen.getByText('Cambiar modelo'));
  await screen.findByText('anthropic/claude-sonnet-4.5');
  expect(requestsFor(serverA.url, modelPath)).toEqual([expect.objectContaining({ method: 'PUT', body: { model } })]);
  expect(requestsFor(serverA.url, modelsPath)).toHaveLength(1);
  expect(biometrics.authenticateAsync).not.toHaveBeenCalled();
});
