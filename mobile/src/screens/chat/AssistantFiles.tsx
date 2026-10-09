import { usePalette } from '@/theme/ThemeProvider';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Image, Platform, Pressable, View } from 'react-native';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { startActivityAsync } from 'expo-intent-launcher';
import Svg, { Path, Rect } from 'react-native-svg';
import type { ConversationFile, ConversationFiles } from '../../../../protocol/protocol';
import { RelayError, type RelayClient } from '@/core/client';
import { fileBadge, fileSize, localFileName } from '@/core/files';
import { DEMO } from '@/state/app';
import { demoFileScenario } from '@/core/demoFiles';

import { RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';

export function useConversationFiles({ client, serverId, agentId, conversationId, revision, enabled, errorMessageId }: {
  client: RelayClient; serverId: string; agentId: string; conversationId: string | null; revision: string; enabled: boolean; errorMessageId: string | null;
}) {
  const { K } = usePalette();
  const scope = JSON.stringify([serverId, agentId, conversationId]);
  const [result, setResult] = useState<{ scope: string; page: ConversationFiles; error: string | null }>({ scope, page: { files: [], nextOffset: null }, error: null });
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState<{ scope: string; messageId: string; text: string } | null>(null);
  useEffect(() => {
    let alive = true;
    if (!conversationId || !enabled) return;
    const load = async () => {
      const files: ConversationFile[] = [], displayMessages: NonNullable<ConversationFiles['displayMessages']> = [];
      let offset = 0;
      for (;;) {
        const page = await client.conversationFiles(agentId, conversationId, { limit: 50, offset });
        if (!alive) return;
        files.push(...page.files); displayMessages.push(...(page.displayMessages ?? []));
        if (page.nextOffset === null) break;
        if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset || files.length >= 500) throw new RelayError('http', 'La lista de archivos no se pudo completar.');
        offset = page.nextOffset;
      }
      if (alive) {
        setResult({ scope, page: { files, displayMessages, nextOffset: null }, error: null });
        setNotice((previous) => previous?.scope === scope ? { ...previous, text: 'La lista de archivos se actualizó. Vuelve a abrir o compartir el archivo.' } : previous);
      }
    };
    void load().catch(() => { if (alive) setResult({ scope, page: { files: [], nextOffset: null }, error: 'No se pudieron cargar los archivos. Reintenta.' }); });
    return () => { alive = false; };
  }, [client, agentId, conversationId, revision, enabled, scope, retry]);
  const current: { page: ConversationFiles; error: string | null } = result.scope === scope ? result : { page: { files: [], nextOffset: null }, error: null };
  return {
    displayText: (messageId: string, original: string) => current.page.displayMessages?.find((entry) => entry.messageId === messageId)?.text ?? original,
    render: (messageId: string): ReactNode => <>
      {current.page.files.filter((file) => file.messageId === messageId).map((file) => <AssistantFile key={`${scope}:${file.id}`} file={file} client={client} serverId={serverId} agentId={agentId} conversationId={conversationId!} onTicketExpired={() => { setNotice({ scope, messageId, text: 'El enlace de descarga venció. Reintenta cargar la lista de archivos.' }); setRetry((value) => value + 1); }} onDownloaded={() => setNotice(null)} />)}
      {notice?.scope === scope && notice.messageId === messageId ? <T accessibilityRole="alert" s={12} c={K.accentText}>{notice.text}</T> : null}
      {current.error && messageId === errorMessageId ? <RecessedScreen radius={16} style={{ padding: 10 }}><T s={13} c={K.dangerText}>{current.error}</T><Pressable accessibilityRole="button" onPress={() => setRetry((value) => value + 1)} style={{ minHeight: 44, justifyContent: 'center' }}><M c={K.accentText}>Reintentar</M></Pressable></RecessedScreen> : null}
    </>,
  };
}

