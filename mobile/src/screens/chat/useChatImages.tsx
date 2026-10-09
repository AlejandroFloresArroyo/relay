import { usePalette } from '@/theme/ThemeProvider';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { RunCreated, RunRequest } from '../../../../protocol/protocol';
import { bindImageReceipt, imageRunRequest, type LocalImageReceipt, type PreparedImage } from '@/core/chatImages';
import { conversationRequestId } from '@/core/conversations';
import { DEMO_IMAGE_SCENARIOS, demoImageReceipts, demoImageScenario, demoPickImage, saveDemoImageReceipts, setDemoImageScenario } from '@/core/demoImages';
import { DEMO } from '@/state/app';

import { M, T } from '@/ui/primitives';
import { pickChatImage, loadImageReceipts, saveImageReceipts, discardChatImage, type ImageOrigin } from './chatImageNative';
import type { ImagesSlot } from './chatSlots';

interface Options { initialImage?: PreparedImage; preserveSharedImage?: (image: PreparedImage) => boolean; beginImageChange?: () => (() => boolean) | null; onDraftImageChange?: (image: PreparedImage | null) => void; serverId: string; agentId: string; conversationId: string | null; disabled: boolean; bottom: number;
  /** #114: on a tablet whose Puente offers `chat_files`, opens Archivos beside the Conversación. */
  serverFiles?: () => void }
const scopeKey = (server: string, agent: string, conversation: string | null) => JSON.stringify([server, agent, conversation ?? '@new']);
function ImageIcon({ camera = false, color }: { camera?: boolean; color?: string }) {
  const { K } = usePalette();
  return <Svg width={18} height={18} viewBox="0 0 24 24"><Path d={camera ? 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z' : 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01'} fill="none" stroke={color ?? K.ink} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></Svg>;
}

function LocalThumbnail({ uri, unavailable = false }: { uri: string; unavailable?: boolean }) {
  const { K } = usePalette();
  const [missing, setMissing] = useState(false);
  return missing || unavailable ? <View style={{ width: 220, height: 150, justifyContent: 'center', alignItems: 'center', backgroundColor: K.screen }}>
    <M s={9.5} c={K.onScreenLabel}>MINIATURA NO DISPONIBLE</M>
  </View> : <Image accessibilityLabel="Imagen enviada" source={{ uri }} resizeMode="cover" onError={() => setMissing(true)} style={{ width: 220, height: 150, borderRadius: 14, marginBottom: 8 }} />;
}

