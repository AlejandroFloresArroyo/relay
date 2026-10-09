import * as Clipboard from 'expo-clipboard';
import { File } from 'expo-file-system';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { FlatList, Platform, Pressable, View } from 'react-native';

import { REMOTE_LIMITS } from '../../../../protocol/protocol';
import type { RemoteFileEntry, RemoteFileSearchMatch } from '../../../../protocol/remoteFiles';
import { runAdmitted } from '@/core/remoteAccess';
import type { RemoteClient } from '@/core/remoteClient';
import { childPath, filesApi, parentPath, type FolderListing } from '@/core/remoteFiles';
import { folderLabel } from '@/core/terminals';
import type { ServerRemoteAccess } from '@/state/remoteAccess';
import { usePalette } from '@/theme/ThemeProvider';
import { TYPE } from '@/theme/tokens';
import { Keycap, Lamp, ListBlock } from '@/ui/kit';
import { M, T } from '@/ui/primitives';
import { Sheet } from '@/ui/sheet';
import { FileEditor, type RunFiles } from './FileEditor';
import { FileSearch } from './FileSearch';
import { TransfersPanel, useTransfers, type RunTransfer } from './FileTransfers';
import { Confirm, EntryRow, failure, isCode, NameForm, ProtectionBanner, SheetAction, SPECIAL, type EntryDrag } from './parts';

export interface FilesToolProps {
  serverId: string;
  /** A client while `files` is available; throws `not_offered` otherwise. */
  client: () => RemoteClient;
  admit: ServerRemoteAccess['admit'];
  /** Control is allowed and the tool can be used: becoming true lists the folder again. */
  active: boolean;
  /** Opens the Terminal tool with a new terminal in this folder; null while the terminal is not available. */
  onOpenTerminal: ((cwd: string) => void) | null;
  /** #114: beside a Conversación, a file row can be lifted and dropped on it. */
  drag?: EntryDrag;
}

const SHEET_TITLE: Record<SheetState['kind'], string> = {
  actions: 'Acciones', rename: 'Renombrar', create: 'Nuevo', delete: 'Borrar', info: 'Aviso', overwrite: 'Subir',
};

type Target = { entry: RemoteFileEntry; path: string };
type SheetState =
  | { kind: 'actions'; target: Target }
  | { kind: 'rename'; target: Target }
  | { kind: 'delete'; target: Target }
  | { kind: 'create'; type: 'file' | 'directory' }
  | { kind: 'info'; title: string; text: string }
  | { kind: 'overwrite'; file: File; existing: RemoteFileEntry; directory: string };

/**
 * The Archivos tool of one Servidor (#88). Stays mounted while another tool is shown, Relay is locked
 * or the connection drops, so its folder, draft and transfers are kept; a revocation discards them.
 */
export function FilesTool(props: FilesToolProps) {
  const [generation, setGeneration] = useState(0);
  return <Explorer key={generation} {...props} onRevoked={() => setGeneration((value) => value + 1)} />;
}

