import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { startActivityAsync } from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';

import { uploadPhoneFile } from '@/core/browserFiles';
import { fileSize, localFileName } from '@/core/files';
import type { RemoteClient } from '@/core/remoteClient';
import { downloadFile, type Outcome, type Progress } from '@/core/remoteTransfers';
import type { ServerRemoteAccess } from '@/state/remoteAccess';
import { usePalette } from '@/theme/ThemeProvider';
import { RADIUS, TYPE } from '@/theme/tokens';
import { Keycap } from '@/ui/kit';
import { M, T } from '@/ui/primitives';

export interface BrowserTransfer {
  direction: 'up' | 'down';
  name: string;
  /** `interrupted`: Relay lost control (lock, hidden, connection) before it completed. Never shown as done. */
  state: 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  done: number;
  total: number | null;
  error: string | null;
  /** Up: where the file is on the Servidor. Down: where the file came from. */
  path: string | null;
  /** A completed download, in the app's cache. */
  local: File | null;
}

const failure = (error: unknown) => error instanceof Error && error.name === 'RemoteFailure' ? error.message : 'No se pudo completar la acción. Reintenta.';

/**
 * One transfer at a time for a browser, through the files transfer (#87), as one admitted access (#82):
 * a lock, a hidden Relay or a lost connection aborts it, and an unfinished one is never shown as done.
 * The phone's picker runs before the admission: it hides Relay, which would close it.
 */
export function useBrowserTransfer({ files, available, admit, folder }: {
  files: () => RemoteClient; available: boolean; admit: ServerRemoteAccess['admit']; folder: string;
}) {
  const [transfer, setTransfer] = useState<BrowserTransfer | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); }, []);

  async function admitted<T>(first: BrowserTransfer, work: (signal: AbortSignal, onProgress: (progress: Progress) => void) => Promise<Outcome<T>>): Promise<T | null> {
    setTransfer(first);
    const mine = new AbortController();
    let closed = false;
    const release = admit(() => { closed = true; mine.abort(); });
    if (!release) { setTransfer({ ...first, state: 'failed', error: 'Ahora no hay control sobre este Servidor.' }); return null; }
    active.current = mine;
    const onProgress = ({ done, total }: Progress) => setTransfer((now) => now && { ...now, done, total });
    try {
      const outcome = await work(mine.signal, onProgress);
      if (closed) { setTransfer((now) => now && { ...now, state: 'interrupted', error: 'Relay perdió el control antes de terminar (bloqueo o conexión).' }); return null; }
      if (outcome.state === 'completed') return outcome.value;
      setTransfer((now) => now && { ...now, state: outcome.state, error: outcome.state === 'failed' ? failure(outcome.error) : null });
      return null;
    } catch (error) {
      setTransfer((now) => now && { ...now, state: 'failed', error: failure(error) });
      return null;
    } finally {
      release();
      if (active.current === mine) active.current = null;
    }
  }

  const idle = () => available && Platform.OS !== 'web' && (transfer?.state ?? 'completed') !== 'running';

  /** A phone file to the Servidor's home folder; answers its Servidor path once every byte arrived. */
  const upload = async (): Promise<string | null> => {
    if (!idle()) return null;
    let picked: File;
    try {
      const result = await File.pickFileAsync();
      if (result.canceled) return null;
      picked = result.result;
    } catch {
      setTransfer({ direction: 'up', name: 'Archivo', state: 'failed', done: 0, total: null, error: 'No se pudo abrir el selector del teléfono. Reintenta.', path: null, local: null });
      return null;
    }
    const size = picked.size;
    const path = await admitted<string>({ direction: 'up', name: picked.name, state: 'running', done: 0, total: size, error: null, path: null, local: null }, async (signal, onProgress) => {
      const handle = picked.open();
      try {
        // One chunk at a time from where the transfer is; never the whole file.
        return await uploadPhoneFile(files, { name: picked.name, size, read: async (offset, length) => {
          handle.offset = offset;
          return handle.readBytes(Math.min(length, Math.max(size - offset, 0)));
        } }, { signal, onProgress });
      } finally { handle.close(); }
    });
    if (path) setTransfer((now) => now && { ...now, state: 'completed', path });
    return path;
  };

  /** A download of the page, from the Servidor to the app's cache, then opened or shared from there. */
  const download = async (item: { name: string; path: string }) => {
    if (!idle()) return;
    const directory = new Directory(Paths.cache, 'relay-browser', encodeURIComponent(folder));
    const partial = new File(directory, '.part');
    const saved = await admitted<File>({ direction: 'down', name: item.name, state: 'running', done: 0, total: null, error: null, path: item.path, local: null }, async (signal, onProgress) => {
      directory.create({ idempotent: true, intermediates: true });
      partial.create({ overwrite: true });
      const handle = partial.open(FileMode.WriteOnly);
      let outcome: Outcome<unknown>;
      try { outcome = await downloadFile(files, item.path, async (bytes) => { handle.writeBytes(bytes); }, { signal, onProgress }); }
      finally { handle.close(); }
      if (outcome.state !== 'completed') return outcome;
      const local = new File(directory, localFileName(item.name));
      await partial.move(local, { overwrite: true });
      return { state: 'completed', value: local };
    });
    // An unfinished download is never kept. After the move `partial` names the finished file.
    if (!saved && partial.exists) { try { partial.delete(); } catch {} }
    if (saved) setTransfer((now) => now && { ...now, state: 'completed', local: saved });
  };

  return { transfer, upload, download, cancel: () => active.current?.abort(), dismiss: () => setTransfer(null), ready: available && Platform.OS !== 'web' };
}

