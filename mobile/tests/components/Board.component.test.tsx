import { useState } from 'react';
import { Pressable, Text } from 'react-native';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import ChatRoute from '@/app/chat/[server]/[agent]';
import { BoardScreen } from '@/screens/BoardScreen';
import { demoBoardPage } from '@/core/demoBoard';
import { conversationA, agentA, polling, seed, serverA, serverB } from '../support/fixtures';
import { renderApp } from '../support/renderApp';
import { json, respond, requests, requestsFor, streamFixture, networkError } from '../support/transport';
import { clockStart, stored, router, deferred, navigation } from '../support/native';
import { hold } from '../support/gestures';

const openEditing = () => { fireEvent.press(screen.getByLabelText('Más del Tablero')); fireEvent.press(screen.getByText('Editar Tablero')); };

test('native board renders seven types and keeps hide, reorder and remove preferences for this Server', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, '/v1/board', json(demoBoardPage(clockStart, 'agentA')));
  const app = renderApp(<ChatVisibilityProvider value={true}><BoardScreen serverId="A" /></ChatVisibilityProvider>); await app.ready();
  await screen.findByText('Estado de los backups');
  expect(screen.getByText('82')).toBeVisible(); expect(screen.getByText('Memoria')).toBeVisible();
  expect(screen.getByText('Último deploy')).toBeVisible(); expect(screen.getByText('Nota')).toBeVisible();
  openEditing();
  fireEvent.press(screen.getByLabelText('Bajar Estado de los backups'));
  fireEvent.press(screen.getByLabelText('Ocultar Memoria'));
  fireEvent.press(screen.getByLabelText('Quitar Nota'));
  fireEvent.press(screen.getByText('Quitar del Tablero'));
  await waitFor(() => expect(JSON.parse(stored.get('relay.board.A') ?? '{}').order.slice(0, 2)).toEqual(['agentA/disk', 'agentA/backups']));
  fireEvent.press(screen.getByText('Listo'));
  expect(screen.queryByText('Memoria')).toBeNull(); expect(screen.queryByText('Nota')).toBeNull();
  openEditing(); fireEvent.press(screen.getByLabelText('Mostrar Memoria')); fireEvent.press(screen.getByText('Listo'));
  expect(screen.getByText('Memoria')).toBeVisible();
  await act(async () => {});
});

test('NUEVA marks only unseen ready cards and disappears once the Tablero is acknowledged', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, '/v1/board', json(demoBoardPage(clockStart, 'agentA', 'states')));
  const app = renderApp(<ChatVisibilityProvider value={true}><BoardScreen serverId="A" /></ChatVisibilityProvider>); await app.ready();
  await screen.findByText('Estado de los backups');
  // states: backups error, disk updating, memory stale; the other four are ready.
  expect(screen.getAllByText('NUEVA')).toHaveLength(4);
  openEditing();
  fireEvent.press(screen.getByText('Listo'));
  expect(screen.queryByText('NUEVA')).toBeNull();
  await waitFor(() => expect(JSON.parse(stored.get('relay.board.A') ?? '{}').seen).toHaveLength(7));
});

test('NUEVA honors the seen cards persisted for this Server', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, '/v1/board', json(demoBoardPage(clockStart, 'agentA')));
  stored.set('relay.board.A', JSON.stringify({ order: [], hidden: [], removed: [], seen: ['agentA/disk', 'agentA/note'] }));
  const app = renderApp(<ChatVisibilityProvider value={true}><BoardScreen serverId="A" /></ChatVisibilityProvider>); await app.ready();
  await screen.findByText('Estado de los backups');
  await waitFor(() => expect(screen.getAllByText('NUEVA')).toHaveLength(5));
  await act(async () => {});
});

test('the confirmations open in a sheet, so they are in view whatever the scroll of the list', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, '/v1/board', json(demoBoardPage(clockStart, 'agentA')));
  const app = renderApp(<ChatVisibilityProvider value={true}><BoardScreen serverId="A" /></ChatVisibilityProvider>); await app.ready();
  fireEvent.press(await screen.findByText('Enviar a dev'));
  expect(within(screen.getByTestId('sheet')).getByText('Abrir Conversación nueva')).toBeVisible();
  fireEvent.press(within(screen.getByTestId('sheet')).getByText('Cancelar'));
  fireEvent.press(screen.getByLabelText('Más del Tablero')); fireEvent.press(screen.getByText('Editar Tablero'));
  await act(async () => { jest.advanceTimersByTime(400); });
  fireEvent.press(screen.getByLabelText('Quitar Nota'));
  expect(within(screen.getByTestId('sheet')).getByText('Quitar del Tablero')).toBeVisible();
  await act(async () => {});
});