function Explorer({ serverId, client, admit, active, onOpenTerminal, drag, onRevoked }: FilesToolProps & { onRevoked: () => void }) {
  const { K } = usePalette();
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [moving, setMoving] = useState<Target | null>(null);
  const [editing, setEditing] = useState<{ path: string; name: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const loads = useRef(0);
  /** The folder on screen now: an upload that ends later lists it again only if it is still the one shown. */
  const shown = useRef<string | null>(null);

  const runFiles: RunFiles = (work) => runAdmitted(admit, client, (gated) => work(filesApi(gated)));
  const runTransfer: RunTransfer = (work) => runAdmitted(admit, client, work);
  const transfers = useTransfers({ serverId, run: runTransfer, onRevoked, onUploaded: (directory) => { if (shown.current === directory) void load(directory); } });

  /** Lists `path` (null: home). On success the notice becomes `notice`: what the operation that asked for it did. */
  const load = async (path: string | null, showHidden = hidden, notice: string | null = null) => {
    const serial = ++loads.current;
    setLoading(true);
    try {
      const result = await runFiles((api) => api.list(path, showHidden));
      if (serial !== loads.current) return;
      if (result.state === 'revoked') { onRevoked(); return; }
      if (result.state === 'refused') { setNotice('Ahora no hay control sobre este Servidor.'); return; }
      if (result.state === 'suspended') return;
      setListing(result.value);
      shown.current = result.value.path;
      setNotice(notice);
      if (path === null) setHome(result.value.path);
    } catch (error) {
      if (serial === loads.current) setNotice(failure(error));
    } finally {
      if (serial === loads.current) setLoading(false);
    }
  };
  const reload = useEffectEvent(() => { void load(listing?.path ?? null); });
  // Shown with control again (entered, unlocked, reconnected): what the folder holds now.
  useEffect(() => { if (active) reload(); }, [active]);

  const close = () => { setSheet(null); setSheetError(null); setBusy(false); };
  /** One operation from a sheet: on success the folder is listed again; a stale selection lists it too. */
  const operate = async (work: Parameters<RunFiles>[0], done: string | null) => {
    setBusy(true);
    setSheetError(null);
    try {
      const result = await runFiles(work);
      if (result.state === 'revoked') { onRevoked(); return; }
      if (result.state !== 'done') { setSheetError(result.state === 'refused' ? 'Ahora no hay control sobre este Servidor.' : 'Relay perdió el control antes de terminar. Vuelve a listar la carpeta para ver qué pasó.'); setBusy(false); return; }
      close();
      void load(listing?.path ?? null, hidden, done);
    } catch (error) {
      setSheetError(failure(error));
      setBusy(false);
      if (isCode(error, 'remote_conflict') || isCode(error, 'remote_not_found')) void load(listing?.path ?? null);
    }
  };

  const target = (entry: RemoteFileEntry): Target => ({ entry, path: childPath(listing!.path, entry.name) });
  const open = (entry: RemoteFileEntry, path = target(entry).path) => {
    const linked = entry.type === 'symlink' ? entry.link?.type ?? null : entry.type;
    if (!entry.nameUtf8) { setSheet({ kind: 'info', title: 'NOMBRE NO UTF-8', text: 'Su nombre no es UTF-8 y Relay no puede dirigirse a él. Renómbralo en la computadora.' }); return; }
    if (linked === 'directory') { void load(path); return; }
    if (linked === null) { setSheet({ kind: 'info', title: 'ENLACE ROTO', text: `Apunta a ${entry.link?.target ?? 'un destino'} que no existe o no se puede leer. Puedes borrar o renombrar el enlace.` }); return; }
    if (linked !== 'file') {
      setSheet({ kind: 'info', title: `ARCHIVO ESPECIAL · ${SPECIAL[linked] ?? 'OTRO'}`, text: 'No es un archivo regular: Relay no lo abre, no lo edita ni lo transfiere.' });
      return;
    }
    if (entry.type === 'file' && entry.size > REMOTE_LIMITS.editableTextBytes) {
      setSheet({ kind: 'info', title: 'DEMASIADO GRANDE PARA EL EDITOR', text: 'Pesa más de 5 MiB: el editor no lo abre. Puedes descargarlo al teléfono desde sus acciones.' });
      return;
    }
    setEditing({ path, name: entry.name });
  };

  const pick = async () => {
    if (!listing) return;
    if (Platform.OS === 'web') { setNotice('Elegir archivos del teléfono está disponible en Android.'); return; }
    let picked: File;
    try {
      const result = await File.pickFileAsync();
      if (result.canceled) return;
      picked = result.result;
    } catch {
      setNotice('No se pudo abrir el selector de archivos del teléfono. Reintenta.');
      return;
    }
    const existing = listing.entries.find((entry) => entry.name === picked.name);
    if (existing) setSheet({ kind: 'overwrite', file: picked, existing, directory: listing.path });
    else transfers.start({ direction: 'up', file: picked, directory: listing.path, name: picked.name });
  };

  const openMatch = (match: RemoteFileSearchMatch) => {
    setSearching(false);
    const folder = parentPath(match.path) ?? '/';
    void load(match.entry.type === 'directory' ? match.path : folder);
    if (match.entry.type !== 'directory') open(match.entry, match.path);
  };

  const here = listing?.path ?? null;
  const up = here ? parentPath(here) : null;
  const shownSheet = sheet;

  return (
    <View style={{ flex: 1 }}>
      {editing ? (
        <View style={{ flex: 1 }}>
          <FileEditor key={editing.path} path={editing.path} name={editing.name} run={runFiles} onRevoked={onRevoked}
            onClose={() => setEditing(null)} onSaved={() => void load(listing?.path ?? null)} />
        </View>
      ) : null}
      {searching && here ? (
        <View style={{ flex: 1, display: editing ? 'none' : 'flex' }}>
          <FileSearch folder={here} home={home} hidden={hidden} run={runTransfer} onOpen={openMatch} onRevoked={onRevoked} onClose={() => setSearching(false)} />
        </View>
      ) : null}
      <View style={{ flex: 1, gap: 8, display: editing || searching ? 'none' : 'flex' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Keycap label="↑" accessibilityLabel="Carpeta superior" disabled={!up || loading} onPress={() => up && void load(up)} style={{ flexGrow: 0 }} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <M {...TYPE.data} w="600" c={K.ink} numberOfLines={1} accessibilityLabel="Carpeta actual">{here ? folderLabel(here, home) : '…'}</M>
            {listing && listing.realPath !== listing.path ? <M s={9.5} c={K.inkTertiary} numberOfLines={1}>→ {listing.realPath}</M> : null}
          </View>
          <Pressable accessibilityRole="switch" accessibilityLabel="Mostrar ocultos" accessibilityState={{ checked: hidden }}
            onPress={() => { const next = !hidden; setHidden(next); void load(here, next); }} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 48 }}>
            <M s={9.5} ls={0.05} c={K.inkTertiary}>OCULTOS</M>
            <Lamp tone={hidden ? 'green' : 'off'} />
          </Pressable>
        </View>
        {listing ? <ProtectionBanner protection={listing.protection} /> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {([
            ['Buscar', () => setSearching(true)],
            ['Nueva carpeta', () => setSheet({ kind: 'create', type: 'directory' })],
            ['Nuevo archivo', () => setSheet({ kind: 'create', type: 'file' })],
            ['Subir del teléfono', () => void pick()],
            ...(onOpenTerminal && here ? [['Terminal aquí', () => onOpenTerminal(here)] as const] : []),
          ] as const).map(([label, action]) => (
            <Keycap key={label} label={label} accessibilityLabel={label} disabled={!listing} onPress={action} style={{ flexGrow: 0 }} />
          ))}
        </View>
        {moving ? (
          <ListBlock style={{ marginHorizontal: 0, paddingVertical: 12 }}>
           <View style={{ gap: 8 }}>
            <M {...TYPE.label} c={K.accentText} numberOfLines={1}>MOVIENDO {moving.entry.name.toUpperCase()}…</M>
            <T {...TYPE.secondary} c={K.inkSecondary}>Entra en la carpeta de destino y pulsa «Mover aquí». Si ya hay algo con ese nombre, Relay no lo reemplaza.</T>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Keycap label="Cancelar" accessibilityLabel="Cancelar mover" disabled={busy} onPress={() => setMoving(null)} style={{ flex: 1 }} />
              <Keycap label="Mover aquí" accessibilityLabel="Mover aquí" disabled={busy || !here || parentPath(moving.path) === here} onPress={() => {
                const source = moving;
                void (async () => {
                  setBusy(true);
                  try {
                    const result = await runFiles((api) => api.move(source.path, source.entry.version, here!, source.entry.name));
                    if (result.state === 'revoked') { onRevoked(); return; }
                    if (result.state !== 'done') { setNotice('Relay perdió el control antes de terminar. Vuelve a listar la carpeta para ver qué pasó.'); return; }
                    setMoving(null);
                    void load(here, hidden, `Movido: ${source.entry.name}.`);
                  } catch (error) {
                    setNotice(failure(error));
                  } finally {
                    setBusy(false);
                  }
                })();
              }} style={{ flex: 1 }} />
            </View>
           </View>
          </ListBlock>
        ) : null}
        {notice ? <T {...TYPE.secondary} c={K.inkSecondary} accessibilityLiveRegion="polite">{notice}</T> : null}
        {loading && !listing ? <M {...TYPE.label} c={K.inkTertiary}>CARGANDO CARPETA…</M> : null}
        {listing ? (
          <ListBlock style={{ flex: 1, marginHorizontal: 0, paddingVertical: 4 }}>
            <FlatList data={listing.entries} keyExtractor={(entry, index) => `${index}:${entry.name}`}
              ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: K.line }} />}
              ListEmptyComponent={<T {...TYPE.secondary} c={K.inkTertiary} style={{ padding: 14 }}>Carpeta vacía{hidden ? '' : ' (sin contar los ocultos)'}.</T>}
              ListFooterComponent={listing.truncated ? <M s={9.5} c={K.inkTertiary} style={{ padding: 12 }}>SE MUESTRAN LAS PRIMERAS 5000 ENTRADAS. BUSCA PARA ENCONTRAR EL RESTO.</M> : null}
              renderItem={({ item }) => <EntryRow entry={item} onOpen={() => open(item)} onActions={item.nameUtf8 ? () => setSheet({ kind: 'actions', target: target(item) }) : null}
                drag={drag ? { ...drag, path: target(item).path } : undefined} />} />
          </ListBlock>
        ) : <View style={{ flex: 1 }} />}
        <TransfersPanel transfers={transfers.transfers} onCancel={transfers.cancel} onRetry={transfers.retry} onDismiss={transfers.dismiss} />
      </View>

      {shownSheet ? (
        <Sheet visible onClose={busy ? () => {} : close} title={SHEET_TITLE[shownSheet.kind]}>
          {shownSheet.kind === 'actions' ? (
            <EntryActions target={shownSheet.target} protection={listing?.protection ?? null} onClose={close}
              onEdit={() => { close(); open(shownSheet.target.entry); }}
              onEnter={() => { close(); void load(shownSheet.target.path); }}
              onDownload={() => { close(); transfers.start({ direction: 'down', path: shownSheet.target.path, name: shownSheet.target.entry.name }); }}
              onRename={() => setSheet({ kind: 'rename', target: shownSheet.target })}
              onMove={() => { close(); setMoving(shownSheet.target); }}
              onDelete={() => setSheet({ kind: 'delete', target: shownSheet.target })}
              onCopy={() => { close(); void Clipboard.setStringAsync(shownSheet.target.path).then(() => setNotice('Ruta copiada.'), () => {}); }}
              onTerminal={onOpenTerminal ? () => { close(); onOpenTerminal(shownSheet.target.path); } : null} />
          ) : shownSheet.kind === 'rename' ? (
            <NameForm caption={shownSheet.target.entry.type === 'directory' ? 'RENOMBRAR CARPETA' : shownSheet.target.entry.type === 'symlink' ? 'RENOMBRAR ENLACE' : 'RENOMBRAR ARCHIVO'}
              before={shownSheet.target.entry.name} initial={shownSheet.target.entry.name} submit="Guardar" busy={busy} error={sheetError} onCancel={close}
              onSubmit={(name) => void operate((api) => api.move(shownSheet.target.path, shownSheet.target.entry.version, parentPath(shownSheet.target.path) ?? '/', name), `Renombrado: ${name}.`)} />
          ) : shownSheet.kind === 'create' ? (
            <NameForm caption={shownSheet.type === 'directory' ? `NUEVA CARPETA EN ${folderLabel(here ?? '', home).toUpperCase()}` : `NUEVO ARCHIVO EN ${folderLabel(here ?? '', home).toUpperCase()}`}
              before={null} initial="" submit="Crear" busy={busy} error={sheetError} onCancel={close}
              onSubmit={(name) => void operate((api) => api.create(here!, name, shownSheet.type), `Creado: ${name}.`)} />
          ) : shownSheet.kind === 'delete' ? (
            <DeleteConfirm target={shownSheet.target} profile={listing?.protection === 'profile'} busy={busy} error={sheetError} onCancel={close}
              onConfirm={() => void operate((api) => api.remove(shownSheet.target.path, shownSheet.target.entry.version), `Borrado: ${shownSheet.target.entry.name}.`)} />
          ) : shownSheet.kind === 'overwrite' ? (
            shownSheet.existing.type === 'file' || (shownSheet.existing.type === 'symlink' && shownSheet.existing.link?.type === 'file') ? (
              <Confirm title="¿SOBRESCRIBIR?" subject={shownSheet.existing.name} confirm="Sobrescribir" busy={false} error={null} onCancel={close}
                onConfirm={() => {
                  close();
                  transfers.start({ direction: 'up', file: shownSheet.file, directory: shownSheet.directory, name: shownSheet.existing.name, replace: shownSheet.existing.version });
                }}>
                Ya hay un archivo con ese nombre en esta carpeta. Se reemplaza su contenido por el del teléfono y se pierde
                {listing?.protection === 'profile' ? ', salvo la copia que Relay guarda del perfil de Hermes' : '; no hay papelera'}.
                {shownSheet.existing.type === 'symlink' ? ` Es un enlace: se escribe en su destino, ${shownSheet.existing.link?.realPath ?? ''}, y el enlace sigue igual.` : ''}
              </Confirm>
            ) : (
              <View style={{ gap: 10 }}>
                <M {...TYPE.label} c={K.dangerText}>YA EXISTE</M>
                <T {...TYPE.secondary} c={K.inkSecondary}>Ya hay una carpeta o un archivo especial llamado {shownSheet.existing.name}. Relay no lo reemplaza: renómbralo primero.</T>
                <Keycap label="Cerrar" accessibilityLabel="Cerrar" onPress={close} />
              </View>
            )
          ) : (
            <View style={{ gap: 10 }}>
              <M {...TYPE.label} c={K.accentText}>{shownSheet.title}</M>
              <T {...TYPE.secondary} c={K.inkSecondary}>{shownSheet.text}</T>
              <Keycap label="Entendido" accessibilityLabel="Entendido" onPress={close} />
            </View>
          )}
        </Sheet>
      ) : null}
    </View>
  );
}