const STATE: Record<Exclude<BrowserTransfer['state'], 'running'>, string> = {
  completed: 'TERMINADA', cancelled: 'CANCELADA', failed: 'NO TERMINÓ', interrupted: 'INTERRUMPIDA',
};

/** A block for what the browser reports (a download, a dialog, a transfer); `accent` rims it for what waits on the person. */
export function Card({ accent = false, style, children }: { accent?: boolean; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const { K } = usePalette();
  return <View style={[{ padding: 14, borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: accent ? `${K.shadowBlock}, ${K.shadowAccentRim}` : K.shadowBlock }, style]}>{children}</View>;
}

export function TransferPanel({ transfer, onCancel, onDismiss }: { transfer: BrowserTransfer; onCancel: () => void; onDismiss: () => void }) {
  const { K } = usePalette();
  const up = transfer.direction === 'up';
  const share = async (action: 'open' | 'share') => {
    const local = transfer.local;
    if (!local) return;
    try {
      if (action === 'open') await startActivityAsync('android.intent.action.VIEW', { data: local.contentUri, type: '*/*', flags: 1 });
      else if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(local.uri, { dialogTitle: `Compartir ${transfer.name}` });
    } catch {}
  };
  return (
    <Card style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <M {...TYPE.label} c={K.inkTertiary} style={{ flex: 1 }} accessibilityLiveRegion="polite">
          {up ? 'DEL TELÉFONO AL SERVIDOR' : 'DEL SERVIDOR AL TELÉFONO'} · {transfer.state === 'running'
            ? `${fileSize(transfer.done)}${transfer.total === null ? '' : ` DE ${fileSize(transfer.total)}`}` : STATE[transfer.state]}
        </M>
        {transfer.state === 'running'
          ? <Keycap accessibilityLabel={`Cancelar ${transfer.name}`} label="Cancelar" onPress={onCancel} />
          : <Keycap accessibilityLabel={`Quitar ${transfer.name}`} label="×" onPress={onDismiss} />}
      </View>
      <T {...TYPE.body} c={K.ink} numberOfLines={1}>{transfer.name}</T>
      {transfer.error ? <T {...TYPE.secondary} c={K.inkSecondary} lh={1.35}>{transfer.error} Lo que llegó no se usa: hay que empezar de nuevo.</T> : null}
      {up && transfer.state === 'completed' && transfer.path ? <M {...TYPE.data} c={K.inkTertiary} numberOfLines={1}>EN EL SERVIDOR · {transfer.path}</M> : null}
      {transfer.local ? (
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <Keycap accessibilityLabel={`Abrir ${transfer.name}`} label="Abrir" onPress={() => void share('open')} style={{ flex: 1 }} />
          <Keycap accessibilityLabel={`Compartir ${transfer.name}`} label="Compartir" onPress={() => void share('share')} style={{ flex: 1 }} />
        </View>
      ) : null}
    </Card>
  );
}
