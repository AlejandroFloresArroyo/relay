import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { encodeText } from '../../../protocol/textCodec';
import { LockGate } from '@/screens/LockGate';
import { ServerToolsScreen } from '@/screens/ServerToolsScreen';
import { clipboard } from '../support/clipboard';
import { configureLocalFiles, localFiles, pickPhoneFile } from '../support/files';
import { health, polling, seed, serverA, settings } from '../support/fixtures';
import { biometrics, clockStart, deferred } from '../support/native';
import { renderApp } from '../support/renderApp';
import { binary, json, requests, respond, streamFixture, type RequestRecord } from '../support/transport';

// The Archivos tool with the real LockGate, AppProvider, poll, remote access, capability negotiation,
// files core, text codecs and transfer core. Doubles: the system verification, the clock, the
// transport, and the phone's file system and picker (tests/support/files.ts).
const V1 = { version: 1, minAppVersion: 1 };
const URL = serverA.url;
const HOME = '/home/ana';
const CHUNK = 1_048_576;
const OP = 'op_' + 'S'.repeat(22);
const OP2 = 'op_' + 'T'.repeat(22);
const version = (ino: number) => ({ dev: '64', ino: String(ino), mtimeNs: `179000000000000000${ino % 10}`, ctimeNs: '1790000000000000001' });
const content = (ino: number, size: number, mark = 'a') => ({ dev: '64', ino: String(ino), size, mtimeNs: '1790000000000000000', sha256: mark.repeat(64) });
let ino = 10;
const entry = (name: string, type = 'file', extra: Record<string, unknown> = {}) => ({
  name, nameUtf8: true, type, size: 5, mode: type === 'directory' ? 0o755 : 0o644, uid: 1000, gid: 1000, mtime: clockStart, version: version(ino++), ...extra,
});
type Folder = { entries: ReturnType<typeof entry>[]; realPath?: string; protection?: 'profile' | 'bridge' | null };
const posts = (path: string) => requests.filter((r) => r.method === 'POST' && r.path === path);
const remoteRequests = () => requests.filter((r) => r.path.startsWith('/v1/remote/') && r.path !== '/v1/remote/status');
const settle = () => act(async () => { await jest.advanceTimersByTimeAsync(10); });
const text = (bytes: unknown) => Buffer.from(bytes as Uint8Array).toString('latin1');

const PROYECTOS = entry('proyectos', 'directory');
const NOTAS = entry('notas.txt');
const ENLACE = entry('enlace', 'symlink', { size: 10, mode: 0o777, link: { target: '/srv/datos', realPath: '/srv/datos', type: 'directory' } });
const ROTO = entry('roto', 'symlink', { mode: 0o777, link: { target: '/home/ana/borrado', realPath: null, type: null } });
const COLA = entry('cola', 'fifo', { size: 0, mode: 0o600 });
const BASHRC = entry('.bashrc');

function tree(): Record<string, Folder> {
  return {
    [HOME]: { entries: [BASHRC, entry('.hermes', 'directory'), COLA, ENLACE, NOTAS, PROYECTOS, ROTO] },
    [`${HOME}/proyectos`]: { entries: [entry('a.txt')] },
    [`${HOME}/enlace`]: { realPath: '/srv/datos', entries: [entry('dato.csv')] },
    [`${HOME}/.hermes`]: { protection: 'profile', entries: [entry('SOUL.md')] },
  };
}

function serve(folders = tree()) {
  respond(URL, '/health', json({ ...health, capabilities: { environments: V1, terminal: V1, files: V1 } }));
  respond(URL, '/v1/remote/status', json({ serverNow: clockStart, terminal: { state: 'available' }, files: { state: 'available' } }));
  respond(URL, '/v1/remote/environments', json({ environments: [] }));
  respond(URL, '/v1/remote/shells', json({ shells: ['/bin/bash', '/usr/bin/zsh'], defaultShell: '/usr/bin/zsh', home: HOME }));
  respond(URL, '/v1/remote/files/list', (r: RequestRecord) => {
    const body = r.body as { path?: string; hidden: boolean };
    const path = body.path ?? HOME;
    const folder = folders[path];
    if (!folder) return json({ error: { code: 'remote_not_found', message: 'x' } }, 404);
    return json({ path, realPath: folder.realPath ?? path, entries: folder.entries.filter((each) => body.hidden || !each.name.startsWith('.')), truncated: false, protection: folder.protection ?? null });
  }, 'POST');
  respond(URL, `/v1/remote/operations/${OP}/cancel`, json({ id: OP, state: 'cancelled' }), 'POST');
  respond(URL, `/v1/remote/operations/${OP2}/cancel`, json({ id: OP2, state: 'cancelled' }), 'POST');
}

function readable(path: string, bytes: Uint8Array, ino: number, extra: Record<string, unknown> = {}) {
  return { path, realPath: path, version: content(ino, bytes.length), bytes: Buffer.from(bytes).toString('base64'), protection: null, ...extra };
}

async function enter() {
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  await act(async () => { fireEvent.press(screen.getByLabelText('Entrar con huella')); });
  await settle();
  fireEvent.press(screen.getByLabelText('Archivos'));
  await settle();
}

async function setup(folders?: Record<string, Folder>) {
  seed([serverA], { ...settings, faceid: true, autoLockMs: 60_000 });
  polling(serverA);
  serve(folders);
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  const app = renderApp(<LockGate><ServerToolsScreen serverId={serverA.id} /></LockGate>);
  await app.ready();
  await waitFor(() => expect(screen.getByText('PON TU HUELLA PARA ENTRAR')).toBeVisible());
  await enter();
  await waitFor(() => expect(screen.getByLabelText('Abrir notas.txt')).toBeVisible());
  return app;
}

const folderShown = () => screen.getByLabelText('Carpeta actual').props.children;

