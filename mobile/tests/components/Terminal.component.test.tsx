import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { LockGate } from '@/screens/LockGate';
import { ServerToolsScreen } from '@/screens/ServerToolsScreen';
import { clipboard } from '../support/clipboard';
import { health, polling, seed, serverA, settings } from '../support/fixtures';
import { biometrics, clockStart, emitAppState } from '../support/native';
import { renderApp } from '../support/renderApp';
import { passedProps, surface } from '../support/terminalSurface';
import { json, requests, respond, streamCount, streamFixture, type RequestRecord } from '../support/transport';

// The Terminal tool with the real LockGate, AppProvider, poll, remote access, capability negotiation,
// terminal session and terminals client. Doubles: the system verification, the clock, the transport
// and the WebView that hosts xterm (tests/support/terminalSurface.tsx).
const V1 = { version: 1, minAppVersion: 1 };
const ID = 'env_' + 'T'.repeat(22);
const ID2 = 'env_' + 'U'.repeat(22);
const CHANNEL = 'c'.repeat(22);
const URL = serverA.url;
const terminal = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: 'terminal', ownership: 'own', createdAt: clockStart, state: 'running', terminal: { shell: '/usr/bin/zsh', cwd: '/home/ana/relay' }, ...extra,
});
const b64 = (text: string) => Buffer.from(text).toString('base64');
const remoteRequests = () => requests.filter((r) => r.path.startsWith('/v1/remote/') && r.path !== '/v1/remote/status');
const posts = (path: string) => requests.filter((r) => r.method === 'POST' && r.path === path);

function serve(list: unknown[]) {
  respond(URL, '/health', json({ ...health, capabilities: { environments: V1, terminal: V1 } }));
  respond(URL, '/v1/remote/status', json({ serverNow: clockStart, terminal: { state: 'available' } }));
  respond(URL, '/v1/remote/environments', json({ environments: list }));
  respond(URL, '/v1/remote/shells', json({ shells: ['/bin/bash', '/usr/bin/zsh'], defaultShell: '/usr/bin/zsh', home: '/home/ana' }));
  for (const id of [ID, ID2]) {
    for (const action of ['ack', 'resize']) respond(URL, `/v1/remote/terminals/${id}/${action}`, json({ ok: true }), 'POST');
    respond(URL, `/v1/remote/terminals/${id}/input`, (r: RequestRecord) => json({ inputSeq: (r.body as { seq: number }).seq }), 'POST');
  }
}
function output(id: string) {
  const stream = streamFixture();
  respond(URL, `/v1/remote/terminals/${id}/output`, (request: RequestRecord) => stream.reply(request));
  return { ...stream, send: (event: object) => stream.emit(`${'seq' in event ? `id: ${(event as { seq: number }).seq}\n` : ''}data: ${JSON.stringify(event)}\n\n`) };
}
const settle = () => act(async () => { await jest.advanceTimersByTimeAsync(10); });

async function setup(list: unknown[]) {
  seed([serverA], { ...settings, faceid: true, autoLockMs: 60_000 });
  polling(serverA);
  serve(list);
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  const app = renderApp(<LockGate><ServerToolsScreen serverId={serverA.id} /></LockGate>);
  await app.ready();
  await waitFor(() => expect(screen.getByText('PON TU HUELLA PARA ENTRAR')).toBeVisible());
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  await act(async () => { fireEvent.press(screen.getByLabelText('Entrar con huella')); });
  await settle();
  return app;
}

