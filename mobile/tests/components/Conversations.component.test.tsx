import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { Conversation } from '../../../protocol/protocol';
import { ChatScreen } from '@/screens/ChatScreen';
import { agentA, polling, seed, serverA, serverB, serverInfo } from '../support/fixtures';
import { renderApp } from '../support/renderApp';
import { json, networkError, requestsFor, respond, streamFixture } from '../support/transport';
import { deferred } from '../support/native';

const root = '/v1/agents/agentA';
const latest: Conversation = { id: 'relay-latest', sessionId: 'relay-latest', title: 'Revisar despliegue', source: 'api_server', origin: 'relay', originLabel: 'Relay', kind: 'interactive', writable: true, archived: false, hidden: false, state: 'ready', startedAt: 1791028800000, lastActiveAt: 1791028800000, messageCount: 2, preview: 'Todo listo', model: null };
const external: Conversation = { ...latest, id: 'discord-history', sessionId: 'discord-history', title: 'Migrar Node', source: 'discord', origin: 'external', originLabel: 'Discord', writable: false, messageCount: 31 };
const older: Conversation = { ...latest, id: 'relay-older', sessionId: 'relay-older-tip', title: 'Configurar Caddy', messageCount: 22 };
const listPath = `${root}/conversations?background=false&limit=50&offset=0`;

function setup() {
  seed(); polling(serverA, [agentA]); respond(serverA.url, '/v1/server', json(serverInfo));
  respond(serverA.url, listPath, json({ conversations: [latest, external, older], nextOffset: null }));
  respond(serverA.url, `${root}/transcript`, json({ sessionId: latest.sessionId, conversation: latest, items: [{ kind: 'assistant', id: 'latest-answer', text: 'Todo listo', at: latest.lastActiveAt }] }));
  respond(serverA.url, `${root}/transcript?sessionId=relay-latest`, json({ sessionId: latest.sessionId, conversation: latest, items: [{ kind: 'assistant', id: 'latest-answer', text: 'Todo listo', at: latest.lastActiveAt }] }));
  respond(serverA.url, `${root}/transcript?sessionId=relay-older-tip`, json({ sessionId: older.sessionId, conversation: older, items: [{ kind: 'assistant', id: 'older-answer', text: 'Caddy configurado', at: older.lastActiveAt }] }));
  respond(serverA.url, `${root}/transcript?sessionId=discord-history`, json({ sessionId: external.sessionId, conversation: external, items: [{ kind: 'assistant', id: 'external-answer', text: 'Historial de Discord', at: external.lastActiveAt }] }));
}

test('the title opens the conversation panel and an external conversation opens read-only with its own history', async () => {
  setup(); const app = renderApp(<ChatScreen serverId="A" agentId="agentA" />); await app.ready();
  await waitFor(() => expect(screen.getByText('Todo listo')).toBeVisible());
  fireEvent.press(screen.getByLabelText('Abrir conversaciones'));
  expect(screen.getByText('Conversación nueva')).toBeVisible();
  fireEvent.press(await screen.findByLabelText('Abrir conversación Migrar Node'));
  await waitFor(() => expect(screen.getByText('Historial de Discord')).toBeVisible());
  expect(screen.getByText('Esta conversación nació en Discord. Solo lectura.')).toBeVisible();
  expect(screen.queryByPlaceholderText('Mensaje a Agente A…')).toBeNull();
});

async function mount() {
  const app = renderApp(<ChatScreen serverId="A" agentId="agentA" />); await app.ready();
  await waitFor(() => expect(screen.getByText('Todo listo')).toBeVisible());
  return app;
}
async function openPanel() {
  fireEvent.press(screen.getByLabelText('Abrir conversaciones'));
  await screen.findByLabelText('Abrir conversación Migrar Node');
}