test('folders, hidden entries, permissions and the real destination of links; special files and broken links say why they do not open', async () => {
  await setup();
  expect(folderShown()).toBe('~');
  expect(posts('/v1/remote/files/list').map((r) => r.body)).toEqual([{ hidden: false }]);
  expect(posts('/v1/remote/files/list')[0]!.headers.get('X-Relay-Capability')).toBe('files/1');
  expect(screen.getByText(/CARPETA · drwxr-xr-x/)).toBeVisible();
  expect(screen.getByText(/FIFO · prw-------/)).toBeVisible();
  expect(screen.getByText('→ /srv/datos')).toBeVisible();
  expect(screen.getByText('→ /home/ana/borrado · ROTO')).toBeVisible();
  expect(screen.queryByText('.bashrc')).toBeNull();

  fireEvent.press(screen.getByLabelText('Mostrar ocultos'));
  await settle();
  expect(posts('/v1/remote/files/list').at(-1)!.body).toEqual({ path: HOME, hidden: true });
  expect(screen.getByText('.bashrc')).toBeVisible();

  fireEvent.press(screen.getByLabelText('Abrir proyectos'));
  await settle();
  expect(posts('/v1/remote/files/list').at(-1)!.body).toEqual({ path: `${HOME}/proyectos`, hidden: true });
  expect(folderShown()).toBe('~/proyectos');
  expect(screen.getByText('a.txt')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Carpeta superior'));
  await settle();
  expect(folderShown()).toBe('~');

  // Entering through a link acts on its destination, and the path bar says where that really is.
  fireEvent.press(screen.getByLabelText('Abrir enlace'));
  await settle();
  expect(posts('/v1/remote/files/list').at(-1)!.body).toEqual({ path: `${HOME}/enlace`, hidden: true });
  expect(folderShown()).toBe('~/enlace');
  expect(screen.getByText('→ /srv/datos')).toBeVisible();
  expect(screen.getByText('dato.csv')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Carpeta superior'));
  await settle();

  fireEvent.press(screen.getByLabelText('Abrir cola'));
  expect(screen.getByText('ARCHIVO ESPECIAL · FIFO')).toBeVisible();
  expect(screen.getByText('No es un archivo regular: Relay no lo abre, no lo edita ni lo transfiere.')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Entendido'));
  fireEvent.press(screen.getByLabelText('Abrir roto'));
  expect(screen.getByText('ENLACE ROTO')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Entendido'));
  expect(posts('/v1/remote/files/read')).toEqual([]);

  // A Hermes profile is signalled before anything is written there.
  fireEvent.press(screen.getByLabelText('Abrir .hermes'));
  await settle();
  expect(screen.getByText('PERFIL DE HERMES')).toBeVisible();
  expect(screen.getByText('Antes de cada cambio aquí, Relay guarda la versión anterior en el Servidor y lo registra.')).toBeVisible();
});

test('deleting asks first: a folder says its content goes, a link says only the link goes; cancelling sends nothing', async () => {
  respond(URL, '/v1/remote/files/delete', json({ ok: true }), 'POST');
  await setup();
  fireEvent.press(screen.getByLabelText('Acciones de proyectos'));
  fireEvent.press(screen.getByLabelText('Borrar'));
  expect(screen.getByText('¿BORRAR CARPETA?')).toBeVisible();
  expect(screen.getByText(/Se borran la carpeta y todo su contenido: sus archivos y subcarpetas\./)).toBeVisible();
  expect(screen.getByText(/No hay papelera: no se puede deshacer\./)).toBeVisible();
  fireEvent.press(screen.getByLabelText('Cancelar'));
  await settle();
  expect(posts('/v1/remote/files/delete')).toEqual([]);

  fireEvent.press(screen.getByLabelText('Acciones de enlace'));
  expect(screen.getByText('SOLO EL ENLACE')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Borrar'));
  expect(screen.getByText('¿BORRAR ENLACE?')).toBeVisible();
  expect(screen.getByText('Se borra solo el enlace. Su destino, /srv/datos, no cambia.')).toBeVisible();
  const before = posts('/v1/remote/files/list').length;
  await act(async () => { fireEvent.press(screen.getByLabelText('Confirmar: Borrar enlace')); });
  await settle();
  expect(posts('/v1/remote/files/delete').map((r) => r.body)).toEqual([{ path: `${HOME}/enlace`, version: ENLACE.version, confirm: true }]);
  expect(posts('/v1/remote/files/list').length).toBe(before + 1);
  expect(screen.getByText('Borrado: enlace.')).toBeVisible();
});

test('a write the Puente refuses shows its fixed reason and keeps the sheet; a changed entry lists the folder again', async () => {
  respond(URL, '/v1/remote/files/delete', json({ error: { code: 'remote_conflict', message: '/home/ana/notas.txt changed' } }, 409), 'POST');
  respond(URL, '/v1/remote/files/create', json({ error: { code: 'remote_profile_protected', message: 'x' } }, 403), 'POST');
  await setup();
  fireEvent.press(screen.getByLabelText('Acciones de notas.txt'));
  fireEvent.press(screen.getByLabelText('Borrar'));
  const before = posts('/v1/remote/files/list').length;
  await act(async () => { fireEvent.press(screen.getByLabelText('Confirmar: Borrar')); });
  await settle();
  expect(screen.getByText('Cambió en el Servidor. Vuelve a cargarlo antes de seguir.')).toBeVisible();
  expect(screen.queryByText(/changed/)).toBeNull();
  expect(posts('/v1/remote/files/list').length).toBe(before + 1);
  fireEvent.press(screen.getByLabelText('Cancelar'));

  fireEvent.press(screen.getByLabelText('Nueva carpeta'));
  fireEvent.changeText(screen.getByLabelText('Nombre'), 'nueva');
  await act(async () => { fireEvent.press(screen.getByText('Crear')); });
  await settle();
  expect(posts('/v1/remote/files/create').map((r) => r.body)).toEqual([{ directory: HOME, name: 'nueva', type: 'directory' }]);
  expect(screen.getByText('Relay protege los perfiles de Hermes. Haz este cambio en la computadora.')).toBeVisible();
});

test('create, rename and move send what the person chose; moving never replaces', async () => {
  respond(URL, '/v1/remote/files/create', json(entry('nueva', 'directory')), 'POST');
  respond(URL, '/v1/remote/files/move', json(entry('x')), 'POST');
  await setup();
  fireEvent.press(screen.getByLabelText('Nuevo archivo'));
  fireEvent.changeText(screen.getByLabelText('Nombre'), 'a/b');
  expect(screen.getByText('El nombre no puede llevar «/».')).toBeVisible();
  fireEvent.changeText(screen.getByLabelText('Nombre'), 'nuevo.md');
  await act(async () => { fireEvent.press(screen.getByText('Crear')); });
  await settle();
  expect(posts('/v1/remote/files/create').map((r) => r.body)).toEqual([{ directory: HOME, name: 'nuevo.md', type: 'file' }]);

  fireEvent.press(screen.getByLabelText('Acciones de notas.txt'));
  fireEvent.press(screen.getByLabelText('Renombrar'));
  expect(screen.getByText('Antes: notas.txt')).toBeVisible();
  fireEvent.changeText(screen.getByLabelText('Nombre'), 'ideas.txt');
  await act(async () => { fireEvent.press(screen.getByText('Guardar')); });
  await settle();

  fireEvent.press(screen.getByLabelText('Acciones de notas.txt'));
  fireEvent.press(screen.getByLabelText('Mover'));
  expect(screen.getByText('MOVIENDO NOTAS.TXT…')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Abrir proyectos'));
  await settle();
  await act(async () => { fireEvent.press(screen.getByLabelText('Mover aquí')); });
  await settle();
  expect(posts('/v1/remote/files/move').map((r) => r.body)).toEqual([
    { path: `${HOME}/notas.txt`, version: NOTAS.version, directory: HOME, name: 'ideas.txt' },
    { path: `${HOME}/notas.txt`, version: NOTAS.version, directory: `${HOME}/proyectos`, name: 'notas.txt' },
  ]);
  expect(screen.getByText('Movido: notas.txt.')).toBeVisible();
});

test('renaming and overwriting act on the folder the person chose from, even if another folder finishes loading with the sheet open', async () => {
  respond(URL, '/v1/remote/files/move', json(entry('ideas.txt')), 'POST');
  respond(URL, '/v1/remote/files/uploads', json({ id: OP, size: 3, received: 0 }), 'POST');
  respond(URL, `/v1/remote/files/uploads/${OP}/0`, json({ id: OP, size: 3, received: 3 }), 'PUT');
  respond(URL, `/v1/remote/files/uploads/${OP}/commit`, json(entry('notas.txt')), 'POST');
  await setup();
  let slow = deferred<Response>();
  const proyectos = () => json({ path: `${HOME}/proyectos`, realPath: `${HOME}/proyectos`, entries: [entry('a.txt')], truncated: false, protection: null });
  respond(URL, '/v1/remote/files/list', (r: RequestRecord) => {
    const path = (r.body as { path?: string }).path ?? HOME;
    return path === HOME ? json({ path, realPath: path, entries: [NOTAS, PROYECTOS], truncated: false, protection: null }) : slow.promise;
  }, 'POST');
  fireEvent.press(screen.getByLabelText('Abrir proyectos'));
  await settle();
  fireEvent.press(screen.getByLabelText('Acciones de notas.txt'));
  fireEvent.press(screen.getByLabelText('Renombrar'));
  fireEvent.changeText(screen.getByLabelText('Nombre'), 'ideas.txt');
  await act(async () => { slow.resolve(proyectos()); });
  await settle();
  expect(folderShown()).toBe('~/proyectos');
  await act(async () => { fireEvent.press(screen.getByText('Guardar')); });
  await settle();
  expect(posts('/v1/remote/files/move').map((r) => r.body)).toEqual([{ path: `${HOME}/notas.txt`, version: NOTAS.version, directory: HOME, name: 'ideas.txt' }]);

  fireEvent.press(screen.getByLabelText('Carpeta superior'));
  await settle();
  slow = deferred<Response>();
  fireEvent.press(screen.getByLabelText('Abrir proyectos'));
  await settle();
  pickPhoneFile('notas.txt', new Uint8Array([1, 2, 3]));
  await act(async () => { fireEvent.press(screen.getByLabelText('Subir del teléfono')); });
  expect(screen.getByText('¿SOBRESCRIBIR?')).toBeVisible();
  await act(async () => { slow.resolve(proyectos()); });
  await settle();
  expect(folderShown()).toBe('~/proyectos');
  await act(async () => { fireEvent.press(screen.getByLabelText('Confirmar: Sobrescribir')); });
  await settle();
  expect(posts('/v1/remote/files/uploads').map((r) => r.body)).toEqual([{ directory: HOME, name: 'notas.txt', size: 3 }]);
});

function saves(answers: (() => Response)[]) {
  const ids = [OP, OP2];
  let count = 0;
  respond(URL, '/v1/remote/files/saves', (r: RequestRecord) => json({ id: ids[count++ % 2], size: (r.body as { size: number }).size, received: 0 }), 'POST');
  for (const id of ids) {
    respond(URL, `/v1/remote/files/saves/${id}/0`, (r: RequestRecord) => json({ id, size: (r.body as Uint8Array).length, received: (r.body as Uint8Array).length }), 'PUT');
    respond(URL, `/v1/remote/files/saves/${id}/commit`, () => answers.shift()!(), 'POST');
  }
}

test('the editor keeps CRLF and the encoding; a change on the Servidor keeps the draft and overwriting needs the version read again and a confirmation', async () => {
  const original = Buffer.from('uno\r\ndos\r\n');
  let reads = 0;
  respond(URL, '/v1/remote/files/read', () => json(readable(`${HOME}/notas.txt`, original, 50, reads++ ? { version: content(50, original.length, 'b') } : {})), 'POST');
  const saved = { path: `${HOME}/notas.txt`, realPath: `${HOME}/notas.txt`, version: content(50, 15, 'c') };
  saves([() => json({ error: { code: 'remote_conflict', message: 'x' } }, 409), () => json(saved)]);
  await setup();
  await act(async () => { fireEvent.press(screen.getByLabelText('Abrir notas.txt')); });
  await settle();
  expect(screen.getByText('UTF-8 · CRLF')).toBeVisible();
  expect(screen.getByLabelText('Texto de notas.txt').props.value).toBe('uno\ndos\n');
  fireEvent.changeText(screen.getByLabelText('Texto de notas.txt'), 'uno\ndos\ntres\n');
  expect(screen.getByText('BORRADOR')).toBeVisible();
  await act(async () => { fireEvent.press(screen.getByText('Guardar')); });
  await settle();

  const put = requests.find((r) => r.method === 'PUT')!;
  expect(text(put.body)).toBe('uno\r\ndos\r\ntres\r\n');
  expect(posts(`/v1/remote/files/saves/${OP}/commit`).map((r) => r.body)).toEqual([{ path: `${HOME}/notas.txt`, version: content(50, 10), format: { encoding: 'utf-8', bom: false } }]);
  // The refused save is released; the draft stays and the person chooses.
  expect(posts(`/v1/remote/operations/${OP}/cancel`)).toHaveLength(1);
  expect(screen.getByText('CAMBIÓ EN EL SERVIDOR')).toBeVisible();
  expect(screen.getByText('BORRADOR')).toBeVisible();

  await act(async () => { fireEvent.press(screen.getByLabelText('Sobrescribir')); });
  await settle();
  expect(posts('/v1/remote/files/read')).toHaveLength(2);
  expect(screen.getByText('¿SOBRESCRIBIR LA VERSIÓN DEL SERVIDOR?')).toBeVisible();
  // Going back sends nothing.
  fireEvent.press(screen.getByLabelText('Cancelar'));
  expect(posts('/v1/remote/files/saves')).toHaveLength(1);
  await act(async () => { fireEvent.press(screen.getByLabelText('Sobrescribir')); });
  await settle();
  await act(async () => { fireEvent.press(screen.getByLabelText('Confirmar: Sobrescribir')); });
  await settle();
  expect(posts(`/v1/remote/files/saves/${OP2}/commit`).map((r) => r.body)).toEqual([{ path: `${HOME}/notas.txt`, version: content(50, 10, 'b'), format: { encoding: 'utf-8', bom: false } }]);
  expect(screen.getByText('Guardado.')).toBeVisible();
  expect(screen.queryByText('BORRADOR')).toBeNull();
});

test('an unsure encoding is a guess with previews to choose from; a character it cannot hold blocks the save until UTF-8 is confirmed', async () => {
  const bytes = encodeText('Informe “final”: café\n', { encoding: 'windows-1252', bom: false }) as Uint8Array;
  respond(URL, '/v1/remote/files/read', json(readable(`${HOME}/notas.txt`, bytes, 51)), 'POST');
  const saved = { path: `${HOME}/notas.txt`, realPath: `${HOME}/notas.txt`, version: content(51, 30, 'd') };
  saves([() => json(saved)]);
  await setup();
  await act(async () => { fireEvent.press(screen.getByLabelText('Abrir notas.txt')); });
  await settle();
  expect(screen.getByText('· CODIFICACIÓN ESTIMADA')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Elegir codificación'));
  expect(screen.getByLabelText('Leer como Windows-1252')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Leer como ISO-8859-1'));
  expect(screen.getByText('ISO-8859-1 · LF')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Elegir codificación'));
  fireEvent.press(screen.getByLabelText('Leer como Windows-1252'));
  expect(screen.getByText('WINDOWS-1252 · LF')).toBeVisible();

  fireEvent.changeText(screen.getByLabelText('Texto de notas.txt'), 'Informe “final”: café\nĀ\n');
  await act(async () => { fireEvent.press(screen.getByText('Guardar')); });
  await settle();
  expect(screen.getByText('NO SE PUEDE GUARDAR SIN PÉRDIDA')).toBeVisible();
  expect(posts('/v1/remote/files/saves')).toEqual([]);
  fireEvent.press(screen.getByLabelText('Cambiar a UTF-8'));
  expect(screen.getByText('¿GUARDAR EN UTF-8?')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Cancelar'));
  expect(posts('/v1/remote/files/saves')).toEqual([]);
  await act(async () => { fireEvent.press(screen.getByText('Guardar')); });
  fireEvent.press(screen.getByLabelText('Cambiar a UTF-8'));
  await act(async () => { fireEvent.press(screen.getByLabelText('Confirmar: Guardar en UTF-8')); });
  await settle();
  const put = requests.find((r) => r.method === 'PUT')!;
  expect(Buffer.from(put.body as Uint8Array).toString('utf8')).toBe('Informe “final”: café\nĀ\n');
  expect((posts(`/v1/remote/files/saves/${OP}/commit`)[0]!.body as { format: unknown }).format).toEqual({ encoding: 'utf-8', bom: false });
  expect(screen.getByText('Guardado en UTF-8.')).toBeVisible();
});

test('mixed line endings, binary content and a file over 5 MiB are not edited, and say so', async () => {
  respond(URL, '/v1/remote/files/read', (r: RequestRecord) => {
    const path = (r.body as { path: string }).path;
    return json(readable(path, path.endsWith('notas.txt') ? Buffer.from('a\r\nb\nc') : Buffer.from([0x89, 0x50, 0x00]), 52));
  }, 'POST');
  await setup({ [HOME]: { entries: [NOTAS, entry('foto.png'), entry('grande.log', 'file', { size: 5 * CHUNK + 1 })] } });
  await act(async () => { fireEvent.press(screen.getByLabelText('Abrir notas.txt')); });
  await settle();
  expect(screen.getByText('UTF-8 · SALTOS MIXTOS')).toBeVisible();
  expect(screen.getByLabelText('Texto de notas.txt').props.editable).toBe(false);
  fireEvent.press(screen.getByLabelText('Volver a Archivos'));
  await act(async () => { fireEvent.press(screen.getByLabelText('Abrir foto.png')); });
  await settle();
  expect(screen.getByText('No es texto en una codificación que Relay lea: no se edita aquí. Puedes descargarlo al teléfono.')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Volver a Archivos'));
  fireEvent.press(screen.getByLabelText('Abrir grande.log'));
  expect(screen.getByText('DEMASIADO GRANDE PARA EL EDITOR')).toBeVisible();
  expect(posts('/v1/remote/files/read')).toHaveLength(2);
});

test('an upload shows its progress, cancels on the Servidor, and retrying starts again from byte 0; overwriting asks first', async () => {
  const bytes = new Uint8Array(2 * CHUNK + 7).fill(7);
  const stalled = Promise.withResolvers<void>();
  let count = 0;
  respond(URL, '/v1/remote/files/uploads', () => json({ id: count++ ? OP2 : OP, size: bytes.length, received: 0 }), 'POST');
  for (const id of [OP, OP2]) {
    respond(URL, `/v1/remote/files/uploads/${id}/0`, json({ id, size: bytes.length, received: CHUNK }), 'PUT');
    respond(URL, `/v1/remote/files/uploads/${id}/${CHUNK}`, (r: RequestRecord) => {
      if (id === OP2) return json({ id, size: bytes.length, received: 2 * CHUNK });
      const { promise, reject } = Promise.withResolvers<Response>();
      r.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      stalled.resolve();
      return promise;
    }, 'PUT');
    respond(URL, `/v1/remote/files/uploads/${id}/${2 * CHUNK}`, json({ id, size: bytes.length, received: bytes.length }), 'PUT');
    respond(URL, `/v1/remote/files/uploads/${id}/commit`, json(entry('foto.jpg', 'file', { size: bytes.length })), 'POST');
  }
  await setup();
  pickPhoneFile('foto.jpg', bytes);
  await act(async () => { fireEvent.press(screen.getByLabelText('Subir del teléfono')); });
  await act(async () => { await stalled.promise; });
  await settle();
  expect(posts('/v1/remote/files/uploads').map((r) => r.body)).toEqual([{ directory: HOME, name: 'foto.jpg', size: bytes.length }]);
  expect(screen.getByLabelText('Subiendo foto.jpg…').props.accessibilityValue).toEqual({ min: 0, max: bytes.length, now: CHUNK });
  expect(screen.getByText('SUBIENDO · 1.0 MB DE 2.0 MB')).toBeVisible();
  await act(async () => { fireEvent.press(screen.getByLabelText('Cancelar foto.jpg')); });
  await settle();
  expect(posts(`/v1/remote/operations/${OP}/cancel`)).toHaveLength(1);
  expect(screen.getByText('CANCELADA')).toBeVisible();
  expect(posts(`/v1/remote/files/uploads/${OP}/commit`)).toEqual([]);

  await act(async () => { fireEvent.press(screen.getByLabelText('Reintentar: foto.jpg, desde el principio')); });
  await settle();
  expect(requests.filter((r) => r.method === 'PUT' && r.path.includes(OP2)).map((r) => r.path.split('/').at(-1))).toEqual(['0', String(CHUNK), String(2 * CHUNK)]);
  expect(screen.getByText('TERMINADA')).toBeVisible();
  expect(screen.getByText('Ya está en el Servidor.')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Quitar foto.jpg de la lista'));

  // A name already in the folder: replaced only with the listed version the person confirmed.
  respond(URL, '/v1/remote/files/uploads', json({ id: OP, size: 3, received: 0 }), 'POST');
  respond(URL, `/v1/remote/files/uploads/${OP}/0`, json({ id: OP, size: 3, received: 3 }), 'PUT');
  pickPhoneFile('notas.txt', new Uint8Array([1, 2, 3]));
  await act(async () => { fireEvent.press(screen.getByLabelText('Subir del teléfono')); });
  expect(screen.getByText('¿SOBRESCRIBIR?')).toBeVisible();
  fireEvent.press(screen.getByLabelText('Cancelar'));
  expect(posts('/v1/remote/files/uploads')).toHaveLength(2);
  pickPhoneFile('notas.txt', new Uint8Array([1, 2, 3]));
  await act(async () => { fireEvent.press(screen.getByLabelText('Subir del teléfono')); });
  await act(async () => { fireEvent.press(screen.getByLabelText('Confirmar: Sobrescribir')); });
  await settle();
  expect(posts(`/v1/remote/files/uploads/${OP}/commit`).at(-1)!.body).toEqual({ replace: NOTAS.version });
});

test('an upload that ends while another folder is shown leaves that folder on screen; one that ends in the folder shown lists it again', async () => {
  const bytes = new Uint8Array(2 * CHUNK + 7).fill(7);
  const stalled = Promise.withResolvers<void>();
  const release = deferred<Response>();
  respond(URL, '/v1/remote/files/uploads', json({ id: OP, size: bytes.length, received: 0 }), 'POST');
  respond(URL, `/v1/remote/files/uploads/${OP}/0`, json({ id: OP, size: bytes.length, received: CHUNK }), 'PUT');
  respond(URL, `/v1/remote/files/uploads/${OP}/${CHUNK}`, () => { stalled.resolve(); return release.promise; }, 'PUT');
  respond(URL, `/v1/remote/files/uploads/${OP}/${2 * CHUNK}`, json({ id: OP, size: bytes.length, received: bytes.length }), 'PUT');
  respond(URL, `/v1/remote/files/uploads/${OP}/commit`, json(entry('foto.jpg', 'file', { size: bytes.length })), 'POST');
  await setup();
  pickPhoneFile('foto.jpg', bytes);
  await act(async () => { fireEvent.press(screen.getByLabelText('Subir del teléfono')); });
  await act(async () => { await stalled.promise; });
  fireEvent.press(screen.getByLabelText('Abrir proyectos'));
  await settle();
  expect(folderShown()).toBe('~/proyectos');
  const before = posts('/v1/remote/files/list').length;
  await act(async () => { release.resolve(json({ id: OP, size: bytes.length, received: 2 * CHUNK })); });
  await settle();
  expect(screen.getByText('TERMINADA')).toBeVisible();
  expect(folderShown()).toBe('~/proyectos');
  expect(posts('/v1/remote/files/list').length).toBe(before);

  // Back in the folder it uploads to, an upload that ends there lists it again.
  fireEvent.press(screen.getByLabelText('Quitar foto.jpg de la lista'));
  fireEvent.press(screen.getByLabelText('Carpeta superior'));
  await settle();
  respond(URL, `/v1/remote/files/uploads/${OP}/${CHUNK}`, json({ id: OP, size: bytes.length, received: 2 * CHUNK }), 'PUT');
  const listed = posts('/v1/remote/files/list').length;
  pickPhoneFile('foto.jpg', bytes);
  await act(async () => { fireEvent.press(screen.getByLabelText('Subir del teléfono')); });
  await settle();
  expect(screen.getByText('TERMINADA')).toBeVisible();
  expect(posts('/v1/remote/files/list').length).toBe(listed + 1);
  expect(posts('/v1/remote/files/list').at(-1)!.body).toEqual({ path: HOME, hidden: false });
});

test('a download is complete only with its last byte on the phone; a short one is not, and leaves nothing behind', async () => {
  configureLocalFiles();
  const download = { id: OP, path: `${HOME}/notas.txt`, realPath: `${HOME}/notas.txt`, size: 5, version: NOTAS.version };
  respond(URL, '/v1/remote/files/downloads', json(download), 'POST');
  respond(URL, `/v1/remote/files/downloads/${OP}/0`, binary(new Uint8Array([104, 111, 108, 97, 33])));
  await setup();
  fireEvent.press(screen.getByLabelText('Acciones de notas.txt'));
  await act(async () => { fireEvent.press(screen.getByLabelText('Descargar al teléfono')); });
  await settle();
  expect(screen.getByText('TERMINADA')).toBeVisible();
  expect([...localFiles]).toEqual([['file://fixture/cache/relay-remote/A/1/notas.txt', [104, 111, 108, 97, 33]]]);
  expect(screen.getByLabelText('Compartir notas.txt')).toBeVisible();

  respond(URL, `/v1/remote/files/downloads/${OP}/0`, binary(new Uint8Array([104, 111])));
  fireEvent.press(screen.getByLabelText('Acciones de notas.txt'));
  await act(async () => { fireEvent.press(screen.getByLabelText('Descargar al teléfono')); });
  await settle();
  expect(screen.getByText('NO TERMINÓ')).toBeVisible();
  expect(screen.getByText(/Lo que llegó no se usa; al reintentar, empieza desde el principio\./)).toBeVisible();
  expect([...localFiles.keys()].filter((uri) => uri.includes('/2/'))).toEqual([]);
  expect(posts(`/v1/remote/operations/${OP}/cancel`)).toHaveLength(1);
});

test('searching by name shows progress and results, and acknowledges each frame', async () => {
  const stream = streamFixture();
  respond(URL, '/v1/remote/files/search', json({ id: OP, state: 'running' }), 'POST');
  respond(URL, `/v1/remote/operations/${OP}/events`, (r: RequestRecord) => stream.reply(r));
  respond(URL, `/v1/remote/operations/${OP}/ack`, json({ ok: true }), 'POST');
  await setup();
  fireEvent.press(screen.getByLabelText('Buscar'));
  fireEvent.changeText(screen.getAllByLabelText('Buscar').at(-1)!, 'notas');
  await act(async () => { fireEvent.press(screen.getByLabelText('Buscar nombres')); });
  await settle();
  expect(posts('/v1/remote/files/search').map((r) => r.body)).toEqual([{ path: HOME, query: 'notas', hidden: false }]);
  expect(screen.getByText('BUSCANDO…')).toBeVisible();
  await act(async () => {
    stream.emit(`id: 1\ndata: ${JSON.stringify({ type: 'results', seq: 1, matches: [{ path: `${HOME}/proyectos/notas.md`, entry: entry('notas.md') }], folders: 3, files: 9, unreadable: 1 })}\n\n`);
    stream.emit(`id: 2\ndata: ${JSON.stringify({ type: 'end', seq: 2, state: 'completed', truncated: false, folders: 4, files: 12, unreadable: 1 })}\n\n`);
    stream.close();
  });
  await settle();
  expect(screen.getByText('1 RESULTADOS')).toBeVisible();
  expect(screen.getByText('4 CARPETAS · 12 ARCHIVOS · 1 SIN PERMISO O DESAPARECIDOS')).toBeVisible();
  expect(screen.getByText('~/proyectos/notas.md')).toBeVisible();
  expect(posts(`/v1/remote/operations/${OP}/ack`).map((r) => r.body)).toEqual([{ seq: 1 }, { seq: 2 }]);
});

test('switching tools keeps the folder and the draft; «Terminal aquí» opens a new terminal form in that folder; copying a path uses the clipboard', async () => {
  respond(URL, '/v1/remote/files/read', json(readable(`${HOME}/proyectos/a.txt`, Buffer.from('hola\n'), 53)), 'POST');
  respond(URL, `${'/v1/remote/files/list'}`, (r: RequestRecord) => {
    const path = (r.body as { path?: string }).path ?? HOME;
    return json({ path, realPath: path, entries: path === HOME ? [PROYECTOS, NOTAS] : [entry('a.txt')], truncated: false, protection: null });
  }, 'POST');
  saves([() => json({ path: `${HOME}/proyectos/a.txt`, realPath: `${HOME}/proyectos/a.txt`, version: content(53, 11, 'e') })]);
  await setup();
  fireEvent.press(screen.getByLabelText('Acciones de notas.txt'));
  await act(async () => { fireEvent.press(screen.getByLabelText('Copiar ruta')); });
  expect(clipboard.setStringAsync).toHaveBeenCalledWith(`${HOME}/notas.txt`);
  fireEvent.press(screen.getByLabelText('Abrir proyectos'));
  await settle();
  await act(async () => { fireEvent.press(screen.getByLabelText('Abrir a.txt')); });
  await settle();
  fireEvent.changeText(screen.getByLabelText('Texto de a.txt'), 'hola\nmundo\n');

  fireEvent.press(screen.getByLabelText('Terminal'));
  await settle();
  fireEvent.press(screen.getByLabelText('Archivos'));
  await settle();
  expect(screen.getByText('BORRADOR')).toBeVisible();
  expect(posts('/v1/remote/files/read')).toHaveLength(1);
  await act(async () => { fireEvent.press(screen.getByText('Guardar')); });
  await settle();
  expect(text(requests.find((r) => r.method === 'PUT')!.body)).toBe('hola\nmundo\n');
  fireEvent.press(screen.getByLabelText('Volver a Archivos'));
  expect(folderShown()).toBe('~/proyectos');

  fireEvent.press(screen.getByLabelText('Terminal aquí'));
  await settle();
  expect(screen.getByText('Nueva terminal')).toBeVisible();
  expect(screen.getByLabelText('Carpeta de la terminal').props.value).toBe(`${HOME}/proyectos`);
  expect(posts('/v1/remote/environments')).toEqual([]);
});

test('locking hides the files and sends nothing; after unlocking and entering again the folder and the draft are still there', async () => {
  respond(URL, '/v1/remote/files/read', json(readable(`${HOME}/notas.txt`, Buffer.from('uno\n'), 54)), 'POST');
  await setup();
  await act(async () => { fireEvent.press(screen.getByLabelText('Abrir notas.txt')); });
  await settle();
  fireEvent.changeText(screen.getByLabelText('Texto de notas.txt'), 'uno\ndos\n');
  const before = remoteRequests().length;
  await act(async () => { await jest.advanceTimersByTimeAsync(61_000); });
  expect(screen.getByText('Relay está bloqueado')).toBeVisible();
  expect(screen.getByLabelText('Texto de notas.txt', { includeHiddenElements: true })).not.toBeVisible();
  expect(remoteRequests().slice(before)).toEqual([]);

  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  await act(async () => { fireEvent.press(screen.getByText('Usar el código del teléfono')); });
  await settle();
  // The lock voided the entry: the tools ask for the verification again, and the draft waits hidden.
  expect(screen.getByText('PON TU HUELLA PARA ENTRAR')).toBeVisible();
  expect(screen.getByLabelText('Texto de notas.txt', { includeHiddenElements: true })).not.toBeVisible();
  await enter();
  expect(screen.getByLabelText('Texto de notas.txt')).toBeVisible();
  expect(screen.getByText('BORRADOR')).toBeVisible();
});

test('a revocation discards the files tool; an answer that arrives afterwards never opens the editor', async () => {
  const late = deferred<Response>();
  respond(URL, '/v1/remote/files/read', () => late.promise, 'POST');
  const app = await setup();
  await act(async () => { fireEvent.press(screen.getByLabelText('Abrir notas.txt')); });
  await settle();
  respond(URL, '/v1/agents', json({ error: { code: 'device_revoked', message: 'hidden' } }, 403));
  await act(async () => { await jest.advanceTimersByTimeAsync(5_000); });
  expect(screen.getByText('SIN ACCESO')).toBeVisible();
  expect(screen.queryByLabelText('Carpeta actual')).toBeNull();
  await act(async () => { late.resolve(json(readable(`${HOME}/notas.txt`, Buffer.from('secreto\n'), 55))); });
  await settle();
  expect(screen.queryByLabelText('Texto de notas.txt')).toBeNull();

  const paired = { ...serverA, deviceId: 'fixture-device-A2', key: 'fixture-key-A2' };
  polling(paired);
  serve();
  await act(async () => { await app.probe.current!.replaceServer(serverA.id, paired); });
  await act(async () => { await jest.advanceTimersByTimeAsync(5_000); });
  await waitFor(() => expect(screen.getByText('PON TU HUELLA PARA ENTRAR')).toBeVisible());
  await enter();
  expect(folderShown()).toBe('~');
  expect(screen.queryByLabelText('Texto de notas.txt')).toBeNull();
  expect(screen.queryByText('BORRADOR')).toBeNull();
});

test('a revocation discards the draft and the folder, even if the same pairing is accepted again', async () => {
  respond(URL, '/v1/remote/files/read', json(readable(`${HOME}/proyectos/a.txt`, Buffer.from('uno\n'), 56)), 'POST');
  const app = await setup();
  fireEvent.press(screen.getByLabelText('Abrir proyectos'));
  await settle();
  await act(async () => { fireEvent.press(screen.getByLabelText('Abrir a.txt')); });
  await settle();
  fireEvent.changeText(screen.getByLabelText('Texto de a.txt'), 'uno\ndos\n');
  respond(URL, '/v1/agents', json({ error: { code: 'device_revoked', message: 'hidden' } }, 403));
  await act(async () => { await jest.advanceTimersByTimeAsync(5_000); });
  expect(screen.getByText('SIN ACCESO')).toBeVisible();
  // The same key is accepted again: the person retries the connection, without pairing anew.
  respond(URL, '/v1/agents', json({ agents: [] }));
  await act(async () => { app.probe.current!.refresh(serverA.id); await jest.advanceTimersByTimeAsync(5_000); });
  await waitFor(() => expect(screen.getByText('PON TU HUELLA PARA ENTRAR')).toBeVisible());
  await enter();
  expect(folderShown()).toBe('~');
  expect(screen.queryByLabelText('Texto de a.txt', { includeHiddenElements: true })).toBeNull();
});

test('a long file is edited in pieces, and saving one changed piece writes back every other byte as it was', async () => {
  const original = Array.from({ length: 1000 }, (_, index) => `línea ${index}\r\n`).join('');
  const bytes = Buffer.from(original);
  respond(URL, '/v1/remote/files/read', json(readable(`${HOME}/notas.txt`, bytes, 57)), 'POST');
  saves([() => json({ path: `${HOME}/notas.txt`, realPath: `${HOME}/notas.txt`, version: content(57, bytes.length + 1, 'f') })]);
  await setup();
  await act(async () => { fireEvent.press(screen.getByLabelText('Abrir notas.txt')); });
  await settle();
  const pieces = screen.getAllByLabelText(/^Texto de notas\.txt · tramo \d+ de 3$/);
  expect(pieces).toHaveLength(3);
  fireEvent.changeText(pieces[2]!, `${pieces[2]!.props.value}X`);
  await act(async () => { fireEvent.press(screen.getByText('Guardar')); });
  await settle();
  expect(Buffer.from(requests.find((r) => r.method === 'PUT')!.body as Uint8Array).toString('utf8')).toBe(`${original}X`);
});

test('reloading over a draft and closing with a draft both ask before the draft is lost', async () => {
  const original = Buffer.from('uno\r\ndos\r\n');
  let reads = 0;
  respond(URL, '/v1/remote/files/read', () => json(readable(`${HOME}/notas.txt`, original, 58, reads++ ? { version: content(58, original.length, 'b') } : {})), 'POST');
  saves([() => json({ error: { code: 'remote_conflict', message: 'x' } }, 409)]);
  await setup();
  await act(async () => { fireEvent.press(screen.getByLabelText('Abrir notas.txt')); });
  await settle();
  fireEvent.changeText(screen.getByLabelText('Texto de notas.txt'), 'uno\ndos\ntres\n');
  await act(async () => { fireEvent.press(screen.getByText('Guardar')); });
  await settle();
  expect(screen.getByText('CAMBIÓ EN EL SERVIDOR')).toBeVisible();

  fireEvent.press(screen.getByLabelText('Recargar del Servidor'));
  await settle();
  expect(screen.getByText('¿DESCARTAR TU BORRADOR?')).toBeVisible();
  expect(posts('/v1/remote/files/read')).toHaveLength(1);
  fireEvent.press(screen.getByLabelText('Cancelar'));
  expect(screen.getByText('CAMBIÓ EN EL SERVIDOR')).toBeVisible();
  expect(screen.getByLabelText('Texto de notas.txt').props.value).toBe('uno\ndos\ntres\n');
  fireEvent.press(screen.getByLabelText('Recargar del Servidor'));
  await act(async () => { fireEvent.press(screen.getByLabelText('Confirmar: Recargar')); });
  await settle();
  expect(posts('/v1/remote/files/read')).toHaveLength(2);
  expect(screen.getByLabelText('Texto de notas.txt').props.value).toBe('uno\ndos\n');
  expect(screen.queryByText('BORRADOR')).toBeNull();

  // Closing with a draft asks to discard it, by either way out; going back keeps it.
  fireEvent.changeText(screen.getByLabelText('Texto de notas.txt'), 'otra\n');
  for (const way of ['Volver a Archivos', 'Cerrar el editor']) {
    fireEvent.press(screen.getByLabelText(way));
    expect(screen.getByText('Tus cambios sin guardar se pierden. El archivo del Servidor no cambia.')).toBeVisible();
    fireEvent.press(screen.getByLabelText('Cancelar'));
    expect(screen.getByLabelText('Texto de notas.txt').props.value).toBe('otra\n');
  }
  fireEvent.press(screen.getByLabelText('Volver a Archivos'));
  fireEvent.press(screen.getByLabelText('Confirmar: Descartar'));
  expect(screen.queryByLabelText('Texto de notas.txt')).toBeNull();
  expect(folderShown()).toBe('~');
});

test('a Puente without files shows why on the Archivos tab and is never asked for files', async () => {
  seed([serverA], { ...settings, faceid: true, autoLockMs: 60_000 });
  polling(serverA);
  serve();
  respond(URL, '/health', json({ ...health, capabilities: { environments: V1, terminal: V1 } }));
  biometrics.authenticateAsync.mockResolvedValueOnce({ success: true });
  const app = renderApp(<LockGate><ServerToolsScreen serverId={serverA.id} /></LockGate>);
  await app.ready();
  await waitFor(() => expect(screen.getByText('PON TU HUELLA PARA ENTRAR')).toBeVisible());
  await enter();
  expect(screen.getByText('Este Puente no tiene esta herramienta o tiene una versión anterior.')).toBeVisible();
  expect(screen.queryByLabelText('Carpeta actual')).toBeNull();
  expect(requests.filter((r) => r.path.startsWith('/v1/remote/files'))).toEqual([]);
});

test('in the Puente\'s own folders an entry offers no rename, move or delete', async () => {
  await setup({ [HOME]: { protection: 'bridge', entries: [NOTAS, PROYECTOS] } });
  for (const name of ['notas.txt', 'proyectos']) {
    fireEvent.press(screen.getByLabelText(`Acciones de ${name}`));
    expect(screen.getByLabelText('Copiar ruta')).toBeVisible();
    for (const write of ['Renombrar', 'Mover', 'Borrar']) expect(screen.queryByLabelText(write)).toBeNull();
    fireEvent.press(screen.getByLabelText('Cancelar'));
  }
});

test('deleting inside a Hermes profile promises a copy only of what the Puente keeps: a file up to 5 MiB', async () => {
  const link = entry('atajo', 'symlink', { link: { target: '/srv/datos', realPath: '/srv/datos', type: 'directory' } });
  await setup({ [HOME]: { protection: 'profile', entries: [entry('memorias', 'directory'), NOTAS, entry('estado.db', 'file', { size: 5 * CHUNK + 1 }), link] } });
  const confirmation = (name: string) => {
    fireEvent.press(screen.getByLabelText(`Acciones de ${name}`));
    expect(screen.queryByText('CON SU CONTENIDO')).toBeNull();
    fireEvent.press(screen.getByLabelText('Borrar'));
  };
  confirmation('notas.txt');
  expect(screen.getByText(/Relay guarda antes una copia, porque está en un perfil de Hermes\./)).toBeVisible();
  fireEvent.press(screen.getByLabelText('Cancelar'));
  for (const [name, says] of [
    ['memorias', /^Se borra la carpeta\. Dentro de un perfil de Hermes, Relay solo borra una carpeta vacía\. Si tiene contenido, no la borra: hazlo en la computadora\.$/],
    ['estado.db', /Pesa más de 5 MiB y está en un perfil de Hermes: Relay no puede guardar una copia, así que no lo borra\. Hazlo en la computadora\./],
    ['atajo', /Dentro de un perfil de Hermes, Relay no borra enlaces: hazlo en la computadora\./],
  ] as const) {
    confirmation(name);
    expect(screen.getByText(says)).toBeVisible();
    expect(screen.queryByText(/guarda antes una copia/)).toBeNull();
    expect(screen.queryByText(/todo su contenido/)).toBeNull();
    fireEvent.press(screen.getByLabelText('Cancelar'));
  }
  expect(posts('/v1/remote/files/delete')).toEqual([]);
});