test('a new terminal opens with the chosen shell and folder; keys, a multi-line paste and the size go straight to it', async () => {
  const stream = output(ID);
  respond(URL, '/v1/remote/environments', (r: RequestRecord) => r.method === 'POST' ? json(terminal(ID, { terminal: { shell: '/bin/bash', cwd: '/home/ana/web' } })) : json({ environments: [] }), 'POST');
  await setup([]);
  // No terminal yet: the new one is offered, never created by itself.
  await waitFor(() => expect(screen.getByText('Nueva terminal')).toBeVisible());
  expect(posts('/v1/remote/environments')).toEqual([]);
  expect(screen.getByLabelText('Carpeta de la terminal').props.value).toBe('/home/ana');
  fireEvent.press(screen.getByLabelText('Shell /bin/bash'));
  fireEvent.changeText(screen.getByLabelText('Carpeta de la terminal'), '/home/ana/web');
  await act(async () => { fireEvent.press(screen.getByText('Abrir terminal')); });
  await settle();

  const [created] = posts('/v1/remote/environments');
  expect(created!.body).toEqual({ requestId: expect.stringMatching(/^[A-Za-z0-9_-]{8,128}$/), kind: 'terminal', shell: '/bin/bash', cwd: '/home/ana/web' });
  expect(created!.headers.get('X-Relay-Capability')).toBe('environments/1');
  const opened = requests.find((r) => r.path === `/v1/remote/terminals/${ID}/output`)!;
  expect(opened.headers.get('X-Relay-Capability')).toBe('terminal/1');
  expect(opened.headers.get('Last-Event-ID')).toBe('0');
  expect(screen.getByLabelText('Terminal bash · ~/web')).toBeVisible();

  await act(async () => {
    stream.send({ type: 'open', channel: CHANNEL, inputSeq: 4 });
    stream.send({ type: 'output', seq: 1, data: b64('ana@atlas:~/web$ ') });
  });
  await settle();
  expect(screen.getByText('CONECTADA')).toBeVisible();
  expect(surface().text).toBe('ana@atlas:~/web$ ');
  expect(posts(`/v1/remote/terminals/${ID}/resize`).map((r) => r.body)).toEqual([{ cols: 80, rows: 24 }]);

  // Esc, Ctrl-C, an arrow and a Spanish word, as the page sends them; then a paste of two lines.
  await act(async () => { await surface().props.write('\x1b'); });
  await settle();
  await act(async () => { await surface().props.write('\x03\x1b[Acanción'); });
  await settle();
  clipboard.getStringAsync.mockResolvedValueOnce('echo uno\necho dos');
  expect(await surface().props.paste()).toBe('echo uno\necho dos');
  await act(async () => { await surface().props.write('echo uno\recho dos'); });
  await settle();
  const sent = posts(`/v1/remote/terminals/${ID}/input`).map((r) => r.body as { seq: number; data: string });
  expect(sent.map((b) => b.seq)).toEqual([5, 6, 7]);
  expect(sent.map((b) => Buffer.from(b.data, 'base64').toString())).toEqual(['\x1b', '\x03\x1b[Acanción', 'echo uno\recho dos']);
  // Nothing about the Servidor or the key crosses into the page: only bytes, sizes and the clipboard.
  expect([...passedProps].sort()).toEqual(['colors', 'copy', 'dom', 'input', 'onMods', 'paste', 'pull', 'resize', 'taps', 'write']);
});