test('switching keeps independent drafts and sends to the selected family tip while live output cannot move to another conversation', async () => {
  setup(); await mount();
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Borrador reciente');
  await openPanel(); fireEvent.press(screen.getByLabelText('Abrir conversación Configurar Caddy'));
  await screen.findByText('Caddy configurado');
  expect(screen.getByPlaceholderText('Mensaje a Agente A…')).toHaveProp('value', '');
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Borrador Caddy');
  await openPanel(); fireEvent.press(screen.getByLabelText('Abrir conversación Revisar despliegue'));
  await screen.findByText('Todo listo');
  expect(screen.getByPlaceholderText('Mensaje a Agente A…')).toHaveProp('value', 'Borrador reciente');
  await openPanel(); fireEvent.press(screen.getByLabelText('Abrir conversación Configurar Caddy'));
  await screen.findByText('Caddy configurado');
  expect(screen.getByPlaceholderText('Mensaje a Agente A…')).toHaveProp('value', 'Borrador Caddy');
  const stream = streamFixture();
  respond(serverA.url, `${root}/runs`, json({ runId: 'selected-run', sessionId: older.sessionId }), 'POST');
  respond(serverA.url, '/v1/runs/selected-run/events', stream.reply);
  fireEvent.press(screen.getByLabelText('Enviar'));
  await waitFor(() => expect(stream.reader.read).toHaveBeenCalled());
  expect(requestsFor(serverA.url, `${root}/runs`)[0].body).toEqual({ input: 'Borrador Caddy', sessionId: 'relay-older-tip' });
  expect(requestsFor(serverA.url, `${root}/runs`)[0].headers.get('X-Relay-Protocol')).toBe('2');
  await openPanel();
  fireEvent.press(screen.getByLabelText('Abrir conversación Migrar Node'));
  fireEvent.press(screen.getByText('Conversación nueva'));
  fireEvent.press(screen.getByLabelText('Acciones de Configurar Caddy'));
  fireEvent.press(screen.getByText('BORRAR'));
  expect(requestsFor(serverA.url, `${root}/transcript?sessionId=discord-history`)).toHaveLength(0);
  expect(requestsFor(serverA.url, `${root}/conversations`,)).toHaveLength(0);
  expect(requestsFor(serverA.url, `${root}/conversations/relay-older/deletion`)).toHaveLength(0);
  fireEvent.press(screen.getByLabelText('Cerrar conversaciones'));
  await act(async () => { stream.emit('data: {"type":"message.delta","text":"Respuesta de Caddy"}\n\n'); });
  expect(screen.getByText('Respuesta de Caddy')).toBeVisible();
  expect(screen.queryByText('Historial de Discord')).toBeNull();
  await act(async () => { stream.emit('data: {"type":"run.completed","output":"Respuesta de Caddy"}\n\n'); stream.close(); });
});

test('a late transcript from the initially opened conversation cannot replace the newly selected history', async () => {
  setup(); const late = deferred<Response>();
  respond(serverA.url, `${root}/transcript`, late.promise);
  const app = renderApp(<ChatScreen serverId="A" agentId="agentA" />); await app.ready();
  await openPanel(); fireEvent.press(screen.getByLabelText('Abrir conversación Migrar Node'));
  await screen.findByText('Historial de Discord');
  await act(async () => { late.resolve(json({ sessionId: latest.sessionId, conversation: latest, items: [{ kind: 'assistant', id: 'late', text: 'Respuesta tardía incorrecta', at: latest.lastActiveAt }] })); });
  expect(screen.queryByText('Respuesta tardía incorrecta')).toBeNull();
  expect(screen.getByText('Historial de Discord')).toBeVisible();
});