function AssistantFile({ file, client, serverId, agentId, conversationId, onTicketExpired, onDownloaded }: { onTicketExpired(): void; onDownloaded(): void; file: ConversationFile; client: RelayClient; serverId: string; agentId: string; conversationId: string }) {
  const { K } = usePalette();
  const [progress, setProgress] = useState<number | null>(DEMO && demoFileScenario(serverId) === 'downloading' && file.id === 'demo-zip' ? Math.round(file.size! * 0.62) : null);
  const [localUri, setLocalUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState(file.status);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); }, []);
  const actOnFile = async (action: 'open' | 'share') => {
    if (active.current || status !== 'ready') return;
    const control = new AbortController(); active.current = control; setError(null);
    let partial: File | null = null;
    try {
      if (Platform.OS === 'web') throw new RelayError('unavailable', 'Abrir y compartir archivos está disponible en Android.');
      const directory = new Directory(Paths.cache, 'relay-files', encodeURIComponent(serverId), encodeURIComponent(agentId), encodeURIComponent(conversationId), encodeURIComponent(file.id));
      directory.create({ idempotent: true, intermediates: true });
      const saved = new File(directory, localFileName(file.name));
      let mimeType = file.mimeType;
      if (!saved.exists || file.size !== null && saved.size !== file.size) {
        setProgress(0); partial = new File(directory, '.part'); partial.create({ overwrite: true });
        const handle = partial.open(FileMode.WriteOnly); let bytes = 0;
        try {
          const downloaded = await client.downloadConversationFile(agentId, conversationId, file.id, async (chunk) => {
            if (control.signal.aborted) throw new RelayError('cancelled', 'Descarga cancelada.');
            handle.writeBytes(chunk); bytes += chunk.byteLength; setProgress(bytes);
          }, control.signal);
          mimeType = downloaded.mimeType;
          if (partial.size !== downloaded.bytes || file.size !== null && downloaded.bytes !== file.size) throw new RelayError('http', 'La descarga quedó incompleta. Reintenta.');
        } finally { handle.close(); }
        if (control.signal.aborted) return;
        await partial.move(saved, { overwrite: true });
        if (control.signal.aborted) return;
        partial = null;
      }
      setLocalUri(saved.uri); setProgress(null); onDownloaded();
      if (control.signal.aborted) return;
      if (action === 'open') await startActivityAsync('android.intent.action.VIEW', { data: saved.contentUri, type: mimeType, flags: 1 });
      else {
        if (!await Sharing.isAvailableAsync()) throw new RelayError('unavailable', 'No hay una app disponible para compartir este archivo.');
        if (!control.signal.aborted) await Sharing.shareAsync(saved.uri, { mimeType, dialogTitle: `Compartir ${file.name}` });
      }
    } catch (failure) {
      if (!control.signal.aborted) {
        if (failure instanceof RelayError && failure.code === 'file_ticket_expired') onTicketExpired();
        else if (failure instanceof RelayError && failure.code === 'file_not_found') setStatus('missing');
        else if (failure instanceof RelayError && failure.code === 'file_too_large') setStatus('too_large');
        else if (failure instanceof RelayError && failure.code === 'file_blocked') setStatus('blocked');
        else setError('No se pudo completar la acción. Reintenta.');
      }
    } finally {
      if (partial?.exists) { try { partial.delete(); } catch {} }
      if (active.current === control) { active.current = null; setProgress(null); }
    }
  };
  const loading = progress !== null;
  const image = file.mimeType.startsWith('image/');
  const badge = fileBadge(file.name);
  const stateText = status === 'too_large' ? 'PESA MÁS DE 50 MB · NO SE PUEDE DESCARGAR DESDE RELAY' : status === 'missing' ? 'YA NO ESTÁ EN EL SERVIDOR' : status === 'blocked' ? 'EL ARCHIVO NO SE PUEDE ENTREGAR' : null;
  return <RecessedScreen radius={18} style={{ padding: 10, gap: 10 }}>
    {image ? localUri ? <Image source={{ uri: localUri }} accessibilityLabel={`Vista previa de ${file.name}`} style={{ width: '100%', height: 140, borderRadius: 9 }} resizeMode="contain" /> : <View accessibilityLabel={`Imagen ${file.name}`} style={{ height: 140, backgroundColor: K.background, borderRadius: 9, borderWidth: 1, borderStyle: 'dashed', borderColor: K.inkTertiary, alignItems: 'center', justifyContent: 'center', gap: 8 }}><Svg width={24} height={24} viewBox="0 0 24 24"><Rect x={3} y={3} width={18} height={18} rx={2} stroke={K.inkTertiary} strokeWidth={1.8} fill="none" /><Path d="M4 17l5-5 4 4 3-3 5 6M8 8h1" stroke={K.inkTertiary} strokeWidth={1.8} fill="none" /></Svg><T s={13} c={K.inkSecondary}>{file.name}</T></View> : null}
    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
      {!image ? <View style={{ width: 42, height: 48, borderRadius: 9, backgroundColor: K.screen, alignItems: 'center', justifyContent: 'center' }}><M s={9.5} w="600" c={K.accent}>{badge}</M></View> : null}
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}><T w="700" s={14} numberOfLines={2}>{file.name}</T><M s={9.5} ls={0.05} c={K.inkTertiary}>{`${image ? 'IMAGEN' : 'ARCHIVO'} ${badge} · ${fileSize(file.size)}`}</M></View>
    </View>
    {/* Fixed translucent tints of accent/danger: they read the same over either theme. */}
    {stateText ? <View style={{ backgroundColor: status === 'too_large' ? 'rgba(242,154,26,0.12)' : 'rgba(229,83,61,0.10)', borderRadius: 11, padding: 10 }}><M s={9.5} w="600" ls={0.05} c={status === 'too_large' ? K.accentText : K.dangerText} accessibilityRole="alert">{stateText}</M></View> : loading ? <View style={{ gap: 6 }}>
      <View accessibilityRole="progressbar" accessibilityLabel={`Descargando ${file.name}…`} accessibilityValue={{ min: 0, max: file.size ?? Math.max(progress, 1), now: progress }} style={{ height: 8, backgroundColor: K.field, borderRadius: 4, overflow: 'hidden', boxShadow: K.shadowField }}><View style={{ height: 8, borderRadius: 4, backgroundColor: K.accent, width: file.size ? `${Math.min(progress / file.size * 100, 100)}%` : '25%' }} /></View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><M s={9.5} c={K.inkTertiary}>DESCARGANDO · {fileSize(progress)}{file.size === null ? '' : ` DE ${fileSize(file.size)}`}</M><Pressable accessibilityRole="button" accessibilityLabel={`Cancelar descarga de ${file.name}`} onPress={() => { if (active.current) active.current.abort(); else setProgress(null); }} style={{ minHeight: 44, justifyContent: 'center' }}><M s={9.5} c={K.accentText}>CANCELAR</M></Pressable></View>
    </View> : <View style={{ flexDirection: 'row', gap: 6 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Abrir ${file.name}`} onPress={() => { void actOnFile('open'); }} style={{ flex: 1, minHeight: 44, borderRadius: 11, backgroundColor: K.ink, alignItems: 'center', justifyContent: 'center' }}><M s={9.5} ls={0.04} c={K.onScreenBright}>ABRIR</M></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`Compartir ${file.name}`} onPress={() => { void actOnFile('share'); }} style={{ flex: 1, minHeight: 44, borderRadius: 11, alignItems: 'center', justifyContent: 'center', boxShadow: K.shadowKey }}><M s={9.5} ls={0.04} c={K.inkSecondary}>COMPARTIR</M></Pressable>
    </View>}
    {error ? <T s={12} c={K.dangerText} accessibilityRole="alert">{error}</T> : null}
  </RecessedScreen>;
}