test('existing terminals come back as tabs; switching tab or tool keeps each one open; ended ones show their state without a new one', async () => {
  const first = output(ID);
  const second = output(ID2);
  const EXITED = 'env_' + 'X'.repeat(22);
  respond(URL, `/v1/remote/environments/${EXITED}`, json({ ok: true }), 'DELETE');
  await setup([
    terminal(ID), terminal(ID2, { terminal: { shell: '/bin/bash', cwd: '/srv' } }),
    terminal(EXITED, { state: 'exited', exitCode: 3, endedAt: clockStart, terminal: { shell: '/usr/bin/zsh', cwd: '/home/ana/x' } }),
    terminal('env_' + 'Y'.repeat(22), { state: 'lost', endedAt: clockStart, terminal: { shell: '/usr/bin/zsh', cwd: '/home/ana/y' } }),
  ]);
  // The newest live one is shown; the others wait as tabs.
  await waitFor(() => expect(screen.getByLabelText('Terminal bash · /srv')).toBeVisible());
  await act(async () => { second.send({ type: 'open', channel: CHANNEL, inputSeq: 0 }); second.send({ type: 'output', seq: 9, data: b64('srv$ ') }); });
  await settle();
  expect(surface().text).toBe('srv$ ');

  fireEvent.press(screen.getByLabelText('Terminal zsh · ~/relay'));
  await settle();
  await act(async () => { first.send({ type: 'open', channel: CHANNEL, inputSeq: 0 }); first.send({ type: 'output', seq: 2, data: b64('relay$ ') }); });
  await settle();
  expect(surface().text).toBe('relay$ ');

  // Another tool and back, and the other tab and back: no stream is opened again.
  fireEvent.press(screen.getByLabelText('Archivos'));
  fireEvent.press(screen.getByLabelText('Terminal'));
  fireEvent.press(screen.getByLabelText('Terminal bash · /srv'));
  fireEvent.press(screen.getByLabelText('Terminal zsh · ~/relay'));
  await settle();
  expect(requests.filter((r) => r.path.endsWith('/output')).map((r) => r.path)).toEqual([`/v1/remote/terminals/${ID2}/output`, `/v1/remote/terminals/${ID}/output`]);
  expect(streamCount()).toBe(2);

  // An ended terminal and a lost one: their state, no stream, no replacement.
  fireEvent.press(screen.getByLabelText('Terminal zsh · ~/y'));
  await settle();
  expect(screen.getByText('NO RECUPERABLE')).toBeVisible();
  expect(screen.getByText('El Servidor perdió esta terminal, por ejemplo al reiniciarse. No se puede reconectar.')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Terminal zsh · ~/x'));
  await settle();
  expect(screen.getByText('TERMINADA · CÓDIGO 3')).toBeVisible();
  expect(requests.filter((r) => r.path.endsWith('/output'))).toHaveLength(2);
  expect(posts('/v1/remote/environments')).toEqual([]);

  // Quitar removes the ended one from the list on the Servidor.
  respond(URL, '/v1/remote/environments', json({ environments: [terminal(ID), terminal(ID2, { terminal: { shell: '/bin/bash', cwd: '/srv' } })] }));
  await act(async () => { fireEvent.press(screen.getByLabelText('Quitar de la lista')); });
  await settle();
  expect(requests.filter((r) => r.method === 'DELETE').map((r) => r.path)).toEqual([`/v1/remote/environments/${EXITED}`]);
  expect(screen.queryByLabelText('Terminal zsh · ~/x')).toBeNull();
});

test('a lost stream shows the loss and resumes after the last frame without touching the program', async () => {
  const stream = output(ID);
  await setup([terminal(ID)]);
  await settle();
  await act(async () => { stream.send({ type: 'open', channel: CHANNEL, inputSeq: 2 }); stream.send({ type: 'output', seq: 7, data: b64('uno') }); });
  await settle();
  const before = remoteRequests().length;
  await act(async () => { stream.fail(); });
  await settle();
  expect(screen.getByText('RECONECTANDO…')).toBeVisible();
  expect(screen.getByText(/La terminal sigue en el Servidor/)).toBeVisible();
  // Typed while not connected: dropped, never sent later.
  await act(async () => { await surface().props.write('rm -rf x\r'); });
  const again = output(ID);
  await act(async () => { await jest.advanceTimersByTimeAsync(1000); });
  const reopened = requests.filter((r) => r.path.endsWith('/output')).at(-1)!;
  expect(reopened.headers.get('Last-Event-ID')).toBe('7');
  await act(async () => { again.send({ type: 'open', channel: 'd'.repeat(22), inputSeq: 2 }); again.send({ type: 'output', seq: 8, data: b64(' dos') }); });
  await settle();
  expect(screen.getByText('CONECTADA')).toBeVisible();
  expect(surface().text).toBe('uno dos');
  const between = remoteRequests().slice(before);
  expect(between.filter((r) => r.path.endsWith('/input') || r.path.endsWith('/terminate'))).toEqual([]);
});

test('terminating asks first, says whose it is and what stops; cancelling terminates nothing', async () => {
  const stream = output(ID);
  respond(URL, `/v1/remote/environments/${ID}/terminate`, json(terminal(ID, { state: 'exited', exitCode: 0, endedAt: clockStart })), 'POST');
  await setup([terminal(ID)]);
  await settle();
  await act(async () => { stream.send({ type: 'open', channel: CHANNEL, inputSeq: 0 }); });
  await settle();
  fireEvent.press(screen.getByLabelText('Terminar terminal'));
  expect(screen.getByText('¿TERMINAR ESTA TERMINAL?')).toBeVisible();
  expect(screen.getByText(/zsh en ~\/relay, en Servidor A\. La abrió este dispositivo: se detienen el shell y todo lo que arrancó dentro/)).toBeVisible();
  fireEvent.press(screen.getByLabelText('Cancelar'));
  await settle();
  expect(screen.queryByText('¿TERMINAR ESTA TERMINAL?')).toBeNull();
  expect(posts(`/v1/remote/environments/${ID}/terminate`)).toEqual([]);

  // From now on the Servidor lists it as ended.
  respond(URL, '/v1/remote/environments', json({ environments: [terminal(ID, { state: 'exited', exitCode: 0, endedAt: clockStart })] }));
  fireEvent.press(screen.getByLabelText('Terminar terminal'));
  await act(async () => { fireEvent.press(screen.getByLabelText('Confirmar terminar')); });
  await settle();
  expect(posts(`/v1/remote/environments/${ID}/terminate`).map((r) => r.body)).toEqual([{ confirm: true }]);
  expect(screen.getByText('Terminada. Se detuvieron el shell y todo lo que arrancó dentro.')).toBeVisible();
  await act(async () => { stream.send({ type: 'closed', reason: 'exited' }); stream.close(); });
  await settle();
  expect(screen.getByText('TERMINADA · CÓDIGO 0')).toBeVisible();
});

test('hiding Relay closes the terminal channel without sending anything; shown again it recovers', async () => {
  const stream = output(ID);
  await setup([terminal(ID)]);
  await settle();
  await act(async () => { stream.send({ type: 'open', channel: CHANNEL, inputSeq: 0 }); stream.send({ type: 'output', seq: 3, data: b64('top') }); });
  await settle();
  expect(streamCount()).toBe(1);
  const before = remoteRequests().length;
  await act(async () => { emitAppState('background'); });
  await settle();
  expect(streamCount()).toBe(0);
  expect(remoteRequests().slice(before)).toEqual([]);

  const again = output(ID);
  await act(async () => { emitAppState('active'); });
  await settle();
  const reopened = requests.filter((r) => r.path.endsWith('/output')).at(-1)!;
  expect(reopened.headers.get('Last-Event-ID')).toBe('0');
  await act(async () => { again.send({ type: 'open', channel: CHANNEL, inputSeq: 0 }); again.send({ type: 'output', seq: 3, data: b64('top') }); });
  await settle();
  expect(surface().text).toBe('top');
});

test('locking Relay closes the terminal channel and hides the terminal without sending anything', async () => {
  const stream = output(ID);
  await setup([terminal(ID)]);
  await settle();
  await act(async () => { stream.send({ type: 'open', channel: CHANNEL, inputSeq: 0 }); });
  await settle();
  const before = remoteRequests().length;
  // The Puente's keepalive every 15 s keeps the stream alive until Relay locks at 60 s.
  for (const step of [15_000, 15_000, 15_000, 16_000]) {
    await act(async () => { stream.emit(': keepalive\n\n'); await jest.advanceTimersByTimeAsync(step); });
  }
  expect(screen.getByText('Relay está bloqueado')).toBeVisible();
  expect(streamCount()).toBe(0);
  expect(screen.queryByLabelText('Pantalla de la terminal')).toBeNull();
  expect(remoteRequests().slice(before)).toEqual([]);
});

test('leaving the tools disconnects the terminal and terminates nothing', async () => {
  const stream = output(ID);
  const app = await setup([terminal(ID)]);
  await settle();
  await act(async () => { stream.send({ type: 'open', channel: CHANNEL, inputSeq: 0 }); });
  await settle();
  const before = remoteRequests().length;
  await act(async () => { app.unmount(); });
  expect(streamCount()).toBe(0);
  expect(remoteRequests().slice(before)).toEqual([]);
});

/** One running terminal with its stream open, as the key tests need it. */
async function connected() {
  const stream = output(ID);
  await setup([terminal(ID)]);
  await waitFor(() => expect(screen.getByLabelText('Terminal zsh · ~/relay')).toBeVisible());
  await act(async () => { stream.send({ type: 'open', channel: CHANNEL, inputSeq: 0 }); stream.send({ type: 'output', seq: 1, data: b64('relay$ ') }); });
  await settle();
  return stream;
}
const typed = () => posts(`/v1/remote/terminals/${ID}/input`).map((r) => Buffer.from((r.body as { data: string }).data, 'base64').toString());

test('Ctrl and Alt stay stuck, with their PEGADA label, until the next key; that key sends the combination and releases them', async () => {
  await connected();
  expect(screen.queryByText('PEGADA')).toBeNull();
  fireEvent.press(screen.getByLabelText('Control'));
  expect(screen.getByLabelText('Control')).toBeSelected();
  expect(screen.getByText('PEGADA')).toBeVisible();
  // Stuck, not sent: nothing leaves until the next key.
  await settle();
  expect(typed()).toEqual([]);
  await act(async () => { surface().type('c'); });
  await settle();
  expect(typed()).toEqual(['\x03']);
  expect(screen.getByLabelText('Control')).not.toBeSelected();
  expect(screen.queryByText('PEGADA')).toBeNull();

  // Alt waits for a key from the bar too, and the arrow goes out with its modifier.
  fireEvent.press(screen.getByLabelText('Alt'));
  expect(screen.getByLabelText('Alt')).toBeSelected();
  fireEvent.press(screen.getByLabelText('Flecha arriba'));
  await settle();
  expect(typed()).toEqual(['\x03', '\x1b[1;3A']);
  expect(screen.getByLabelText('Alt')).not.toBeSelected();
  expect(screen.queryByText('PEGADA')).toBeNull();
});

test('the output sweep shows only while output arrives', async () => {
  const stream = await connected();
  expect(screen.getByText('SALIDA')).toBeVisible();
  expect(screen.getByText('EN CURSO')).toBeVisible();
  // Quiet: the program is not writing.
  await act(async () => { await jest.advanceTimersByTimeAsync(5_000); });
  expect(screen.queryByText('EN CURSO')).toBeNull();
  await act(async () => { stream.send({ type: 'output', seq: 2, data: b64('✓ tests/orders.test.ts\n') }); });
  await settle();
  expect(screen.getByText('EN CURSO')).toBeVisible();
  await act(async () => { await jest.advanceTimersByTimeAsync(5_000); });
  expect(screen.queryByText('EN CURSO')).toBeNull();
});

test('two taps that reach the page in one update are both pressed', async () => {
  await connected();
  // Ctrl and Alt in the same batch: the page gets both, so the combination carries both modifiers.
  act(() => { fireEvent.press(screen.getByLabelText('Control')); fireEvent.press(screen.getByLabelText('Alt')); });
  await act(async () => { surface().type('c'); });
  await settle();
  expect(typed()).toEqual(['\x1b\x03']);
  expect(screen.queryByText('PEGADA')).toBeNull();
});

test('a new terminal surface starts with the keys released: PEGADA never outlives the page that held it', async () => {
  await connected();
  fireEvent.press(screen.getByLabelText('Control'));
  expect(screen.getByText('PEGADA')).toBeVisible();
  // Hiding Relay and coming back opens a new channel and a new page, whose Ctrl is not stuck.
  await act(async () => { emitAppState('background'); });
  await settle();
  const again = output(ID);
  await act(async () => { emitAppState('active'); });
  await settle();
  await act(async () => { again.send({ type: 'open', channel: CHANNEL, inputSeq: 0 }); again.send({ type: 'output', seq: 1, data: b64('relay$ ') }); });
  await settle();
  expect(screen.queryByText('PEGADA')).toBeNull();
  expect(screen.getByLabelText('Control')).not.toBeSelected();
  await act(async () => { surface().type('c'); });
  await settle();
  expect(typed()).toEqual(['c']);
});

test('output frames do not re-render the terminal: the page is re-sent props only when something it shows changes', async () => {
  const stream = await connected();
  const renders = surface().renders;
  await act(async () => { for (let seq = 2; seq < 8; seq++) stream.send({ type: 'output', seq, data: b64(`línea ${seq}\n`) }); });
  await settle();
  expect(surface().text).toContain('línea 7');
  expect(surface().renders).toBe(renders);
});