test('search reads message snippets and ignores an older search response after the query changes', async () => {
  setup(); await mount(); await openPanel();
  const old = deferred<Response>();
  respond(serverA.url, `${root}/conversations/search?q=build&background=false&limit=50&offset=0`, old.promise);
  respond(serverA.url, `${root}/conversations/search?q=Caddy&background=false&limit=50&offset=0`, json({ hits: [{ conversation: older, match: 'message', messageId: 'message-caddy', snippet: 'El Caddyfile usa TLS interno' }], nextOffset: null }));
  fireEvent.changeText(screen.getByLabelText('Buscar conversaciones'), 'build');
  await waitFor(() => expect(requestsFor(serverA.url, `${root}/conversations/search?q=build&background=false&limit=50&offset=0`)).toHaveLength(1));
  fireEvent.changeText(screen.getByLabelText('Buscar conversaciones'), 'Caddy');
  await screen.findByText('El Caddyfile usa TLS interno');
  await act(async () => { old.resolve(json({ hits: [{ conversation: external, match: 'title', messageId: null, snippet: 'Respuesta vieja' }], nextOffset: null })); });
  expect(screen.queryByText('Respuesta vieja')).toBeNull();
  expect(screen.getByText('El Caddyfile usa TLS interno')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Abrir conversación Configurar Caddy'));
  await screen.findByText('Caddy configurado');
});

test('background starts off, switches to tasks only, and the list pages without losing the first page', async () => {
  setup(); respond(serverA.url, listPath, json({ conversations: [latest, external], nextOffset: 50 }));
  respond(serverA.url, `${root}/conversations?background=false&limit=50&offset=50`, json({ conversations: [older], nextOffset: null }));
  const background: Conversation = { ...external, id: 'scheduled', sessionId: 'scheduled', title: 'Resumen diario', source: 'cron', originLabel: 'Tarea programada', kind: 'background' };
  respond(serverA.url, `${root}/conversations?background=true&limit=50&offset=0`, json({ conversations: [background], nextOffset: null }));
  await mount(); await openPanel();
  expect(screen.getByRole('switch', { name: 'De fondo' })).not.toBeChecked();
  expect(screen.queryByText('Resumen diario')).toBeNull();
  fireEvent.press(screen.getByText('Cargar más'));
  await screen.findByLabelText('Abrir conversación Configurar Caddy');
  expect(screen.getByLabelText('Abrir conversación Migrar Node')).toBeVisible();
  fireEvent.press(screen.getByRole('switch', { name: 'De fondo' }));
  await screen.findByText('Resumen diario');
  expect(screen.queryByLabelText('Abrir conversación Configurar Caddy')).toBeNull();
  expect(screen.getByRole('switch', { name: 'De fondo' })).toBeChecked();
});

test('deleting an external conversation confirms fetched counts and a changed revision requires a new confirmation', async () => {
  setup(); await mount(); await openPanel();
  const path = `${root}/conversations/discord-history`;
  let reads = 0;
  respond(serverA.url, `${path}/deletion`, () => json({ conversationId: external.id, messageCount: ++reads === 1 ? 38 : 40, conversationCount: 2, revision: reads === 1 ? 'revision-old' : 'revision-new' }));
  let writes = 0;
  respond(serverA.url, path, () => ++writes === 1 ? json({ error: { code: 'conversation_changed', message: 'La conversación cambió' } }, 409) : json({ conversationId: external.id, deleted: true, messageCount: 40 }), 'DELETE');
  fireEvent.press(screen.getByLabelText('Acciones de Migrar Node')); fireEvent.press(screen.getByText('BORRAR'));
  await screen.findByText('Se borrarán sus 38 mensajes de 2 continuaciones. No se puede deshacer.');
  expect(requestsFor(serverA.url, path)).toHaveLength(0);
  fireEvent.press(screen.getByText('Borrar'));
  await screen.findByText('Se borrarán sus 40 mensajes de 2 continuaciones. No se puede deshacer.');
  expect(screen.getByText('La conversación cambió. Revisa el nuevo conteo y confirma de nuevo.')).toBeVisible();
  expect(requestsFor(serverA.url, path)).toHaveLength(1);
  expect(requestsFor(serverA.url, path)[0].body).toEqual({ revision: 'revision-old' });
  respond(serverA.url, listPath, json({ conversations: [latest, older], nextOffset: null }));
  fireEvent.press(screen.getByText('Borrar'));
  await waitFor(() => expect(screen.queryByText('¿BORRAR CONVERSACIÓN?')).not.toBeOnTheScreen());
  expect(requestsFor(serverA.url, path)[1].body).toEqual({ revision: 'revision-new' });
  expect(screen.queryByLabelText('Abrir conversación Migrar Node')).toBeNull();
  fireEvent.press(screen.getByLabelText('Cerrar conversaciones')); expect(screen.getByText('Todo listo')).toBeVisible();
});

test('an uncertain deletion can be resumed after closing and reopening the conversation panel', async () => {
  setup(); await mount(); await openPanel();
  const path = `${root}/conversations/discord-history`;
  respond(serverA.url, `${path}/deletion`, json({ conversationId: external.id, messageCount: 31, conversationCount: 1, revision: 'saved-confirmation' }));
  respond(serverA.url, path, json({ error: { code: 'operation_uncertain', message: 'El borrado no está confirmado' } }, 503), 'DELETE');
  fireEvent.press(screen.getByLabelText('Acciones de Migrar Node')); fireEvent.press(screen.getByText('BORRAR'));
  await screen.findByText('Se borrarán sus 31 mensajes. No se puede deshacer.');
  fireEvent.press(screen.getByText('Borrar'));
  await screen.findByText('El borrado no está confirmado');
  fireEvent.press(screen.getByText('Cancelar'));
  fireEvent.press(screen.getByLabelText('Cerrar conversaciones'));
  respond(serverA.url, listPath, json({ conversations: [latest, { ...external, state: 'deleting' }, older], nextOffset: null }));
  await openPanel();
  expect(screen.getByLabelText('Abrir conversación Migrar Node')).toBeDisabled();
  fireEvent.press(screen.getByLabelText('Acciones de Migrar Node'));
  expect(screen.getByText('RENOMBRAR')).toBeDisabled();
  fireEvent.press(screen.getByText('BORRAR'));
  await screen.findByText('Se borrarán sus 31 mensajes. No se puede deshacer.');
  respond(serverA.url, path, json({ conversationId: external.id, deleted: true, messageCount: 31 }), 'DELETE');
  respond(serverA.url, listPath, json({ conversations: [latest, older], nextOffset: null }));
  fireEvent.press(screen.getByText('Borrar'));
  await waitFor(() => expect(screen.queryByText('¿BORRAR CONVERSACIÓN?')).not.toBeOnTheScreen());
  expect(requestsFor(serverA.url, path)[1].body).toEqual({ revision: 'saved-confirmation' });
  expect(screen.queryByLabelText('Abrir conversación Migrar Node')).toBeNull();
});

test('rename keeps the editor and server uniqueness error visible, enforces 100 characters, and updates the selected title on success', async () => {
  setup(); await mount(); await openPanel();
  const path = `${root}/conversations/relay-latest`;
  respond(serverA.url, path, json({ error: { code: 'upstream_failure', message: 'Hermes: ya existe ese título' } }, 502), 'PATCH');
  fireEvent.press(screen.getByLabelText('Acciones de Revisar despliegue')); fireEvent.press(screen.getByText('RENOMBRAR'));
  const input = screen.getByLabelText('Título de la conversación');
  fireEvent.changeText(input, 'x'.repeat(101)); fireEvent.press(screen.getByText('Guardar'));
  expect(requestsFor(serverA.url, path)).toHaveLength(0);
  fireEvent.changeText(input, 'Título duplicado'); fireEvent.press(screen.getByText('Guardar'));
  await screen.findByText('Hermes: ya existe ese título');
  expect(screen.getByLabelText('Título de la conversación')).toHaveProp('value', 'Título duplicado');
  respond(serverA.url, path, json({ ...latest, title: 'Plan del despliegue' }), 'PATCH');
  respond(serverA.url, listPath, json({ conversations: [{ ...latest, title: 'Plan del despliegue' }, external], nextOffset: null }));
  fireEvent.changeText(input, '  Plan del despliegue  '); fireEvent.press(screen.getByText('Guardar'));
  await waitFor(() => expect(screen.queryByLabelText('Título de la conversación')).not.toBeOnTheScreen());
  expect(requestsFor(serverA.url, path)[1].body).toEqual({ title: 'Plan del despliegue' });
  fireEvent.press(screen.getByLabelText('Cerrar conversaciones')); expect(screen.getByText('Plan del despliegue')).toBeVisible();
});

test('new conversations reuse their UUID receipt after an uncertain result and open an empty Relay composer', async () => {
  setup(); await mount(); await openPanel();
  const created: Conversation = { ...latest, id: 'created', sessionId: 'created', title: null, messageCount: 0, preview: null };
  let attempts = 0;
  respond(serverA.url, `${root}/conversations`, () => ++attempts === 1 ? json({ error: { code: 'operation_uncertain', message: 'Resultado incierto; reintenta la misma solicitud' } }, 503) : json(created, 201), 'POST');
  respond(serverA.url, `${root}/transcript?sessionId=created`, json({ sessionId: created.sessionId, conversation: created, items: [] }));
  fireEvent.press(screen.getByText('Conversación nueva'));
  await screen.findByText('Resultado incierto; reintenta la misma solicitud');
  fireEvent.press(screen.getByText('Conversación nueva'));
  await screen.findByText('Esta conversación todavía no tiene mensajes.');
  const creates = requestsFor(serverA.url, `${root}/conversations`);
  expect(creates).toHaveLength(2); expect(creates[1].body).toEqual(creates[0].body);
  expect(creates[0].body).toEqual({ requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) });
  expect(screen.getByPlaceholderText('Mensaje a Agente A…')).toHaveProp('value', '');
});