/** Canvas 07a·2: the entry's actions. */
function EntryActions({ target, protection, onClose, onEdit, onEnter, onDownload, onRename, onMove, onDelete, onCopy, onTerminal }: {
  target: Target; protection: FolderListing['protection']; onClose: () => void; onEdit: () => void; onEnter: () => void; onDownload: () => void;
  onRename: () => void; onMove: () => void; onDelete: () => void; onCopy: () => void; onTerminal: (() => void) | null;
}) {
  const { K } = usePalette();
  const { entry } = target;
  const linked = entry.type === 'symlink' ? entry.link?.type ?? null : entry.type;
  const writable = protection !== 'bridge';
  return (
    <View style={{ gap: 8 }}>
      <View style={{ gap: 3, paddingHorizontal: 4 }}>
        <T {...TYPE.block} c={K.ink} numberOfLines={2}>{entry.name}</T>
        <M s={9.5} c={K.inkTertiary} numberOfLines={2}>{target.path}{entry.type === 'symlink' ? ` → ${entry.link?.realPath ?? `${entry.link?.target ?? ''} (ROTO)`}` : ''}</M>
      </View>
      <ListBlock style={{ marginHorizontal: 0 }}>
        {linked === 'directory' ? <SheetAction label="Abrir" detail={entry.type === 'symlink' ? 'ENTRA EN SU DESTINO' : undefined} onPress={onEnter} /> : null}
        {linked === 'file' ? <SheetAction label="Editar" onPress={onEdit} /> : null}
        {linked === 'file' ? <SheetAction label="Descargar al teléfono" onPress={onDownload} /> : null}
        {linked === 'directory' && onTerminal ? <SheetAction label="Abrir terminal aquí" onPress={onTerminal} /> : null}
        <SheetAction label="Copiar ruta" onPress={onCopy} />
        {writable ? <SheetAction label="Renombrar" onPress={onRename} /> : null}
        {writable ? <SheetAction label="Mover" onPress={onMove} /> : null}
        {writable ? <SheetAction label="Borrar" danger detail={entry.type === 'symlink' ? 'SOLO EL ENLACE' : entry.type === 'directory' ? (protection === 'profile' ? 'SOLO SI ESTÁ VACÍA' : 'CON SU CONTENIDO') : undefined} onPress={onDelete} /> : null}
      </ListBlock>
      <Keycap label="Cancelar" accessibilityLabel="Cancelar" onPress={onClose} />
    </View>
  );
}

