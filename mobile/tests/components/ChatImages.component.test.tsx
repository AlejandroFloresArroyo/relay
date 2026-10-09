import { act, cleanupAsync, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { ChatScreen } from '@/screens/ChatScreen';
import { agentA, conversationA, polling, seed, serverA, serverInfo } from '../support/fixtures';
import { configureImageStorage, imageFiles, imagePicker, imageResult } from '../support/images';
import { deferred } from '../support/native';
import { renderApp } from '../support/renderApp';
import { json, requestsFor, respond, streamFixture } from '../support/transport';

const transcript = '/v1/agents/agentA/transcript';
const runPath = '/v1/agents/agentA/runs';
const history = { sessionId: conversationA.sessionId, conversation: conversationA, items: [{ kind: 'assistant', id: 'history', text: 'Historial de imágenes', at: 1791028800000 }] };
function setup() {
  seed(); polling(serverA, [agentA]); respond(serverA.url, '/v1/server', json(serverInfo));
  respond(serverA.url, transcript, json(history)); respond(serverA.url, `${transcript}?sessionId=${conversationA.id}`, json(history));
  configureImageStorage();
}
async function mount() {
  const app = renderApp(<ChatScreen serverId="A" agentId="agentA" />); await app.ready(); await screen.findByText('Historial de imágenes'); return app;
}
async function gallery() {
  imagePicker.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///fixture/gallery/photo.jpg', type: 'image', width: 4000, height: 3000 }] });
  imageResult();
  fireEvent.press(screen.getByLabelText('Adjuntar imagen'));
  expect(screen.getByText('Cámara')).toBeVisible(); expect(screen.getByText('Galería')).toBeVisible();
  await act(async () => { fireEvent.press(screen.getByText('Galería')); });
  await screen.findByText('1 IMAGEN ADJUNTA');
}
test('Gallery chooses only images, reduces and copies locally, sends to the current Conversation and persists the received thumbnail after reopening', async () => {
  setup(); await mount(); await gallery();
  expect(imagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(expect.objectContaining({ mediaTypes: ['images'], allowsMultipleSelection: false }));
  const preview = screen.getByLabelText('Imagen adjunta');
  const localUri = preview.props.source.uri;
  expect(localUri).toMatch(/^file:\/\/\/fixture\/documents\/relay-images\/img-/);
  expect(imageFiles.has(localUri)).toBe(true);
  respond(serverA.url, runPath, json({ runId: 'image-run', sessionId: conversationA.id, conversationId: conversationA.id, inputMessageId: 'stored-image-message' }), 'POST');
  const stream = streamFixture(); respond(serverA.url, '/v1/runs/image-run/events', stream.reply);
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Describe la foto');
  await act(async () => { fireEvent.press(screen.getByLabelText('Enviar')); });
  await waitFor(() => expect(requestsFor(serverA.url, runPath)).toHaveLength(1));
  expect(requestsFor(serverA.url, runPath)[0].body).toEqual({ input: 'Describe la foto', sessionId: conversationA.id, clientMessageId: expect.any(String), images: [{ attachmentId: expect.any(String), mimeType: 'image/jpeg', dataBase64: '/9j/', width: 1600, height: 1200 }] });
  expect(screen.queryByText('1 IMAGEN ADJUNTA')).toBeNull();
  expect(screen.getByLabelText('Imagen enviada').props.source.uri).toBe(localUri);
  await waitFor(() => expect(stream.reader.read).toHaveBeenCalled());
  await act(async () => { stream.emit('id: 0\ndata: {"type":"run.completed","output":"Una foto"}\n\n'); });
  await screen.findByText('Una foto');
  await cleanupAsync();
  respond(serverA.url, transcript, json({ ...history, items: [{ kind: 'user', id: 'stored-image-message', text: 'Describe la foto', at: 1791028800000 }] }));
  const reopened = renderApp(<ChatScreen serverId="A" agentId="agentA" />); await reopened.ready();
  await screen.findByLabelText('Imagen enviada');
  expect(screen.getByLabelText('Imagen enviada').props.source.uri).toBe(localUri);
  expect(requestsFor(serverA.url, runPath)).toHaveLength(1);
});

test('denied camera permission opens no camera, canceled selection sends nothing, and removal deletes the local pending copy', async () => {
  setup(); await mount();
  imagePicker.requestCameraPermissionsAsync.mockResolvedValue({ granted: false });
  fireEvent.press(screen.getByLabelText('Adjuntar imagen'));
  await act(async () => { fireEvent.press(screen.getByText('Cámara')); });
  await screen.findByText(/Relay necesita acceso a la cámara/);
  expect(imagePicker.launchCameraAsync).not.toHaveBeenCalled();
  imagePicker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });
  fireEvent.press(screen.getByLabelText('Adjuntar imagen'));
  await act(async () => { fireEvent.press(screen.getByText('Galería')); });
  expect(screen.queryByText('1 IMAGEN ADJUNTA')).toBeNull();
  expect(requestsFor(serverA.url, runPath)).toHaveLength(0);
  await gallery(); const uri = screen.getByLabelText('Imagen adjunta').props.source.uri;
  await act(async () => { fireEvent.press(screen.getByLabelText('Quitar imagen')); });
  expect(screen.queryByText('1 IMAGEN ADJUNTA')).toBeNull();
  expect(imageFiles.has(uri)).toBe(false);
});

