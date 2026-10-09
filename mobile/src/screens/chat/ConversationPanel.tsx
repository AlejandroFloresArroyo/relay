import { usePalette } from '@/theme/ThemeProvider';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { CONVERSATION_QUERY_MAX_CHARS, CONVERSATION_TITLE_MAX_CHARS, type Conversation, type ConversationDeletionPreview } from '../../../../protocol/protocol';
import { RelayError, type RelayClient } from '@/core/client';
import { classifyConnectionError } from '@/core/connectionStatus';
import { conversationTitle } from '@/core/conversations';
import { relTime } from '@/core/format';
import { useNow } from '@/state/app';
import { F } from '@/theme/tokens';
import { ConnectionStatus } from '@/ui/ConnectionStatus';
import { Keycap, Lamp } from '@/ui/kit';
import { RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';

/** Ink on the orange «ABIERTA» tag, the same in both themes. */

interface Row { conversation: Conversation; snippet?: string; match?: 'title' | 'message' }
interface ListResult {
  client: RelayClient; agentId: string; query: string; background: boolean; offset: number; reload: number;
  rows: Row[]; nextOffset: number | null; error: unknown;
}
interface Props {
  client: RelayClient; agentId: string; agentName: string; serverName: string;
  selectedId: string | null; busy: boolean; offline: boolean; bottom: number;
  onClose: () => void; onSelect: (conversation: Conversation) => void; onNew: () => Promise<void>;
  onRename: (conversation: Conversation) => void; onDelete: (conversationId: string) => void;
  onRetryConnection: () => void; onPair: () => void;
  demoControl?: ReactNode;
  onWorkingChange: (working: boolean) => void;
}

function ConversationIcon({ conversation }: { conversation: Conversation }) {
  const { K } = usePalette();
  const path = conversation.kind === 'background' ? 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18'
    : conversation.origin === 'relay' ? 'M8 3h8v18H8zM11 18h2'
    : conversation.source === 'terminal' ? 'M4 6l6 6-6 6M13 18h7' : 'M4 5h16v11H9l-5 4z';
  return <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: K.screen, alignItems: 'center', justifyContent: 'center' }}>
    <Svg width={15} height={15} viewBox="0 0 24 24"><Path d={path} fill="none" stroke={K.onScreen} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></Svg>
  </View>;
}