test('action previews the exact message, opens a new draft and never sends from the board', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, '/v1/board', json(demoBoardPage(clockStart, 'agentA')));
  const app = renderApp(<ChatVisibilityProvider value={true}><BoardScreen serverId="A" /></ChatVisibilityProvider>); await app.ready();
  fireEvent.press(await screen.findByText('Enviar a dev'));
  expect(screen.getByText('Se abrirá una Conversación nueva. Revisa el mensaje y decide si lo envías desde el chat.')).toBeVisible();
  fireEvent.press(screen.getByText('Abrir Conversación nueva'));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/chat/[server]/[agent]', params: { server: 'A', agent: 'agentA', boardDraft: 'Limpia la caché de build de nodo-app y dime cuánto espacio recuperaste.' } });
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
  await act(async () => {});
});

test('board draft ignores latest history, waits for explicit send and creates a new Relay Conversation', async () => {
  seed(); polling(serverA, [agentA]);
  const fresh = { ...conversationA, id: 'new-board', sessionId: 'new-board', title: null, messageCount: 0 };
  respond(serverA.url, '/v1/agents/agentA/transcript', json({ conversation: conversationA, sessionId: conversationA.sessionId, items: [] }));
  respond(serverA.url, '/v1/agents/agentA/conversations', json(fresh), 'POST');
  const stream = streamFixture();
  respond(serverA.url, '/v1/agents/agentA/runs', json({ runId: 'board-run', sessionId: 'new-board' }), 'POST');
  respond(serverA.url, '/v1/runs/board-run/events', stream.reply);
  navigation.params = { server: "A", agent: "agentA", boardDraft: "Revisa los backups" };
  const app = renderApp(<ChatVisibilityProvider value={true}><ChatRoute /></ChatVisibilityProvider>); await app.ready();
  const input = await screen.findByPlaceholderText('Mensaje a Agente A…');
  await waitFor(() => expect(input).toHaveProp('editable', true));
  expect(input).toHaveProp('value', 'Revisa los backups');
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
  expect(requestsFor(serverA.url, '/v1/agents/agentA/transcript')).toHaveLength(0);
  fireEvent.press(screen.getByLabelText('Enviar'));
  await waitFor(() => expect(stream.reader.read).toHaveBeenCalled());
  expect(requestsFor(serverA.url, '/v1/agents/agentA/conversations')).toHaveLength(1);
  expect(requestsFor(serverA.url, '/v1/agents/agentA/runs')[0].body).toEqual({ input: 'Revisa los backups', sessionId: 'new-board' });
  expect(requestsFor(serverA.url, '/v1/agents/agentA/runs')[0].headers.get('X-Relay-Protocol')).toBe('2');
});

test('loading, empty, error retry, offline and publication states are honest', async () => {
  seed(); polling(serverA, [agentA]); const pending = deferred<Response>();
  respond(serverA.url, '/v1/board', pending.promise);
  const app = renderApp(<ChatVisibilityProvider value={true}><BoardScreen serverId="A" /></ChatVisibilityProvider>); await app.ready();
  expect(screen.getByText('CARGANDO TABLERO…')).toBeVisible();
  await act(async () => pending.resolve(json(demoBoardPage(clockStart, 'agentA', 'empty'))));
  expect(screen.getByText('SIN TARJETAS')).toBeVisible();
  fireEvent.press(screen.getByText('«Agrega al Tablero el estado de mis backups»'));
  expect(screen.getByText('MENSAJE A AGENTE A')).toBeVisible(); fireEvent.press(screen.getByText('Cancelar'));
  respond(serverA.url, '/v1/board', json({ error: { code: 'unavailable', message: 'fixture' } }, 503));
  await act(async () => { await jest.advanceTimersByTimeAsync(15000); });
  await screen.findByText('No se pudo cargar el Tablero. Reintenta.');
  respond(serverA.url, '/v1/board', json(demoBoardPage(clockStart, 'agentA', 'states')));
  fireEvent.press(screen.getByText('Reintentar'));
  await screen.findByText(/ACTUALIZANDO ·/); expect(screen.getByText(/VIEJA ·/)).toBeVisible(); expect(screen.getByText(/FALLIDA ·/)).toBeVisible();
  respond(serverA.url, '/v1/board', () => networkError());
  await act(async () => { await jest.advanceTimersByTimeAsync(15000); });
  await screen.findByText(/SIN RESPUESTA/);
  expect(screen.getByText('Enviar a dev')).toBeVisible();
});

