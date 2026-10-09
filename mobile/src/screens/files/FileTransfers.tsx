import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { startActivityAsync } from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { useRef, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';

import type { RemoteFileVersion } from '../../../../protocol/remoteFiles';
import { fileSize, localFileName } from '@/core/files';
import type { Admitted } from '@/core/remoteAccess';
import type { RemoteClient } from '@/core/remoteClient';
import { downloadFile, uploadFile, type Outcome } from '@/core/remoteTransfers';
import { usePalette } from '@/theme/ThemeProvider';
import { TYPE } from '@/theme/tokens';
import { Keycap, ListBlock } from '@/ui/kit';
import { M, T } from '@/ui/primitives';
import { failure, ProgressBar } from './parts';

export type RunTransfer = <T>(work: (client: () => RemoteClient, signal: AbortSignal) => Promise<T>) => Promise<Admitted<T>>;

/** What the person asked for: enough to start it again from byte 0. */
export type TransferRequest =
  | { direction: 'up'; file: File; directory: string; name: string; replace?: RemoteFileVersion }
  | { direction: 'down'; path: string; name: string };

export interface Transfer {
  id: number;
  request: TransferRequest;
  /** `interrupted`: Relay lost control (lock, hidden, connection) before it completed. Never shown as done. */
  state: 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  done: number;
  total: number | null;
  error: string | null;
  /** A completed download, in the app's cache. */
  local: File | null;
}

const STATE: Record<Exclude<Transfer['state'], 'running'>, string> = {
  completed: 'TERMINADA', cancelled: 'CANCELADA', failed: 'NO TERMINÓ', interrupted: 'INTERRUMPIDA',
};

/**
 * The tool's transfers (#87): one admitted access each, one chunk at a time. Cancelling, a lock, a
 * lost connection or a failure leave it unfinished, and retrying starts again from byte 0.
 */
export function useTransfers({ serverId, run, onRevoked, onUploaded }: { serverId: string; run: RunTransfer; onRevoked: () => void; onUploaded: (directory: string) => void }) {
  const controllers = useRef(new Map<number, AbortController>());
  const next = useRef(1);
  const [transfers, setTransfers] = useState<Transfer[]>([]);

  const update = (id: number, change: Partial<Transfer>) => setTransfers((all) => all.map((each) => each.id === id ? { ...each, ...change } : each));
  const start = async (request: TransferRequest, id = next.current++) => {
    const mine = new AbortController();
    controllers.current.set(id, mine);
    const total = request.direction === 'up' ? request.file.size : null;
    setTransfers((all) => [...all.filter((each) => each.id !== id), { id, request, state: 'running', done: 0, total, error: null, local: null }]);
    const onProgress = ({ done, total: known }: { done: number; total: number | null }) => update(id, { done, total: known });
    // The download's unfinished bytes: deleted unless they became the completed file.
    const scratch: { partial: File | null } = { partial: null };
    try {
      if (Platform.OS === 'web') throw new Error('web');
      const result = await run(async (client, signal): Promise<Outcome<unknown>> => {
        signal.addEventListener('abort', () => mine.abort(), { once: true });
        if (request.direction === 'up') {
          const handle = request.file.open();
          try {
            return await uploadFile(client, { directory: request.directory, name: request.name, ...(request.replace ? { replace: request.replace } : {}) }, {
              size: request.file.size,
              // One chunk at a time from where the transfer is; never the whole file.
              read: async (offset, length) => { handle.offset = offset; return handle.readBytes(Math.min(length, Math.max(request.file.size - offset, 0))); },
            }, { signal: mine.signal, onProgress });
          } finally { handle.close(); }
        }
        const folder = new Directory(Paths.cache, 'relay-remote', encodeURIComponent(serverId), String(id));
        folder.create({ idempotent: true, intermediates: true });
        const partial = new File(folder, '.part');
        scratch.partial = partial;
        partial.create({ overwrite: true });
        const handle = partial.open(FileMode.WriteOnly);
        let outcome: Outcome<unknown>;
        try { outcome = await downloadFile(client, request.path, async (bytes) => { handle.writeBytes(bytes); }, { signal: mine.signal, onProgress }); }
        finally { handle.close(); }
        if (outcome.state === 'completed') {
          const saved = new File(folder, localFileName(request.name));
          await partial.move(saved, { overwrite: true });
          scratch.partial = null;
          return { state: 'completed', value: saved };
        }
        return outcome;
      });
      if (result.state === 'revoked') { onRevoked(); return; }
      if (result.state === 'refused') { update(id, { state: 'failed', error: 'Ahora no hay control sobre este Servidor.' }); return; }
      if (result.state === 'suspended') { update(id, { state: 'interrupted', error: 'Relay perdió el control antes de terminar (bloqueo o conexión).' }); return; }
      const outcome = result.value;
      if (outcome.state === 'completed') {
        update(id, { state: 'completed', local: request.direction === 'down' ? outcome.value as File : null });
        if (request.direction === 'up') onUploaded(request.directory);
      } else if (outcome.state === 'cancelled') update(id, { state: 'cancelled' });
      else update(id, { state: 'failed', error: failure(outcome.error) });
    } catch (error) {
      update(id, { state: 'failed', error: error instanceof Error && error.message === 'web' ? 'Transferir archivos está disponible en Android.' : failure(error) });
    } finally {
      controllers.current.delete(id);
      const left = scratch.partial;
      if (left) { try { left.delete(); } catch {} }
    }
  };
  return {
    transfers,
    start: (request: TransferRequest) => void start(request),
    cancel: (id: number) => controllers.current.get(id)?.abort(),
    retry: (transfer: Transfer) => void start(transfer.request, transfer.id),
    dismiss: (id: number) => setTransfers((all) => all.filter((each) => each.id !== id)),
  };
}

export function TransfersPanel({ transfers, onCancel, onRetry, onDismiss }: {
  transfers: Transfer[]; onCancel: (id: number) => void; onRetry: (transfer: Transfer) => void; onDismiss: (id: number) => void;
}) {
  const { K } = usePalette();
  if (transfers.length === 0) return null;
  const act = async (transfer: Transfer, action: 'open' | 'share') => {
    const local = transfer.local;
    if (!local) return;
    try {
      if (action === 'open') await startActivityAsync('android.intent.action.VIEW', { data: local.contentUri, type: '*/*', flags: 1 });
      else if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(local.uri, { dialogTitle: `Compartir ${transfer.request.name}` });
    } catch {}
  };
  return (
    <ListBlock style={{ marginHorizontal: 0, paddingVertical: 12 }}><View style={{ gap: 12 }}>
      {transfers.map((transfer) => {
        const verb = transfer.request.direction === 'up' ? 'SUBIENDO ·' : 'DESCARGANDO ·';
        return (
          <View key={transfer.id} style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <M s={9.5} c={K.accent}>{transfer.request.direction === 'up' ? '↑' : '↓'}</M>
              <T {...TYPE.body} c={K.ink} numberOfLines={1} style={{ flex: 1 }}>{transfer.request.name}</T>
              {transfer.state !== 'running' ? <M s={9.5} ls={0.05} c={transfer.state === 'completed' ? K.okText : K.dangerText} accessibilityLiveRegion="polite">{STATE[transfer.state]}</M> : null}
            </View>
            {transfer.state === 'running' ? (
              <>
                <ProgressBar label={transfer.request.direction === 'up' ? `Subiendo ${transfer.request.name}…` : `Descargando ${transfer.request.name}…`} done={transfer.done} total={transfer.total} />
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <M s={9.5} c={K.inkTertiary}>{verb} {fileSize(transfer.done)}{transfer.total === null ? '' : ` DE ${fileSize(transfer.total)}`}</M>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Cancelar ${transfer.request.name}`} onPress={() => onCancel(transfer.id)} style={{ minHeight: 48, minWidth: 48, justifyContent: 'center', alignItems: 'flex-end' }}>
                    <M s={9.5} w="600" c={K.accentText}>CANCELAR</M>
                  </Pressable>
                </View>
              </>
            ) : (
              <>
                {transfer.error ? <T {...TYPE.secondary} c={K.inkSecondary}>{transfer.error}{transfer.state === 'interrupted' || transfer.state === 'failed' ? ' Lo que llegó no se usa; al reintentar, empieza desde el principio.' : ''}</T> : null}
                {transfer.state === 'completed' && transfer.request.direction === 'up' ? <T {...TYPE.secondary} c={K.inkSecondary}>Ya está en el Servidor.</T> : null}
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  {transfer.state === 'completed' && transfer.local ? (
                    <>
                      <Keycap label="Abrir" variant="dark" accessibilityLabel={`Abrir ${transfer.request.name}`} onPress={() => void act(transfer, 'open')} style={{ flex: 1 }} />
                      <Keycap label="Compartir" accessibilityLabel={`Compartir ${transfer.request.name}`} onPress={() => void act(transfer, 'share')} style={{ flex: 1 }} />
                    </>
                  ) : transfer.state !== 'completed' ? (
                    <Keycap label="Reintentar" accessibilityLabel={`Reintentar: ${transfer.request.name}, desde el principio`} onPress={() => onRetry(transfer)} style={{ flex: 1 }} />
                  ) : null}
                  <Keycap variant="link" label="Quitar" accessibilityLabel={`Quitar ${transfer.request.name} de la lista`} onPress={() => onDismiss(transfer.id)} />
                </View>
              </>
            )}
          </View>
        );
      })}
    </View></ListBlock>
  );
}