test('a pending image reduction blocks sending and duplicate pickers, and an HTTP rejection retains image and edited draft', async () => {
  setup(); await mount();
  imagePicker.requestCameraPermissionsAsync.mockResolvedValue({ granted: true });
  const selection = deferred<unknown>(); imagePicker.launchCameraAsync.mockReturnValue(selection.promise);
  imageResult();
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Mira esta foto');
  fireEvent.press(screen.getByLabelText('Adjuntar imagen'));
  await act(async () => { fireEvent.press(screen.getByText('Cámara')); });
  expect(screen.getByText('PREPARANDO IMAGEN…')).toBeVisible();
  expect(screen.getByLabelText('Enviar')).toBeDisabled();
  fireEvent.press(screen.getByLabelText('Adjuntar imagen')); fireEvent.press(screen.getByLabelText('Enviar'));
  expect(imagePicker.launchCameraAsync).toHaveBeenCalledTimes(1); expect(requestsFor(serverA.url, runPath)).toHaveLength(0);
  await act(async () => { selection.resolve({ canceled: false, assets: [{ uri: 'file:///fixture/camera/photo.jpg', type: 'image', width: 4000, height: 3000 }] }); });
  const uri = screen.getByLabelText('Imagen adjunta').props.source.uri;
  const rejected = deferred<Response>(); respond(serverA.url, runPath, rejected.promise, 'POST');
  await act(async () => { fireEvent.press(screen.getByLabelText('Enviar')); });
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Borrador posterior');
  await act(async () => { rejected.resolve(json({ error: { code: 'invalid_image', message: 'Esta imagen no se pudo enviar.' } }, 400)); });
  await screen.findByText('Esta imagen no se pudo enviar.');
  expect(screen.getByLabelText('Imagen adjunta').props.source.uri).toBe(uri);
  expect(screen.getByPlaceholderText('Mensaje a Agente A…')).toHaveProp('value', 'Borrador posterior');
  expect(screen.queryByLabelText('Imagen enviada')).toBeNull();
});

test('an image-only Turn keeps its local thumbnail, and a later run.input receipt binds it to the stored message ID', async () => {
  setup(); await mount(); await gallery();
  const uri = screen.getByLabelText('Imagen adjunta').props.source.uri;
  respond(serverA.url, runPath, json({ runId: 'image-only-run', sessionId: conversationA.id, conversationId: conversationA.id, inputMessageId: null }), 'POST');
  const stream = streamFixture(); respond(serverA.url, '/v1/runs/image-only-run/events', stream.reply);
  await act(async () => { fireEvent.press(screen.getByLabelText('Enviar')); });
  const request = requestsFor(serverA.url, runPath)[0].body as { clientMessageId: string; input: string; images: unknown[] };
  expect(request.input).toBe(''); expect(request.images).toHaveLength(1);
  expect(screen.getByLabelText('Imagen enviada').props.source.uri).toBe(uri);
  await waitFor(() => expect(stream.reader.read).toHaveBeenCalled());
  await act(async () => { stream.emit(`id: 0\ndata: ${JSON.stringify({ type: 'run.input', clientMessageId: request.clientMessageId, messageId: 'db-image-only', sessionId: conversationA.id })}\n\n`); });
  await act(async () => { stream.emit('id: 1\ndata: {"type":"run.completed","output":"Imagen descrita"}\n\n'); });
  await screen.findByText('Imagen descrita');
  await cleanupAsync();
  respond(serverA.url, transcript, json({ ...history, items: [{ kind: 'user', id: 'db-image-only', text: '', at: 1791028800000 }] }));
  const reopened = renderApp(<ChatScreen serverId="A" agentId="agentA" />); await reopened.ready();
  await screen.findByLabelText('Imagen enviada');
  expect(screen.getByLabelText('Imagen enviada').props.source.uri).toBe(uri);
});