test('legacy api_server conversations without a Relay receipt remain read-only, regardless of their title', async () => {
  setup(); const legacy: Conversation = { ...external, id: 'legacy', sessionId: 'legacy', source: 'api_server', title: 'Relay antigua', originLabel: 'API de Hermes · sin recibo de Relay' };
  respond(serverA.url, `${root}/transcript`, json({ sessionId: 'legacy', conversation: legacy, items: [] }));
  const app = renderApp(<ChatScreen serverId="A" agentId="agentA" />); await app.ready();
  await screen.findByText('Esta conversación nació en API de Hermes · sin recibo de Relay. Solo lectura.');
  expect(screen.queryByPlaceholderText('Mensaje a Agente A…')).toBeNull();
  expect(requestsFor(serverA.url, `${root}/runs`)).toHaveLength(0);
});

test('no hits can be cleared, a panel error can be retried, and an empty list still offers creation', async () => {
  setup(); await mount(); await openPanel();
  respond(serverA.url, `${root}/conversations/search?q=kubernetes&background=false&limit=50&offset=0`, json({ hits: [], nextOffset: null }));
  fireEvent.changeText(screen.getByLabelText('Buscar conversaciones'), 'kubernetes');
  await screen.findByText('NADA COINCIDE CON «kubernetes»');
  respond(serverA.url, listPath, json({ error: { code: 'conversation_store_unavailable', message: 'Lectura de Hermes no disponible' } }, 503));
  fireEvent.press(screen.getByText('Borrar búsqueda')); await screen.findByText('NO SE PUDIERON CARGAR');
  expect(screen.getByText('Lectura de Hermes no disponible')).toBeVisible();
  respond(serverA.url, listPath, json({ conversations: [], nextOffset: null }));
  fireEvent.press(screen.getByText('Reintentar')); await screen.findByText('SIN CONVERSACIONES');
  expect(screen.getByText('Conversación nueva')).toBeVisible();
});

