import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { ChatScreen } from '@/screens/ChatScreen';
import { agentA, conversationA, polling, seed, serverA, serverInfo } from '../support/fixtures';
import { clockStart } from '../support/native';
import { renderApp } from '../support/renderApp';
import { binary, json, requestsFor, respond, streamFixture } from '../support/transport';
import { configureLocalFiles, localFiles, fileOperations, intentLauncher, sharing } from '../support/files';
const root = '/v1/agents/agentA';
const fileRoot = `${root}/conversations/${conversationA.id}/files`;
const record = { id: 'file-1', messageId: 'assistant-files', name: 'informe.md', mimeType: 'text/markdown', size: 3, status: 'ready' };
function setup(files = [record]) {
  seed(); polling(serverA, [agentA]); configureLocalFiles();
  respond(serverA.url, '/v1/server', json(serverInfo)); respond(serverA.url, `${root}/chat`, json({ available: true, reason: null }));
  const history = { sessionId: conversationA.sessionId, conversation: conversationA, items: [{ kind: 'assistant', id: 'assistant-files', text: 'Aquí está. MEDIA:/server/private/informe.md', at: clockStart }] };
  respond(serverA.url, `${root}/transcript`, json(history)); respond(serverA.url, `${root}/transcript?sessionId=${conversationA.sessionId}`, json(history));
  respond(serverA.url, `${fileRoot}?limit=50&offset=0`, json({ files, displayMessages: [{ messageId: 'assistant-files', text: 'Aquí está.' }], nextOffset: null }));
  respond(serverA.url, `${fileRoot}/${record.id}`, binary(new Uint8Array([1, 2, 3]), 'text/markdown'));
}
async function mount() { const app = renderApp(<ChatScreen serverId="A" agentId="agentA" />); await app.ready(); await screen.findByText('informe.md'); return app; }
test('open downloads into a scoped local file, hides the technical path, and sharing reuses only the finished copy', async () => {
  setup(); await mount();
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Borrador conservado');
  expect(screen.queryByText(/server\/private/)).toBeNull();
  fireEvent.press(screen.getByLabelText('Abrir informe.md'));
  await waitFor(() => expect(intentLauncher.startActivityAsync).toHaveBeenCalled());
  const intent = intentLauncher.startActivityAsync.mock.calls[0];
  expect(intent[0]).toBe('android.intent.action.VIEW'); expect(intent[1]).toMatchObject({ data: expect.stringMatching(/^content:\/\//), type: 'text/markdown', flags: 1 });
  const saved = [...localFiles.keys()].find((uri) => uri.endsWith('/informe.md'))!; expect(localFiles.get(saved)).toEqual([1, 2, 3]);
  expect(fileOperations.some((entry) => entry.kind === 'move')).toBe(true);
  fireEvent.press(screen.getByLabelText('Compartir informe.md'));
  await waitFor(() => expect(sharing.shareAsync).toHaveBeenCalledWith(saved, { mimeType: 'text/markdown', dialogTitle: 'Compartir informe.md' }));
  expect(requestsFor(serverA.url, `${fileRoot}/${record.id}`)).toHaveLength(1);
  expect(screen.getByPlaceholderText('Mensaje a Agente A…')).toHaveProp('value', 'Borrador conservado');
});
test('too large, missing and blocked files expose states without opening or sharing', async () => {
  setup([{ ...record, status: 'too_large', size: 60 * 1024 * 1024 }, { ...record, id: 'missing', name: 'metricas.csv', status: 'missing' }, { ...record, id: 'blocked', name: 'privado.txt', status: 'blocked' }]);
  await mount(); expect(screen.getByText('PESA MÁS DE 50 MB · NO SE PUEDE DESCARGAR DESDE RELAY')).toBeVisible();
  expect(screen.getByText('YA NO ESTÁ EN EL SERVIDOR')).toBeVisible(); expect(screen.getByText('EL ARCHIVO NO SE PUEDE ENTREGAR')).toBeVisible();
  expect(screen.queryByLabelText('Abrir informe.md')).toBeNull(); expect(intentLauncher.startActivityAsync).not.toHaveBeenCalled(); expect(sharing.shareAsync).not.toHaveBeenCalled();
});
test('cancelling a progressive download deletes its partial copy and never opens it', async () => {
  setup(); const stream = streamFixture();
  respond(serverA.url, `${fileRoot}/${record.id}`, (request) => ({ ...stream.reply(request), headers: new Headers({ 'Content-Type': 'text/markdown', 'Content-Length': '3' }) } as Response));
  await mount(); fireEvent.press(screen.getByLabelText('Abrir informe.md'));
  await waitFor(() => expect(stream.reader.read).toHaveBeenCalled());
  await act(async () => { stream.emit('a'); });
  expect(await screen.findByText(/DESCARGANDO/)).toBeVisible();
  fireEvent.press(screen.getByLabelText('Cancelar descarga de informe.md'));
  await waitFor(() => expect(screen.getByLabelText('Abrir informe.md')).toBeEnabled());
  expect([...localFiles.keys()].some((uri) => uri.includes('.part'))).toBe(false); expect(intentLauncher.startActivityAsync).not.toHaveBeenCalled();
});

test('a failed file catalog preserves protected examples and offers a single retry', async () => {
  setup();
  const history = { sessionId: conversationA.sessionId, conversation: conversationA, items: [{ kind: 'assistant', id: 'assistant-files', text: 'Ejemplo: `MEDIA:/ejemplo/archivo.md`', at: clockStart }] };
  respond(serverA.url, `${root}/transcript`, json(history)); respond(serverA.url, `${root}/transcript?sessionId=${conversationA.sessionId}`, json(history));
  respond(serverA.url, `${fileRoot}?limit=50&offset=0`, json({ error: { code: 'chat_unavailable', message: 'Unavailable' } }, 503));
  const app = renderApp(<ChatScreen serverId="A" agentId="agentA" />); await app.ready();
  await screen.findByText('No se pudieron cargar los archivos. Reintenta.');
  expect(screen.getByText(/MEDIA:\/ejemplo\/archivo.md/)).toBeVisible();
  expect(intentLauncher.startActivityAsync).not.toHaveBeenCalled();
  expect(sharing.shareAsync).not.toHaveBeenCalled();
  expect(screen.getAllByText('Reintentar')).toHaveLength(1);
  respond(serverA.url, `${fileRoot}?limit=50&offset=0`, json({ files: [record], displayMessages: [{ messageId: 'assistant-files', text: 'Aquí está.' }], nextOffset: null }));
  fireEvent.press(screen.getByText('Reintentar')); await screen.findByText('informe.md');
});

test('image previews use the finished local copy and files cannot attach to another assistant ID', async () => {
  setup([{ ...record, name: 'cobertura.png', mimeType: 'image/png' }, { ...record, id: 'wrong-message', messageId: 'unrelated-assistant', name: 'otro.md' }]);
  respond(serverA.url, `${fileRoot}/${record.id}`, binary(new Uint8Array([1, 2, 3]), 'image/png'));
  const app = renderApp(<ChatScreen serverId="A" agentId="agentA" />); await app.ready();
  await screen.findByLabelText('Abrir cobertura.png'); expect(screen.queryByText('otro.md')).toBeNull();
  fireEvent.press(screen.getByLabelText('Abrir cobertura.png'));
  await waitFor(() => expect(screen.getByLabelText('Vista previa de cobertura.png')).toHaveProp('source', { uri: expect.stringMatching(new RegExp('^file://')) }));
  expect(intentLauncher.startActivityAsync.mock.calls[0][1]).toMatchObject({ data: expect.stringMatching(new RegExp('^content://')) });
});
test('leaving chat aborts an unfinished download and deletes partial bytes', async () => {
  setup(); const stream = streamFixture();
  respond(serverA.url, `${fileRoot}/${record.id}`, (request) => ({ ...stream.reply(request), headers: new Headers({ 'Content-Type': 'text/markdown', 'Content-Length': '3' }) } as Response));
  const app = await mount(); fireEvent.press(screen.getByLabelText('Compartir informe.md'));
  await waitFor(() => expect(stream.reader.read).toHaveBeenCalled()); await act(async () => { stream.emit('a'); });
  app.unmount();
  await waitFor(() => expect([...localFiles.keys()].some((uri) => uri.includes('.part'))).toBe(false));
  expect(sharing.shareAsync).not.toHaveBeenCalled();
});

test('expired tickets refresh metadata and require a new explicit action with the renewed ticket', async () => {
  setup(); await mount();
  respond(serverA.url, `${fileRoot}/${record.id}`, json({ error: { code: 'file_ticket_expired', message: 'Actualiza la lista de archivos.' } }, 404));
  respond(serverA.url, `${fileRoot}?limit=50&offset=0`, json({ files: [{ ...record, id: 'renewed-file' }], displayMessages: [{ messageId: 'assistant-files', text: 'Aquí está.' }], nextOffset: null }));
  respond(serverA.url, `${fileRoot}/renewed-file`, binary(new Uint8Array([1, 2, 3]), 'text/markdown'));
  fireEvent.press(screen.getByLabelText('Abrir informe.md'));
  await screen.findByText('La lista de archivos se actualizó. Vuelve a abrir o compartir el archivo.');
  await waitFor(() => expect(requestsFor(serverA.url, `${fileRoot}?limit=50&offset=0`)).toHaveLength(2));
  expect(screen.queryByText('YA NO ESTÁ EN EL SERVIDOR')).toBeNull();
  expect(requestsFor(serverA.url, `${fileRoot}/renewed-file`)).toHaveLength(0);
  expect(intentLauncher.startActivityAsync).not.toHaveBeenCalled();
  await waitFor(() => expect([...localFiles.keys()].some((uri) => uri.includes('.part'))).toBe(false));
  fireEvent.press(screen.getByLabelText('Abrir informe.md'));
  await waitFor(() => expect(intentLauncher.startActivityAsync).toHaveBeenCalled());
  expect(requestsFor(serverA.url, `${fileRoot}/renewed-file`)).toHaveLength(1);
});

test.each(['media:', 'mEdIa:', 'MEDİA:', 'MEDıA:'])('case-insensitive marker %s triggers the authoritative catalog without a second parser', async (marker) => {
  setup();
  const history = { sessionId: conversationA.sessionId, conversation: conversationA, items: [{ kind: 'assistant', id: 'assistant-files', text: `Listo. ${marker}/fixture/informe.md`, at: clockStart }] };
  respond(serverA.url, `${root}/transcript`, json(history)); respond(serverA.url, `${root}/transcript?sessionId=${conversationA.sessionId}`, json(history));
  await mount(); expect(screen.getByLabelText('Abrir informe.md')).toBeVisible();
  expect(requestsFor(serverA.url, `${fileRoot}?limit=50&offset=0`)).toHaveLength(1);
});