export function ConversationPanel(props: Props) {
  const { K } = usePalette();
  const { client, agentId, busy, offline, onWorkingChange, onClose } = props;
  const now = useNow();
  const [query, setQuery] = useState('');
  const [background, setBackground] = useState(false);
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<ListResult | null>(null);
  const sameList = result?.client === client && result.agentId === agentId && result.query === query && result.background === background && result.reload === reload;
  const loading = !sameList || result.offset !== offset;
  const rows = sameList ? result.rows : [];
  const nextOffset = sameList ? result.nextOffset : null;
  const error = !loading && result ? result.error : null;
  const [actionId, setActionId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [title, setTitle] = useState('');
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [preview, setPreview] = useState<ConversationDeletionPreview | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const mounted = useRef(true);
  const actionLock = useRef(false);
  const listEpoch = useRef(0);

  useEffect(() => {
    const epoch = listEpoch;
    mounted.current = true;
    return () => { mounted.current = false; epoch.current++; onWorkingChange(false); };
  }, [onWorkingChange]);
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (actionLock.current) return true;
      if (renaming || deleting) { setRenaming(null); setDeleting(null); setActionError(null); }
      else onClose();
      return true;
    });
    return () => subscription.remove();
  }, [renaming, deleting, onClose]);

  useEffect(() => {
    let alive = true;
    const epoch = ++listEpoch.current;
    const q = query.trim();
    const request = q
      ? client.searchConversations(agentId, { q, background, limit: 50, offset }).then((page) => ({ rows: page.hits.map((hit) => ({ conversation: hit.conversation, snippet: hit.snippet, match: hit.match })), nextOffset: page.nextOffset }))
      : client.conversations(agentId, { background, limit: 50, offset }).then((page) => ({ rows: page.conversations.map((conversation) => ({ conversation })), nextOffset: page.nextOffset }));
    request.then((page) => {
      if (!alive || !mounted.current || epoch !== listEpoch.current) return;
      setResult((previous) => {
        const previousRows = offset !== 0 && previous?.client === client && previous.agentId === agentId && previous.query === query && previous.background === background && previous.reload === reload ? previous.rows : [];
        return { client, agentId, query, background, offset, reload, rows: [...previousRows, ...page.rows.filter((row) => !previousRows.some((old) => old.conversation.id === row.conversation.id))], nextOffset: page.nextOffset, error: null };
      });
    }, (failure) => {
      if (!alive || !mounted.current || epoch !== listEpoch.current) return;
      setResult({ client, agentId, query, background, offset, reload, rows: [], nextOffset: null, error: failure });
    });
    return () => { alive = false; };
  }, [client, agentId, query, background, offset, reload]);

  const resetList = () => { listEpoch.current++; setOffset(0); setReload((n) => n + 1); };
  const perform = async (operation: () => Promise<void>) => {
    if (actionLock.current || busy || offline || networkError) return;
    actionLock.current = true; setWorking(true); props.onWorkingChange(true); setActionError(null);
    try { await operation(); }
    catch (failure) { if (mounted.current) setActionError(failure instanceof Error ? failure.message : 'No se pudo completar la acción. Reintenta.'); }
    finally { actionLock.current = false; if (mounted.current) { setWorking(false); props.onWorkingChange(false); } }
  };
  const loadDeletion = (conversation: Conversation) => perform(async () => {
    setDeleting(conversation); setPreview(null);
    const fresh = await client.conversationDeletion(agentId, conversation.id);
    if (mounted.current) setPreview(fresh);
  });
  const confirmDelete = () => perform(async () => {
    if (!deleting || !preview) return;
    try {
      await client.deleteConversation(agentId, deleting.id, { revision: preview.revision });
      if (!mounted.current) return;
      props.onDelete(deleting.id); setDeleting(null); setPreview(null); setActionId(null); resetList();
    } catch (failure) {
      if (failure instanceof RelayError && failure.code === 'conversation_changed') {
        if (!mounted.current) return;
        setPreview(null);
        const fresh = await client.conversationDeletion(agentId, deleting.id);
        if (mounted.current) { setPreview(fresh); setActionError('La conversación cambió. Revisa el nuevo conteo y confirma de nuevo.'); }
      } else throw failure;
    }
  });
  const saveTitle = () => perform(async () => {
    if (!renaming) return;
    const trimmed = title.trim();
    if (!trimmed || Array.from(trimmed).length > CONVERSATION_TITLE_MAX_CHARS) throw new Error('El título debe tener entre 1 y 100 caracteres.');
    const updated = await client.renameConversation(agentId, renaming.id, { title: trimmed });
    if (!mounted.current) return;
    props.onRename(updated); setRenaming(null); setActionId(null); resetList();
  });
  const networkError = error instanceof RelayError && ['unreachable', 'timeout', 'key_unknown', 'device_revoked', 'pairing_required', 'unauthorized', 'rate_limited', 'cleartext_blocked', 'tailnet_required'].includes(error.code);
  const protectedFocus = renaming !== null || deleting !== null;

  const empty = (lamps: [boolean, boolean], title: string, titleInk: string, phrase: string, action?: ReactNode) => <RecessedScreen radius={20} style={{ padding: 20, gap: 12 }}>
    <View style={{ flexDirection: 'row', gap: 6 }}><Lamp size={9} tone="off" onScreen /><Lamp size={9} tone={lamps[0] ? 'orange' : 'off'} onScreen /><Lamp size={9} tone={lamps[1] ? 'red' : 'off'} onScreen /></View>
    <M s={13} w="600" ls={0.08} c={titleInk}>{title}</M>
    <T s={15} lh={1.45} c={K.onScreen}>{phrase}</T>
    {action}
  </RecessedScreen>;

  return <View style={StyleSheet.absoluteFill}>
    <Pressable accessibilityLabel="Cerrar panel de conversaciones" onPress={() => { if (!working) props.onClose(); }} style={[StyleSheet.absoluteFill, { backgroundColor: K.sheetBackdrop }]} />
    <View style={{ flex: 1, marginHorizontal: 12, marginTop: 8, marginBottom: props.bottom, padding: 12, gap: 10, borderRadius: 24, backgroundColor: K.block, boxShadow: K.shadowBlock }}>
      <View aria-hidden={protectedFocus} accessibilityElementsHidden={protectedFocus} importantForAccessibility={protectedFocus ? 'no-hide-descendants' : 'auto'} style={{ flex: 1, gap: 10 }}>
        <Keycap variant="primary" disabled={busy || working || offline || networkError} onPress={() => void perform(props.onNew)}
          accessibilityLabel={`Conversación nueva con ${props.agentName}`} label={working && !protectedFocus ? 'Creando conversación…' : 'Conversación nueva'} />
        {busy ? <T s={13} c={K.inkSecondary}>Espera a que termine el Turno para cambiar, crear o borrar una conversación.</T> : null}
        {props.demoControl}
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <View style={{ flex: 1, minWidth: 0, minHeight: 48, borderRadius: 24, backgroundColor: K.field, boxShadow: K.shadowField, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Svg width={15} height={15} viewBox="0 0 24 24"><Circle cx={11} cy={11} r={6.5} stroke={K.inkTertiary} strokeWidth={2} fill="none" /><Path d="M20 20l-4-4" stroke={K.inkTertiary} strokeWidth={2} /></Svg>
            <TextInput accessibilityLabel="Buscar conversaciones" placeholder="Buscar en las conversaciones" placeholderTextColor={K.inkTertiary} value={query} maxLength={CONVERSATION_QUERY_MAX_CHARS} editable={!offline && !networkError} onChangeText={(value) => { listEpoch.current++; setQuery(value); setOffset(0); }} style={{ flex: 1, minWidth: 0, fontFamily: F.sans['400'], fontSize: 15, color: K.ink, padding: 0 }} />
          </View>
          <Pressable accessibilityRole="switch" accessibilityLabel="De fondo" accessibilityState={{ checked: background }} disabled={offline || networkError} onPress={() => { listEpoch.current++; setBackground(!background); setOffset(0); }} style={{ minHeight: 48, paddingHorizontal: 12, borderRadius: 14, backgroundColor: background ? K.ink : K.key, boxShadow: background ? undefined : K.shadowKey, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Lamp tone={background ? 'orange' : 'off'} size={6} /><M s={9.5} ls={0.06} c={background ? K.block : K.inkSecondary}>DE FONDO</M>
          </Pressable>
        </View>
        <View style={{ paddingHorizontal: 6, flexDirection: 'row', gap: 8, justifyContent: 'space-between' }}>
          <M s={9.5} ls={0.06} c={error && !networkError ? K.dangerText : K.inkTertiary}>{loading ? 'CARGANDO CONVERSACIONES…' : error ? 'LECTURA NO DISPONIBLE' : `${rows.length} ${query.trim() ? 'RESULTADOS' : background ? 'DE FONDO' : 'CONVERSACIONES'}`}</M>
          {!loading && !error ? <M s={9.5} c={K.inkTertiary}>{background ? 'TAREAS · SUBAGENTES' : 'MÁS RECIENTE ARRIBA'}</M> : null}
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1, borderRadius: 20, backgroundColor: K.field, boxShadow: K.shadowField }} contentContainerStyle={{ padding: 4, flexGrow: 1 }}>
          {offline || networkError ? <ConnectionStatus serverName={props.serverName} diagnosis={classifyConnectionError(error)} onPair={props.onPair} onRetry={() => { resetList(); props.onRetryConnection(); }} />
            : error ? empty([false, true], 'NO SE PUDIERON CARGAR', K.dangerTextOnScreen, error instanceof Error ? error.message : 'El Servidor respondió con un error al pedir las conversaciones.',
              <Keycap variant="screen" label="Reintentar" onPress={resetList} style={{ alignSelf: 'flex-start' }} />)
            : loading && offset === 0 ? <View accessibilityLabel="Cargando conversaciones…" style={{ padding: 10, gap: 20 }}>{[0, 1, 2, 3, 4, 5].map((i) => <View key={i} style={{ flexDirection: 'row', gap: 10, paddingVertical: 6 }}><View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: K.ledOff }} /><View style={{ flex: 1, gap: 7 }}><View style={{ width: '70%', height: 10, backgroundColor: K.ledOff, borderRadius: 3 }} /><View style={{ width: '90%', height: 8, backgroundColor: K.line, borderRadius: 3 }} /><View style={{ width: '40%', height: 6, backgroundColor: K.line, borderRadius: 3 }} /></View></View>)}</View>
            : rows.length === 0 ? empty([query.trim() !== '', false], query.trim() ? `NADA COINCIDE CON «${query.trim()}»` : 'SIN CONVERSACIONES', query.trim() ? K.accent : K.onScreenBright,
              query.trim() ? 'Se buscó en los títulos y en los mensajes de las conversaciones.' : `${props.agentName} todavía no tiene conversaciones${background ? ' de fondo' : ''}. Aquí aparecerán también las que empiecen en otros canales.`,
              query.trim() ? <Keycap variant="screen" label="Borrar búsqueda" onPress={() => { listEpoch.current++; setQuery(''); setOffset(0); }} style={{ alignSelf: 'flex-start' }} /> : undefined)
            : rows.map(({ conversation, snippet, match }, index) => {
              const name = conversationTitle(conversation);
              const expanded = actionId === conversation.id;
              const unavailable = busy || working || conversation.state !== 'ready';
              return <View key={conversation.id} style={{ borderTopWidth: index && !expanded ? 1 : 0, borderTopColor: K.line, borderRadius: expanded ? 20 : 0, backgroundColor: expanded ? K.block : 'transparent', ...(expanded ? { borderWidth: 1, borderColor: K.accent } : {}) }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 10, paddingRight: 4, gap: 10 }}>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Abrir conversación ${name}`} disabled={unavailable} onPress={() => props.onSelect(conversation)} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, opacity: unavailable ? 0.55 : 1 }}>
                    <ConversationIcon conversation={conversation} />
                    <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}><T s={15} w="700" c={K.ink} numberOfLines={1} style={{ flex: 1 }}>{name}</T>{conversation.id === props.selectedId ? <M s={9.5} w="600" c={K.onAccent} style={{ backgroundColor: K.accent, paddingHorizontal: 4, paddingVertical: 2, borderRadius: 4 }}>ABIERTA</M> : null}<M s={9.5} c={K.inkTertiary}>{relTime(conversation.lastActiveAt, now)}</M></View>
                      <T s={13} c={K.inkSecondary} numberOfLines={1}>{snippet ?? conversation.preview ?? 'Sin mensajes'}</T>
                      <M s={9.5} c={K.inkTertiary} numberOfLines={1}>{conversation.originLabel.toUpperCase()} · {conversation.messageCount} MENSAJES{match === 'message' ? ' · EN MENSAJE' : ''}</M>
                    </View>
                  </Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Acciones de ${name}`} disabled={working} onPress={() => { setActionId(expanded ? null : conversation.id); setActionError(null); }} style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: expanded ? K.ink : K.key, boxShadow: expanded ? undefined : K.shadowKey }}>
                    <Svg width={18} height={6} viewBox="0 0 18 6">{[3, 9, 15].map((cx) => <Circle key={cx} cx={cx} cy={3} r={1.2} fill={expanded ? K.accent : K.inkTertiary} />)}</Svg>
                  </Pressable>
                </View>
                {expanded ? <View style={{ flexDirection: 'row', padding: 8, paddingTop: 0, gap: 6 }}>
                  <Keycap variant="primary" label="ABRIR" disabled={unavailable} onPress={() => props.onSelect(conversation)} style={{ flex: 1 }} />
                  <Keycap label="RENOMBRAR" disabled={unavailable || offline} onPress={() => { setRenaming(conversation); setTitle(conversation.title ?? ''); setActionError(null); }} style={{ flex: 1 }} />
                  <Keycap variant="danger" label="BORRAR" disabled={busy || working || offline} onPress={() => void loadDeletion(conversation)} style={{ flex: 1 }} />
                </View> : null}
              </View>;
            })}
          {!error && nextOffset !== null ? <Keycap disabled={loading} label={loading ? 'Cargando…' : 'Cargar más'} onPress={() => { listEpoch.current++; setOffset(nextOffset); }} style={{ margin: 8 }} /> : null}
        </ScrollView>
        {actionError && !protectedFocus ? <T accessibilityRole="alert" s={13} c={K.dangerText}>{actionError}</T> : null}
      </View>
      {protectedFocus ? <View accessibilityViewIsModal style={[StyleSheet.absoluteFill, { backgroundColor: K.sheetBackdrop, borderRadius: 24, justifyContent: renaming ? 'flex-end' : 'center', padding: 12 }]}>
        <View style={{ padding: 16, gap: 14, borderRadius: 24, backgroundColor: K.block, boxShadow: K.shadowBlock }}>
          <RecessedScreen radius={16} style={{ padding: 16, gap: 8 }}><M s={11} ls={0.06} c={deleting ? K.dangerTextOnScreen : K.accent}>{deleting ? '¿BORRAR CONVERSACIÓN?' : 'RENOMBRAR CONVERSACIÓN'}</M><T s={16} w="700" c={K.onScreenBright}>{conversationTitle(deleting ?? renaming)}</T></RecessedScreen>
          {renaming ? <><TextInput accessibilityLabel="Título de la conversación" autoFocus value={title} onChangeText={setTitle} editable={!working} onSubmitEditing={saveTitle} style={{ minHeight: 48, borderRadius: 12, backgroundColor: K.field, boxShadow: K.shadowField, paddingHorizontal: 14, fontFamily: F.sans['400'], fontSize: 16, color: K.ink }} /><T s={13} c={K.inkSecondary}>{Array.from(title).length}/100 · El título debe ser único.</T></>
            : <T s={15} lh={1.45} c={K.inkSecondary}>{preview ? `${preview.messageCount === 1 ? 'Se borrará 1 mensaje' : `Se borrarán sus ${preview.messageCount} mensajes`}${preview.conversationCount > 1 ? ` de ${preview.conversationCount} continuaciones` : ''}. No se puede deshacer.` : working ? 'Contando los mensajes…' : 'No se pudo obtener el conteo de mensajes. Reintenta. Sin el conteo no se puede borrar.'}</T>}
          {actionError ? <T accessibilityRole="alert" s={13} c={K.dangerText}>{actionError}</T> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Keycap label="Cancelar" disabled={working} onPress={() => { setRenaming(null); setDeleting(null); setActionError(null); }} style={{ flex: 1 }} />
            {renaming ? <Keycap variant="primary" label={working ? 'Guardando…' : 'Guardar'} disabled={working || busy || offline || !title.trim() || Array.from(title.trim()).length > 100} onPress={() => void saveTitle()} style={{ flex: 1 }} />
              : <Keycap variant={preview ? 'danger' : 'primary'} label={working ? 'Espera…' : preview ? 'Borrar' : 'Reintentar'} disabled={working || busy || offline} onPress={() => { if (preview) void confirmDelete(); else if (deleting) void loadDeletion(deleting); }} style={{ flex: 1 }} />}
          </View>
        </View>
      </View> : null}
    </View>
  </View>;
}