export function useChatImages({ initialImage, preserveSharedImage, beginImageChange, onDraftImageChange, serverId, agentId, conversationId, disabled, bottom, serverFiles }: Options): ImagesSlot {
  const { K } = usePalette();
  const scope = scopeKey(serverId, agentId, conversationId);
  const drafts = useRef(new Map<string, PreparedImage>(initialImage ? [[scope, initialImage]] : []));
  const rowsByScope = useRef(new Map<string, LocalImageReceipt[]>());
  const outgoing = useRef(new Map<string, PreparedImage>());
  const writeQueue = useRef(Promise.resolve());
  const mounted = useRef(true);
  const activeScope = useRef(scope);
  const picking = useRef(false);
  const [state, setState] = useState({ scope, pending: initialImage ?? null as PreparedImage | null, rows: [] as LocalImageReceipt[], preparing: false, open: false, error: null as string | null });
  const [demoScenario, setDemoScenario] = useState(() => demoImageScenario(serverId));
  if (state.scope !== scope) setState({ scope, pending: drafts.current.get(scope) ?? null, rows: rowsByScope.current.get(scope) ?? [], preparing: false, open: false, error: null });
  const preserveDraftImage = useEffectEvent((image: PreparedImage) => preserveSharedImage?.(image) ?? false);
  useEffect(() => { activeScope.current = scope; });
  useEffect(() => {
    mounted.current = true;
    const pendingImages = drafts.current;
    const pendingRequests = outgoing.current;
    return () => {
      mounted.current = false;
      // A request can be accepted after this screen closes. Keep its local copy until
      // its receipt is stored; an uncertain request must not destroy an accepted image.
      const inFlight = new Set([...pendingRequests.values()].map((image) => image.image.attachmentId));
      for (const image of pendingImages.values()) {
        if (!preserveDraftImage(image) && !inFlight.has(image.image.attachmentId)) void discardChatImage(image).catch(() => {});
      }
    };
  }, [initialImage]);
  useEffect(() => {
    let alive = true;
    if (conversationId) (DEMO ? Promise.resolve(demoImageReceipts(scope)) : loadImageReceipts(scope)).then((loaded) => {
      if (!alive) return;
      const current = rowsByScope.current.get(scope) ?? [];
      const rows = [...loaded.filter((row) => !current.some((known) => known.attachmentId === row.attachmentId)), ...current];
      rowsByScope.current.set(scope, rows);
      setState((previous) => previous.scope === scope ? { ...previous, rows } : previous);
    }, () => { /* A missing index does not prevent a new attachment. */ });
    return () => { alive = false; };
  }, [scope, conversationId]);

  const persist = (target: string, rows: LocalImageReceipt[]) => {
    rowsByScope.current.set(target, rows);
    if (mounted.current) setState((previous) => previous.scope === target ? { ...previous, rows } : previous);
    writeQueue.current = writeQueue.current.then(() => DEMO ? saveDemoImageReceipts(target, rows) : saveImageReceipts(target, rows)).catch(() => {
      if (mounted.current) setState((previous) => previous.scope === target ? { ...previous, error: 'La imagen se envió, pero no se pudo guardar su miniatura. Revisa el espacio del teléfono.' } : previous);
    });
  };
  const pick = async (origin: ImageOrigin) => {
    if (disabled || picking.current) return;
    const permitted = beginImageChange ? beginImageChange() : () => true;
    if (!permitted) return;
    picking.current = true;
    setState((previous) => ({ ...previous, open: false, preparing: true, error: null }));
    try {
      const image = await (DEMO ? demoPickImage(serverId) : pickChatImage(origin));
      if (!image) return;
      if (!mounted.current || !permitted()) { await discardChatImage(image); return; }
      const previous = drafts.current.get(scope);
      drafts.current.set(scope, image);
      onDraftImageChange?.(image);
      if (previous) void discardChatImage(previous).catch(() => {});
      if (activeScope.current === scope) setState((current) => current.scope === scope ? { ...current, pending: image } : current);
    } catch (failure) {
      if (mounted.current && activeScope.current === scope) setState((previous) => ({ ...previous, error: failure instanceof Error ? failure.message : 'Esta imagen no se puede preparar. Elige otra.' }));
    } finally {
      picking.current = false;
      if (mounted.current && activeScope.current === scope) setState((previous) => ({ ...previous, preparing: false }));
    }
  };
  const remove = () => {
    const image = drafts.current.get(scope); drafts.current.delete(scope);
    onDraftImageChange?.(null);
    setState((previous) => ({ ...previous, pending: null, error: null }));
    if (image) void discardChatImage(image).catch(() => {});
  };
  const accepted = (request: RunRequest, receipt: RunCreated, targetId: string, messageId: string) => {
    if (!request.clientMessageId) return;
    const image = outgoing.current.get(request.clientMessageId);
    if (!image) return;
    outgoing.current.delete(request.clientMessageId);
    const target = scopeKey(serverId, agentId, targetId);
    const row: LocalImageReceipt = { attachmentId: image.image.attachmentId, uri: image.uri, width: image.image.width, height: image.image.height,
      clientMessageId: request.clientMessageId, runId: receipt.runId, messageIds: [messageId] };
    const rows = rowsByScope.current.get(target) ?? [];
    persist(target, [...rows.filter((entry) => entry.attachmentId !== row.attachmentId), row]);
    for (const draftScope of new Set([scope, target])) {
      if (drafts.current.get(draftScope)?.image.attachmentId === image.image.attachmentId) {
        drafts.current.delete(draftScope);
        if (mounted.current) setState((previous) => previous.scope === draftScope ? { ...previous, pending: null } : previous);
      }
    }
  };
  const preview = state.pending || state.preparing || state.error ? <View style={{ marginHorizontal: 12, gap: 8 }}>
    {state.pending ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 8, borderRadius: 18, backgroundColor: K.block, boxShadow: K.shadowBlock }}>
      {/* Fixed dark scrim on the thumbnail's remove button: it sits over a photo, not over the theme. */}
      <View style={{ width: 60, height: 60, borderRadius: 12, overflow: 'hidden', backgroundColor: K.screen }}>
        <Image accessibilityLabel="Imagen adjunta" source={{ uri: state.pending.uri }} resizeMode="cover" style={{ width: 60, height: 60 }} />
        <Pressable accessibilityRole="button" accessibilityLabel="Quitar imagen" disabled={disabled || state.preparing} onPress={remove} style={{ position: 'absolute', top: 1, right: 1, width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(26,26,25,0.85)', alignItems: 'center', justifyContent: 'center' }}>
          <Svg width={10} height={10} viewBox="0 0 12 12"><Path d="M3 3l6 6M3 9l6-6" stroke={K.onScreenBright} strokeWidth={2} /></Svg>
        </Pressable>
      </View>
      <View style={{ gap: 3, flex: 1 }}><M s={9.5} ls={0.06} c={K.inkTertiary}>1 IMAGEN ADJUNTA</M><T s={12.5} c={K.inkSecondary}>Se envía junto con tu mensaje.</T></View>
    </View> : null}
    {state.preparing ? <M s={9.5} c={K.inkTertiary}>PREPARANDO IMAGEN…</M> : null}
    {state.error ? <T accessibilityRole="alert" s={13} c={K.dangerText}>{state.error}</T> : null}
  </View> : undefined;
  return {
    hasAttachment: !!state.pending, preparing: state.preparing,
    prepareSend(request) {
      const id = conversationRequestId();
      const decorated = imageRunRequest(request, state.pending, id);
      outgoing.current.clear();
      if (state.pending) outgoing.current.set(id, state.pending);
      return decorated;
    },
    moveDraft(conversationId) {
      const image = drafts.current.get(scope);
      if (!image) return;
      const target = scopeKey(serverId, agentId, conversationId);
      drafts.current.delete(scope); drafts.current.set(target, image);
    },
    rejected(request) {
      if (!request.clientMessageId) return;
      const image = outgoing.current.get(request.clientMessageId);
      outgoing.current.delete(request.clientMessageId);
      if (image && !mounted.current) void discardChatImage(image).catch(() => {});
    },
    accepted,
    inputReceipt(event) {
      for (const [target, rows] of rowsByScope.current) {
        if (rows.some((row) => row.clientMessageId === event.clientMessageId)) persist(target, bindImageReceipt(rows, event.clientMessageId, event.messageId));
      }
    },
    control: <Pressable accessibilityRole="button" accessibilityLabel="Adjuntar imagen" disabled={disabled || state.preparing} onPress={() => setState((previous) => ({ ...previous, open: !previous.open, error: null }))}
      style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: state.open ? K.ink : K.key, boxShadow: K.shadowKey, alignItems: 'center', justifyContent: 'center', opacity: disabled || state.preparing ? 0.5 : 1 }}>
      <Svg width={19} height={19} viewBox="0 0 24 24"><Path d={state.open ? 'M8 8l8 8M8 16l8-8' : 'M12 5v14M5 12h14'} stroke={state.open ? K.accent : K.ink} strokeWidth={2} strokeLinecap="round" /></Svg>
    </Pressable>, preview,
    renderUserAttachment(itemId) {
      const row = state.rows.find((entry) => entry.messageIds.includes(itemId));
      return row ? <LocalThumbnail key={row.attachmentId} uri={row.uri} unavailable={DEMO && demoScenario === 'missing'} /> : null;
    },
    overlay: state.open ? <View style={{ position: 'absolute', inset: 0 }}>
      <Pressable accessibilityLabel="Cerrar selector de imagen" onPress={() => setState((previous) => ({ ...previous, open: false }))} style={{ position: 'absolute', inset: 0, backgroundColor: K.sheetBackdrop }} />
      <View style={{ position: 'absolute', left: 12, bottom: bottom + 58, width: 266, backgroundColor: K.block, borderRadius: 22, boxShadow: K.shadowSheet, padding: 8, gap: 6 }}>
        {(['camera', 'gallery'] as const).map((origin) => <Pressable key={origin} accessibilityRole="button" onPress={() => { void pick(origin); }} style={{ height: 52, borderRadius: 15, backgroundColor: K.block, boxShadow: K.shadowKey, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14 }}>
          <ImageIcon camera={origin === 'camera'} /><T s={15} w="600">{origin === 'camera' ? 'Cámara' : 'Galería'}</T>
        </Pressable>)}
        {serverFiles ? <Pressable accessibilityRole="button" onPress={() => { setState((previous) => ({ ...previous, open: false })); serverFiles(); }} style={{ height: 52, borderRadius: 15, backgroundColor: K.block, boxShadow: K.shadowKey, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14 }}>
          <Svg width={18} height={18} viewBox="0 0 24 24"><Path d="M4 6h6l2 2h8v11H4z" fill="none" stroke={K.ink} strokeWidth={2} strokeLinejoin="round" /></Svg><T s={15} w="600">Desde el Servidor</T>
        </Pressable> : null}
        <M s={9.5} ls={0.06} lh={1.6} c={K.inkTertiary} style={{ paddingHorizontal: 8, paddingTop: 6, paddingBottom: 4 }}>{serverFiles ? 'IMÁGENES DEL TELÉFONO · ARCHIVOS DEL SERVIDOR POR REFERENCIA' : 'SOLO IMÁGENES · HERMES NO ACEPTA OTROS ARCHIVOS'}</M>
        {DEMO ? <Pressable accessibilityRole="button" accessibilityLabel="Cambiar escenario de imágenes" onPress={() => {
          const index = DEMO_IMAGE_SCENARIOS.findIndex((scenario) => scenario.id === demoScenario);
          const next = DEMO_IMAGE_SCENARIOS[(index + 1) % DEMO_IMAGE_SCENARIOS.length];
          setDemoImageScenario(serverId, next.id); setDemoScenario(next.id);
        }} style={{ minHeight: 44, paddingHorizontal: 8, justifyContent: 'center' }}><T s={12} w="600" c={K.accentText}>Imagen demo: {DEMO_IMAGE_SCENARIOS.find((scenario) => scenario.id === demoScenario)?.name} · Cambiar</T></Pressable> : null}
      </View>
    </View> : undefined,
  };
}