test('preferences survive remount and cannot hide another Server card with the same id', async () => {
  seed([serverA, serverB]); polling(serverA, [agentA]); polling(serverB, [agentA]);
  for (const server of [serverA, serverB]) respond(server.url, '/v1/board', json(demoBoardPage(clockStart, 'agentA')));
  function Switcher() {
    const [id, setId] = useState('A');
    return <><Pressable onPress={() => setId(id === 'A' ? 'B' : 'A')}><Text>Cambiar Servidor de prueba</Text></Pressable><BoardScreen serverId={id}/></>;
  }
  const app = renderApp(<ChatVisibilityProvider value={true}><Switcher /></ChatVisibilityProvider>); await app.ready(); await screen.findByText('Memoria');
  openEditing(); fireEvent.press(screen.getByLabelText('Ocultar Memoria'));
  await waitFor(() => expect(stored.get('relay.board.A')).toContain('agentA/memory'));
  fireEvent.press(screen.getByText('Cambiar Servidor de prueba'));
  await screen.findByText('Memoria');
  expect(stored.get('relay.board.B')).toBeUndefined();
  fireEvent.press(screen.getByText('Cambiar Servidor de prueba'));
  await screen.findByText('Disco /srv'); expect(screen.queryByText('Memoria')).toBeNull();
});

test('the ⋯ key opens the Tablero sheet with Administrar Servidor and Editar Tablero', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, '/v1/board', json(demoBoardPage(clockStart, 'agentA')));
  const app = renderApp(<ChatVisibilityProvider value={true}><BoardScreen serverId="A" /></ChatVisibilityProvider>); await app.ready();
  await screen.findByText('Estado de los backups');
  expect(screen.queryByText('Administrar Servidor')).toBeNull();
  fireEvent.press(screen.getByLabelText('Más del Tablero'));
  expect(screen.getByText('Administrar Servidor')).toBeVisible(); expect(screen.getByText('Editar Tablero')).toBeVisible();
  fireEvent.press(screen.getByText('Administrar Servidor'));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/server/[server]', params: { server: 'A' } });
  await act(async () => {});
});

test('a card with NUEVA shows exactly one chip and the caption counts the new ones', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, '/v1/board', json(demoBoardPage(clockStart, 'agentA')));
  stored.set('relay.board.A', JSON.stringify({ order: [], hidden: [], removed: [], seen: ['agentA/backups', 'agentA/disk', 'agentA/clean', 'agentA/memory', 'agentA/note', 'agentA/requests'] }));
  const app = renderApp(<ChatVisibilityProvider value={true}><BoardScreen serverId="A" /></ChatVisibilityProvider>); await app.ready();
  await waitFor(() => expect(screen.getAllByText('NUEVA')).toHaveLength(1));
  expect(screen.getByText('7 TARJETAS · 1 NUEVA')).toBeVisible();
  await act(async () => {});
});

test('pulling down 60 px reloads the Tablero', async () => {
  seed(); polling(serverA, [agentA]); respond(serverA.url, '/v1/board', json(demoBoardPage(clockStart, 'agentA')));
  const app = renderApp(<ChatVisibilityProvider value={true}><BoardScreen serverId="A" /></ChatVisibilityProvider>); await app.ready();
  await screen.findByText('Estado de los backups');
  const before = requestsFor(serverA.url, '/v1/board').length;
  const finger = hold('pull-to-refresh', [{ y: 120 }]);
  await act(async () => { await jest.advanceTimersByTimeAsync(0); });
  await act(async () => { finger.release(); await jest.advanceTimersByTimeAsync(0); });
  await waitFor(() => expect(requestsFor(serverA.url, '/v1/board').length).toBeGreaterThan(before));
  await act(async () => {});
});