/**
 * Canvas 07a·4: a folder says it goes with its content; a link says only the link goes. Inside a
 * profile the Puente keeps a copy of a regular file up to 5 MiB and refuses anything it cannot keep.
 */
function DeleteConfirm({ target, profile, busy, error, onConfirm, onCancel }: {
  target: Target; profile: boolean; busy: boolean; error: string | null; onConfirm: () => void; onCancel: () => void;
}) {
  const { entry } = target;
  const kept = !profile ? ' No hay papelera: no se puede deshacer.'
    : entry.type === 'directory' ? ' Dentro de un perfil de Hermes, Relay solo borra una carpeta vacía. Si tiene contenido, no la borra: hazlo en la computadora.'
    : entry.type === 'symlink' ? ' Dentro de un perfil de Hermes, Relay no borra enlaces: hazlo en la computadora.'
    : entry.type !== 'file' ? ' Dentro de un perfil de Hermes, Relay solo borra archivos regulares: hazlo en la computadora.'
    : entry.size > REMOTE_LIMITS.editableTextBytes ? ' Pesa más de 5 MiB y está en un perfil de Hermes: Relay no puede guardar una copia, así que no lo borra. Hazlo en la computadora.'
    : ' Relay guarda antes una copia, porque está en un perfil de Hermes.';
  return entry.type === 'directory' ? (
    <Confirm title="¿BORRAR CARPETA?" subject={entry.name} confirm="Borrar carpeta" busy={busy} error={error} onCancel={onCancel} onConfirm={onConfirm}>
      {profile ? 'Se borra la carpeta.' : 'Se borran la carpeta y todo su contenido: sus archivos y subcarpetas. Los enlaces de dentro pierden solo el enlace.'}{kept}
    </Confirm>
  ) : entry.type === 'symlink' ? (
    <Confirm title="¿BORRAR ENLACE?" subject={entry.name} confirm="Borrar enlace" busy={busy} error={error} onCancel={onCancel} onConfirm={onConfirm}>
      Se borra solo el enlace. Su destino, {entry.link?.realPath ?? entry.link?.target ?? 'desconocido'}, no cambia.{profile ? kept : ''}
    </Confirm>
  ) : (
    <Confirm title="¿BORRAR ARCHIVO?" subject={entry.name} confirm="Borrar" busy={busy} error={error} onCancel={onCancel} onConfirm={onConfirm}>
      Se borra {entry.name}.{kept}
    </Confirm>
  );
}