test('a photo returned after leaving the chat is discarded and does not appear in the next opened chat', async () => {
  setup(); const app = await mount();
  const pending = deferred<unknown>(); imagePicker.launchImageLibraryAsync.mockReturnValue(pending.promise); imageResult();
  fireEvent.press(screen.getByLabelText('Adjuntar imagen'));
  await act(async () => { fireEvent.press(screen.getByText('Galería')); });
  expect(screen.getByText('PREPARANDO IMAGEN…')).toBeVisible();
  await cleanupAsync();
  await act(async () => { pending.resolve({ canceled: false, assets: [{ uri: 'file:///fixture/gallery/late.jpg', type: 'image', width: 4000, height: 3000 }] }); });
  expect([...imageFiles.keys()].filter((uri) => uri.includes('/relay-images/img-'))).toEqual([]);
  expect(requestsFor(serverA.url, runPath)).toHaveLength(0);
});

test('native preparation failures hide payload details and oversized photos never reach the Turn request', async () => {
  setup(); await mount();
  imagePicker.launchImageLibraryAsync.mockRejectedValue(new Error('data:image/png;base64,private-image-bytes'));
  fireEvent.press(screen.getByLabelText('Adjuntar imagen'));
  await act(async () => { fireEvent.press(screen.getByText('Galería')); });
  await screen.findByText('Esta imagen no se puede preparar o guardar. Elige otra y revisa el espacio del teléfono.');
  expect(screen.queryByText(/private-image-bytes/)).toBeNull();
  imagePicker.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///fixture/gallery/large.jpg', type: 'image', width: 4000, height: 3000 }] });
  imageResult('/9j/' + 'AAAA'.repeat(700000));
  fireEvent.press(screen.getByLabelText('Adjuntar imagen'));
  await act(async () => { fireEvent.press(screen.getByText('Galería')); });
  await screen.findByText('La imagen sigue siendo demasiado grande. Elige otra imagen más pequeña.');
  expect(screen.queryByText('1 IMAGEN ADJUNTA')).toBeNull();
  expect(requestsFor(serverA.url, runPath)).toHaveLength(0);
});


test('an image selected before the first Conversation survives a rejected Turn and retries from the created Conversation', async () => {
  setup(); respond(serverA.url, transcript, json({ sessionId: null, conversation: null, items: [] }));
  const created = { ...conversationA, id: 'first-image-conversation', sessionId: 'first-image-conversation', title: null, messageCount: 0 };
  respond(serverA.url, '/v1/agents/agentA/conversations', json(created, 201), 'POST');
  respond(serverA.url, runPath, json({ error: { code: 'invalid_image', message: 'Rechazo de imagen de prueba' } }, 400), 'POST');
  const app = renderApp(<ChatScreen serverId="A" agentId="agentA" />); await app.ready();
  await screen.findByText('Escribe el primer mensaje o crea una conversación nueva.');
  await gallery(); const uri = screen.getByLabelText('Imagen adjunta').props.source.uri;
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Primera foto');
  await act(async () => { fireEvent.press(screen.getByLabelText('Enviar')); });
  await screen.findByText('Rechazo de imagen de prueba');
  expect(screen.getByLabelText('Imagen adjunta').props.source.uri).toBe(uri);
  expect(imageFiles.has(uri)).toBe(true);
  respond(serverA.url, runPath, json({ runId: 'retried-image-run', sessionId: created.id, conversationId: created.id, inputMessageId: 'retried-image-input' }), 'POST');
  const stream = streamFixture(); respond(serverA.url, '/v1/runs/retried-image-run/events', stream.reply);
  await act(async () => { fireEvent.press(screen.getByLabelText('Enviar')); });
  await waitFor(() => expect(stream.reader.read).toHaveBeenCalled());
  const sent = requestsFor(serverA.url, runPath);
  expect(sent).toHaveLength(2);
  expect(sent[1].body).toEqual(expect.objectContaining({ input: 'Primera foto', sessionId: created.id, images: (sent[0].body as { images: unknown[] }).images }));
  expect(requestsFor(serverA.url, '/v1/agents/agentA/conversations')).toHaveLength(1);
  expect(screen.queryByLabelText('Imagen adjunta')).toBeNull();
  expect(screen.getByLabelText('Imagen enviada').props.source.uri).toBe(uri);
});


