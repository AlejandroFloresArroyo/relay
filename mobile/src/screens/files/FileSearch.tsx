import { useRef, useState } from 'react';
import { FlatList, Pressable, TextInput, View } from 'react-native';

import { REMOTE_FILE_SEARCH_QUERY_BYTES, type RemoteFileSearchMatch, type RemoteFileSearchProgress } from '../../../../protocol/remoteFiles';
import { folderLabel } from '@/core/terminals';
import { searchFiles } from '@/core/remoteTransfers';
import { usePalette } from '@/theme/ThemeProvider';
import { F, RADIUS, TYPE } from '@/theme/tokens';
import { Keycap, ListBlock } from '@/ui/kit';
import { M, T } from '@/ui/primitives';
import type { RunTransfer } from './FileTransfers';
import { EntryRow, failure } from './parts';

type Ending = { state: 'completed'; truncated: boolean } | { state: 'cancelled' } | { state: 'failed'; error: string } | { state: 'interrupted' };

/** Search by name in the folder and its subfolders, or by content as a separate action (#87): progress, cancel, no index. */
export function FileSearch({ folder, home, hidden, run, onOpen, onRevoked, onClose }: {
  folder: string; home: string | null; hidden: boolean; run: RunTransfer; onOpen: (match: RemoteFileSearchMatch) => void; onRevoked: () => void; onClose: () => void;
}) {
  const { K } = usePalette();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<RemoteFileSearchMatch[]>([]);
  const [progress, setProgress] = useState<RemoteFileSearchProgress | null>(null);
  const [running, setRunning] = useState<'names' | 'content' | null>(null);
  const [ending, setEnding] = useState<Ending | null>(null);
  const controller = useRef<AbortController | null>(null);
  const tooLong = new TextEncoder().encode(query).length > REMOTE_FILE_SEARCH_QUERY_BYTES;

  const search = async (content: boolean) => {
    if (running || query === '' || tooLong) return;
    const mine = new AbortController();
    controller.current = mine;
    setMatches([]);
    setProgress(null);
    setEnding(null);
    setRunning(content ? 'content' : 'names');
    try {
      const result = await run(async (client, signal) => {
        signal.addEventListener('abort', () => mine.abort(), { once: true });
        return searchFiles(client, { path: folder, query, ...(content ? { content: true as const } : {}), hidden }, {
          signal: mine.signal, onResults: (found, now) => { setMatches((all) => found.length ? [...all, ...found] : all); setProgress(now); },
        });
      });
      if (result.state === 'revoked') { onRevoked(); return; }
      if (result.state === 'refused') setEnding({ state: 'failed', error: 'Ahora no hay control sobre este Servidor.' });
      else if (result.state === 'suspended') setEnding({ state: 'interrupted' });
      else if (result.value.state === 'completed') { setProgress(result.value.value); setEnding({ state: 'completed', truncated: result.value.value.truncated }); }
      else if (result.value.state === 'cancelled') setEnding({ state: 'cancelled' });
      else setEnding({ state: 'failed', error: failure(result.value.error) });
    } catch (error) {
      setEnding({ state: 'failed', error: failure(error) });
    } finally {
      controller.current = null;
      setRunning(null);
    }
  };

  const status = running ? `BUSCANDO${running === 'content' ? ' EN EL CONTENIDO' : ''}…`
    : ending?.state === 'completed' ? `${matches.length} RESULTADOS${ending.truncated ? ' · SE DETUVO EN EL MÁXIMO' : ''}`
      : ending?.state === 'cancelled' ? 'BÚSQUEDA CANCELADA' : ending?.state === 'interrupted' ? 'INTERRUMPIDA AL PERDER EL CONTROL' : null;

  return (
    <View style={{ flex: 1, gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Cerrar la búsqueda" onPress={() => { controller.current?.abort(); onClose(); }} style={{ minHeight: 48, minWidth: 48, justifyContent: 'center' }}>
          <T {...TYPE.body} c={K.accentText}>‹ Archivos</T>
        </Pressable>
        <M s={9.5} ls={0.04} c={K.inkTertiary} numberOfLines={1} style={{ flex: 1 }}>EN {folderLabel(folder, home).toUpperCase()}</M>
      </View>
      <TextInput accessibilityLabel="Buscar" value={query} onChangeText={setQuery} editable={!running} autoCapitalize="none" autoCorrect={false}
        placeholder="Nombre o texto" placeholderTextColor={K.inkTertiary} selectionColor={K.accent} returnKeyType="search" onSubmitEditing={() => void search(false)}
        style={{ minHeight: 48, paddingHorizontal: 14, borderRadius: RADIUS.field, boxShadow: K.shadowField, backgroundColor: K.field, fontFamily: F.sans['400'], fontSize: 15, color: K.ink }} />
      {tooLong ? <T {...TYPE.secondary} c={K.dangerText}>La búsqueda admite hasta {REMOTE_FILE_SEARCH_QUERY_BYTES} bytes.</T> : null}
      {running ? (
        <Keycap label="Cancelar" accessibilityLabel="Cancelar la búsqueda" variant="danger" onPress={() => controller.current?.abort()} />
      ) : (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Keycap label="Nombres" accessibilityLabel="Buscar nombres" disabled={query === '' || tooLong} onPress={() => void search(false)} style={{ flex: 1 }} />
          <Keycap label="Contenido" accessibilityLabel="Buscar en el contenido" disabled={query === '' || tooLong} onPress={() => void search(true)} style={{ flex: 1 }} />
        </View>
      )}
      {status ? <M {...TYPE.label} c={K.inkTertiary} accessibilityLiveRegion="polite">{status}</M> : null}
      {progress ? (
        <M s={9.5} c={K.inkTertiary}>{progress.folders} CARPETAS · {progress.files} ARCHIVOS{progress.unreadable ? ` · ${progress.unreadable} SIN PERMISO O DESAPARECIDOS` : ''}</M>
      ) : null}
      {ending?.state === 'failed' ? <T {...TYPE.secondary} c={K.dangerText} accessibilityRole="alert">{ending.error}</T> : null}
      {ending?.state === 'completed' && matches.length === 0 ? <T {...TYPE.secondary} c={K.inkSecondary}>Nada coincide.</T> : null}
      {matches.length ? (
        <ListBlock style={{ flex: 1, marginHorizontal: 0, paddingVertical: 4 }}>
          <FlatList data={matches} keyExtractor={(match, index) => `${index}:${match.path}`} ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: K.line }} />} renderItem={({ item }) => (
            <View>
              <EntryRow entry={item.entry} onOpen={() => onOpen(item)} onActions={null} />
              <M s={9.5} c={K.inkTertiary} numberOfLines={1} style={{ marginTop: -4, marginBottom: 8 }}>{folderLabel(item.path, home)}</M>
            </View>
          )} />
        </ListBlock>
      ) : null}
    </View>
  );
}