test('the panel offers offline recovery without replacing the loaded conversation', async () => {
  setup(); await mount(); respond(serverA.url, listPath, networkError);
  fireEvent.press(screen.getByLabelText('Abrir conversaciones'));
  await screen.findByText(/· SIN RESPUESTA$/); expect(screen.queryByText('Abrir Tailscale')).toBeNull(); expect(screen.getByText('Reintentar')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Cerrar conversaciones')); expect(screen.getByText('Todo listo')).toBeVisible();
});

test('deleting the selected conversation discards only its draft, locks pending confirmation and opens the latest remaining conversation', async () => {
  setup(); await mount();
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Borrador que se borra');
  await openPanel();
  const deletion = deferred<Response>();
  const path = `${root}/conversations/relay-latest`;
  respond(serverA.url, `${path}/deletion`, json({ conversationId: latest.id, messageCount: 2, conversationCount: 1, revision: 'latest-revision' }));
  respond(serverA.url, path, deletion.promise, 'DELETE');
  fireEvent.press(screen.getByLabelText('Acciones de Revisar despliegue')); fireEvent.press(screen.getByText('BORRAR'));
  await screen.findByText('Se borrarán sus 2 mensajes. No se puede deshacer.');
  fireEvent.press(screen.getByText('Borrar'));
  await waitFor(() => expect(requestsFor(serverA.url, path)).toHaveLength(1));
  expect(screen.getByLabelText('Cerrar conversaciones')).toBeDisabled();
  fireEvent.press(screen.getByLabelText('Cerrar conversaciones'));
  expect(screen.getByText('¿BORRAR CONVERSACIÓN?')).toBeVisible();
  respond(serverA.url, listPath, json({ conversations: [older, external], nextOffset: null }));
  respond(serverA.url, `${root}/transcript`, json({ sessionId: older.sessionId, conversation: older, items: [{ kind: 'assistant', id: 'remaining', text: 'Caddy configurado', at: older.lastActiveAt }] }));
  await act(async () => { deletion.resolve(json({ conversationId: latest.id, deleted: true, messageCount: 2 })); });
  await screen.findByLabelText('Abrir conversación Configurar Caddy');
  fireEvent.press(screen.getByLabelText('Cerrar conversaciones'));
  await screen.findByText('Caddy configurado');
  expect(screen.getByPlaceholderText('Mensaje a Agente A…')).toHaveProp('value', '');
  expect(screen.queryByText('Todo listo')).toBeNull();
});

test('typing the first message creates a receipted conversation before sending, and an accepted stream failure does not overwrite the next draft', async () => {
  setup(); respond(serverA.url, `${root}/transcript`, json({ sessionId: null, conversation: null, items: [] }));
  const created: Conversation = { ...latest, id: 'first-created', sessionId: 'first-created', title: null, messageCount: 0 };
  respond(serverA.url, `${root}/conversations`, json(created, 201), 'POST');
  respond(serverA.url, `${root}/runs`, json({ runId: 'first-run', sessionId: created.sessionId }), 'POST');
  const stream = streamFixture(); respond(serverA.url, '/v1/runs/first-run/events', stream.reply);
  const app = renderApp(<ChatScreen serverId="A" agentId="agentA" />); await app.ready();
  await screen.findByText('Escribe el primer mensaje o crea una conversación nueva.');
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Mi primer mensaje'); fireEvent.press(screen.getByLabelText('Enviar'));
  await waitFor(() => expect(stream.reader.read).toHaveBeenCalled());
  expect(requestsFor(serverA.url, `${root}/conversations`)).toHaveLength(1);
  expect(requestsFor(serverA.url, `${root}/runs`)[0].body).toEqual({ input: 'Mi primer mensaje', sessionId: 'first-created' });
  fireEvent.changeText(screen.getByPlaceholderText('Redirigir sin detener…'), 'La próxima pregunta');
  await act(async () => { stream.fail(); });
  expect(screen.getByDisplayValue('La próxima pregunta')).toHaveProp('value', 'La próxima pregunta');
  expect(screen.getByText('Mi primer mensaje')).toBeVisible();
});

test('replacing a Server resets its draft and ignores a late transcript from the previous connection', async () => {
  setup(); const app = await mount();
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Borrador del Servidor anterior');
  const stale = deferred<Response>();
  respond(serverA.url, `${root}/transcript?sessionId=relay-older-tip`, stale.promise);
  await openPanel(); fireEvent.press(screen.getByLabelText('Abrir conversación Configurar Caddy'));
  await waitFor(() => expect(requestsFor(serverA.url, `${root}/transcript?sessionId=relay-older-tip`)).toHaveLength(1));
  const replacement: Conversation = { ...latest, id: 'replacement', sessionId: 'replacement', title: 'Servidor nuevo' };
  polling(serverB, [agentA]); respond(serverB.url, '/v1/server', json(serverInfo));
  respond(serverB.url, `${root}/transcript`, json({ sessionId: replacement.sessionId, conversation: replacement, items: [{ kind: 'assistant', id: 'replacement-answer', text: 'Respuesta del Servidor nuevo', at: replacement.lastActiveAt }] }));
  await act(async () => { await app.probe.current!.replaceServer('A', serverB); });
  await screen.findByText('Respuesta del Servidor nuevo');
  await act(async () => { stale.resolve(json({ sessionId: older.sessionId, conversation: older, items: [{ kind: 'assistant', id: 'late-old', text: 'Respuesta tardía del Servidor anterior', at: older.lastActiveAt }] })); });
  expect(screen.getByText('Respuesta del Servidor nuevo')).toBeVisible();
  expect(screen.queryByText('Respuesta tardía del Servidor anterior')).toBeNull();
  expect(screen.getByPlaceholderText('Mensaje a Agente A…')).toHaveProp('value', '');
});