test('leaving during image send preserves the accepted copy and stores its receipt for reopening', async () => {
  setup(); await mount(); await gallery();
  const uri = screen.getByLabelText('Imagen adjunta').props.source.uri;
  const accepted = deferred<Response>(); respond(serverA.url, runPath, accepted.promise, 'POST');
  fireEvent.changeText(screen.getByPlaceholderText('Mensaje a Agente A…'), 'Foto al salir');
  await act(async () => { fireEvent.press(screen.getByLabelText('Enviar')); });
  await waitFor(() => expect(requestsFor(serverA.url, runPath)).toHaveLength(1));
  await cleanupAsync();
  expect(imageFiles.has(uri)).toBe(true);
  await act(async () => { accepted.resolve(json({ runId: 'left-image-run', sessionId: conversationA.id, conversationId: conversationA.id, inputMessageId: 'left-image-input' })); });
  await waitFor(() => expect([...imageFiles.keys()].some((path) => path.includes('receipts-'))).toBe(true));
  respond(serverA.url, transcript, json({ ...history, items: [{ kind: 'user', id: 'left-image-input', text: 'Foto al salir', at: 1791028800000 }] }));
  const reopened = renderApp(<ChatScreen serverId="A" agentId="agentA" />); await reopened.ready();
  await screen.findByLabelText('Imagen enviada');
  expect(screen.getByLabelText('Imagen enviada').props.source.uri).toBe(uri);
  expect(requestsFor(serverA.url, runPath)).toHaveLength(1);
});


test.each([
  { status: 400, code: 'invalid_image', keep: false },
  { status: 400, code: 'model_not_configured', keep: false },
  { status: 409, code: 'conversation_busy', keep: false },
  { status: 503, code: 'operation_uncertain', keep: true },
])('leaving after $code retains only copies whose acceptance is uncertain', async ({ status, code, keep }) => {
  setup(); await mount(); await gallery();
  const uri = screen.getByLabelText('Imagen adjunta').props.source.uri;
  respond(serverA.url, runPath, json({ error: { code, message: 'Resultado del envío de prueba' } }, status), 'POST');
  await act(async () => { fireEvent.press(screen.getByLabelText('Enviar')); });
  await screen.findByText('Resultado del envío de prueba');
  expect(screen.getByLabelText('Imagen adjunta').props.source.uri).toBe(uri);
  await cleanupAsync();
  expect(imageFiles.has(uri)).toBe(keep);
});


test('leaving before Conversation creation completes discards the unsent image without creating a Turn', async () => {
  setup(); respond(serverA.url, transcript, json({ sessionId: null, conversation: null, items: [] }));
  const creation = deferred<Response>(); respond(serverA.url, '/v1/agents/agentA/conversations', creation.promise, 'POST');
  const app = renderApp(<ChatScreen serverId="A" agentId="agentA" />); await app.ready();
  await screen.findByText('Escribe el primer mensaje o crea una conversación nueva.');
  await gallery(); const uri = screen.getByLabelText('Imagen adjunta').props.source.uri;
  await act(async () => { fireEvent.press(screen.getByLabelText('Enviar')); });
  await waitFor(() => expect(requestsFor(serverA.url, '/v1/agents/agentA/conversations')).toHaveLength(1));
  await cleanupAsync();
  const created = { ...conversationA, id: 'left-before-run', sessionId: 'left-before-run', title: null, messageCount: 0 };
  await act(async () => { creation.resolve(json(created, 201)); });
  await waitFor(() => expect(imageFiles.has(uri)).toBe(false));
  expect(requestsFor(serverA.url, runPath)).toHaveLength(0);
});
