import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, ScrollView, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { shareText, type SharedPayload } from '@/core/sharedDrafts';
import { shareReceiver } from '@/native/externalShare';
import { DEMO, useApp } from '@/state/app';
import { useDraftStore } from '@/state/sharedDrafts';
import { useShareScope } from '@/state/useShareScope';
import { F, RADIUS, TYPE } from '@/theme/tokens';
import { usePalette } from '@/theme/ThemeProvider';
import { HomeIndicator, useBottomInset } from '@/ui/chrome';
import { Keycap, Lamp } from '@/ui/kit';
import { M, T } from '@/ui/primitives';
import { SubjectStateBlock } from '@/ui/states';
import { discardChatImage, prepareSharedChatImage } from './chat/chatImageNative';
import { demoPickImage } from '@/core/demoImages';
import { SHARE_DEMOS, demoSharePayload } from '@/core/demoShare';

export function ShareScreen() {
  const { clientFor } = useApp();
  const [session, setSession] = useState({ clientFor, revision: 0 });
  if (session.clientFor !== clientFor) setSession({ clientFor, revision: session.revision + 1 });
  return <ShareSurface key={session.revision} />;
}
function ShareSurface() {
  const { K } = usePalette();
  const { servers, clientFor, snapshot, selectServer } = useApp(); const store = useDraftStore();
  const [destination, setDestination] = useState({ server: '', agent: '' });
  const server = servers.find((row) => row.id === destination.server);
  const snap = server ? snapshot(server.id) : null;
  const client = server ? clientFor(server.id) : null;
  const target = useMemo(() => client && server ? { serverId: server.id, agentId: destination.agent, client } : null, [client, server, destination.agent]);
  const identity = useMemo(() => ({ clientFor, target }), [clientFor, target]);
  const permitted = (!server || snap?.down?.action !== 'pair') && (!client || !store.isRetired(client));
  const control = useShareScope(identity, permitted);
  const [payload, setPayload] = useState<SharedPayload | null>(null);
  const [token, setToken] = useState(''); const [tokens, setTokens] = useState<string[]>([]);
  const [instruction, setInstruction] = useState(''); const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null); const [replacement, setReplacement] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false); const [demo, setDemo] = useState('text');
  const busyRef = useRef(false); const tokenRef = useRef(''); const bottom = useBottomInset(24);
  const [previewScope, setPreviewScope] = useState({ visible: control.visible, revision: control.revision, demo });
  if (previewScope.visible !== control.visible || previewScope.revision !== control.revision || previewScope.demo !== demo) {
    setPreviewScope({ visible: control.visible, revision: control.revision, demo });
    setPayload(null); setReplacement(null); setError(null); setInstruction(''); setBusy(false);
    setDestination({ server: '', agent: '' });
  }
  // Preview authority is interrupted by lock, app/window blur, routing or credential change.
  useEffect(() => {
    if (!control.visible) return;
    let alive = true; const permission = control.begin();
    const load = async () => {
      try {
        const pending = await (DEMO ? Promise.resolve(demo === 'new-intent' ? ['demo', 'demo-next'] : ['demo']) : shareReceiver.pending());
        if (!alive || !permission?.()) return;
        setTokens(pending); setEmpty(!pending.length || (DEMO && demo === 'empty'));
        const next = pending.includes(tokenRef.current) ? tokenRef.current : pending[0];
        if (!next) return;
        let content = DEMO ? demoSharePayload(demo) : await shareReceiver.read(next);
        if (DEMO && content?.kind === 'image') { const image = await demoPickImage('share-preview'); if (image) content = { ...content, uri: image.uri }; }
        if (!alive || !permission()) return;
        tokenRef.current = next; setToken(next); setPayload(content ?? (DEMO ? null : { kind: 'rejected' }));
      } catch { if (alive && permission?.()) setError('El contenido no se pudo leer. Compártelo de nuevo.'); }
    };
    void load();
    const sub = shareReceiver.subscribe(() => { void (async () => {
      const currentPermission = control.begin();
      try { const pending = await shareReceiver.pending(); if (alive && currentPermission?.()) setTokens(pending); } catch { /* No payload exposed. */ }
    })(); });
    return () => { alive = false; sub.remove(); };
    // Selected targets belong to the same preview; credential changes invalidate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [control.visible, control.revision, clientFor, demo]);
  const unreachableOf = (id: string) => snapshot(id).reachable === false || (DEMO && demo === 'offline');
  // A chosen Agente stops being chosen when its Servidor stops answering.
  const chosen = !!target?.agentId && !(server && unreachableOf(server.id));
  const choose = (serverId: string, agentId: string) => { setDestination({ server: serverId, agent: agentId }); setReplacement(null); };
  const prepare = async (replaceId?: string) => {
    const permission = control.begin();
    if (!permission || !payload || payload.kind === 'rejected' || !target?.agentId || !chosen || busyRef.current) return;
    if (DEMO && demo === 'conflict' && !store.read(target)) store.put(target, { text: 'Borrador anterior de demostración', image: null }, permission);
    const existing = store.read(target);
    if (existing && existing.id !== replaceId) { setReplacement(existing.id); return; }
    busyRef.current = true; setBusy(true); setError(null);
    let prepared = null;
    try {
      const text = shareText(payload.kind === 'text' ? payload.text : '', instruction);
      if (DEMO && demo === 'error') throw new Error('fixture');
      if (DEMO && demo === 'preparing') await new Promise<void>((resolve) => setTimeout(resolve, 1800));
      if (payload.kind === 'image') prepared = DEMO ? await demoPickImage('share-preview') : await prepareSharedChatImage(payload);
      if (!permission()) { if (prepared) await discardChatImage(prepared); return; }
      const draft = store.put(target, { text, image: prepared }, permission, replaceId);
      if (!draft) { if (prepared) await discardChatImage(prepared); if (permission()) setError('No se pudo conservar el borrador. Reintenta. Si sigue igual, revisa los borradores pendientes.'); return; }
      // Local draft receipt precedes navigation; no Conversation or Turno request occurs here.
      if (!DEMO) void shareReceiver.discard(token).catch(() => {});
      // An external entry: the target's Servidor becomes the selected one; replace, so the consumed sheet is not under the chat.
      if (permission()) { selectServer(target.serverId); router.replace({ pathname: '/chat/[server]/[agent]', params: { server: target.serverId, agent: target.agentId, shareDraft: draft.id, entry: '1' } }); }
    } catch { if (prepared) await discardChatImage(prepared).catch(() => {}); if (permission()) setError('El borrador no se preparó. Reduce el contenido o comparte otra imagen.'); }
    finally { busyRef.current = false; if (permission()) setBusy(false); }
  };
  const next = async () => {
    const permission = control.begin(); if (!permission || busyRef.current) return;
    const id = tokens.find((row) => row !== token); if (!id) return;
    try { const content = DEMO ? demoSharePayload('text') : await shareReceiver.read(id); if (permission()) { tokenRef.current = id; setToken(id); setPayload(content ?? { kind: 'rejected' }); setInstruction(''); setReplacement(null); } }
    catch { if (permission()) setError('El contenido no se pudo leer. Compártelo de nuevo.'); }
  };
  const cancel = () => { if (!control.begin()?.()) return; if (!DEMO && token) void shareReceiver.discard(token).catch(() => {}); router.back(); };
  return <View accessibilityLabel="Compartir con Relay" style={{ flex: 1, backgroundColor: K.background, justifyContent: 'flex-end' }}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, justifyContent: 'flex-end' }}>
      <View style={{ backgroundColor: K.block, borderTopLeftRadius: 24, borderTopRightRadius: 24, boxShadow: K.shadowBlock, paddingHorizontal: 24, paddingTop: 8, paddingBottom: bottom, gap: 12, width: '100%', maxWidth: 620, alignSelf: 'center' }}>
        <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: K.ledOff, alignSelf: 'center' }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}><T {...TYPE.subtitle} ls={-0.015} c={K.ink} accessibilityRole="header" style={{ flex: 1 }}>Compartir a un Agente</T><Keycap variant="link" label="Cancelar" onPress={cancel} /></View>
        {DEMO ? <ScrollView horizontal contentContainerStyle={{ gap: 6 }}>{SHARE_DEMOS.map((row) => <Keycap key={row.id} label={row.name} onPress={() => setDemo(row.id)} />)}</ScrollView> : null}
        {!control.visible ? <T {...TYPE.secondary} c={K.inkSecondary}>Desbloquea Relay para revisar el contenido.</T> : <>
          {empty ? <SubjectStateBlock spec={{ kind: 'empty', title: 'NADA QUE COMPARTIR', phrase: 'Relay solo admite texto, enlaces e imágenes.' }} /> : !payload ? <T {...TYPE.secondary} c={K.inkSecondary}>Preparando vista previa…</T> : payload.kind === 'rejected' ? <>
            <SubjectStateBlock spec={{ kind: 'error', title: 'ESTE CONTENIDO NO SE PUEDE COMPARTIR', phrase: payload.reason === 'queue_full' ? 'Hay tres contenidos pendientes. Este contenido nuevo no se guardó. Revisa los anteriores y vuelve a compartirlo.' : payload.reason === 'busy' ? 'Se está copiando otro contenido. Espera y comparte éste de nuevo.' : 'Comparte texto o una sola imagen JPEG, PNG o WebP. No se admiten archivos ni varias imágenes.' }} />
            <Keycap label="Entendido" onPress={cancel} />
          </> : <>
            <View style={{ padding: 12, borderRadius: 16, backgroundColor: K.field, boxShadow: K.shadowField, gap: 4 }}>
              {payload.kind === 'text' ? <M {...TYPE.data} c={K.ink} selectable>{payload.text}</M> : <Image accessibilityLabel="Imagen compartida" source={{ uri: payload.uri }} resizeMode="contain" style={{ width: '100%', height: 140 }} />}
              <M {...TYPE.label} c={K.inkTertiary}>{payload.kind === 'text' ? 'TEXTO · SIN ABRIR ENLACES' : '1 IMAGEN · COPIA PRIVADA'}</M>
            </View>
            <M {...TYPE.label} c={K.inkTertiary}>AGENTE</M>
            {!servers.length || (DEMO && demo === 'no-server') ? <T {...TYPE.secondary} c={K.inkSecondary}>Empareja un Servidor antes de preparar el borrador.</T> : <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{servers.map((row) => {
              const state = snapshot(row.id); const invalid = state.down?.action === 'pair' || store.isRetired(clientFor(row.id)); const down = unreachableOf(row.id);
              if (invalid) return <View key={row.id} style={{ width: '100%', gap: 2 }}><M {...TYPE.label} c={K.inkTertiary}>{row.name.toUpperCase()}</M><T {...TYPE.secondary} c={K.dangerText}>Empareja de nuevo para usar este destino.</T></View>;
              if (down && !state.agents.length) return <View key={row.id} accessible accessibilityRole="button" accessibilityState={{ disabled: true }} accessibilityLabel={`${row.name} sin respuesta`} style={{ minHeight: 48, paddingHorizontal: 14, borderRadius: RADIUS.key, flexDirection: 'row', alignItems: 'center', gap: 8, opacity: 0.45, backgroundColor: K.key, boxShadow: `${K.shadowKey}, 0px 0px 0px 1px ${K.line}` }}>
                <Lamp tone="off" /><M {...TYPE.label} ls={0} c={K.inkTertiary}>{`${row.name.toUpperCase()} · SIN RESPUESTA`}</M>
              </View>;
              return state.agents.map((agent) => {
                const picked = chosen && server?.id === row.id && destination.agent === agent.id; const off = down || busy;
                return <Pressable key={`${row.id}:${agent.id}`} accessibilityRole="button" accessibilityState={{ disabled: off, selected: picked }} accessibilityLabel={down ? `${agent.name}, ${row.name} sin respuesta` : undefined} disabled={off} onPress={() => choose(row.id, agent.id)}
                  style={{ minHeight: 48, paddingHorizontal: 14, borderRadius: RADIUS.key, flexDirection: 'row', alignItems: 'center', gap: 8, opacity: down ? 0.45 : 1, backgroundColor: picked ? K.ink : K.key, boxShadow: picked ? undefined : `${K.shadowKey}, 0px 0px 0px 1px ${K.line}` }}>
                  <Lamp tone={down ? 'off' : agent.status === 'on' ? 'green' : 'orange'} />
                  <T s={15} w="600" c={picked ? K.block : K.ink}>{agent.name}</T>
                  <M {...TYPE.label} ls={0} c={picked ? K.onScreenLabel : K.inkTertiary}>{down ? `${row.name.toUpperCase()} · SIN RESPUESTA` : row.name.toUpperCase()}</M>
                </Pressable>;
              });
            })}</View>}
            <M {...TYPE.label} c={K.inkTertiary}>CONVERSACIÓN</M>
            <View style={{ minHeight: 48, borderRadius: RADIUS.field, backgroundColor: K.key, boxShadow: K.shadowKey, flexDirection: 'row', alignItems: 'center', paddingLeft: 12, gap: 8 }}><T {...TYPE.body} c={K.ink} style={{ flex: 1 }}>Conversación nueva</T><View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: K.field, boxShadow: K.shadowField, alignItems: 'center', justifyContent: 'center', marginRight: 4 }}><T s={16} c={K.inkSecondary}>⇕</T></View></View>
            <M {...TYPE.label} c={K.inkTertiary}>INSTRUCCIÓN · OPCIONAL</M>
            <TextInput accessibilityLabel="Instrucción opcional" placeholder="Qué quieres que haga con esto…" placeholderTextColor={K.inkTertiary} value={instruction} onChangeText={setInstruction} editable={!busy} multiline maxLength={64000} style={{ fontFamily: F.sans['400'], fontSize: 15, minHeight: 80, padding: 12, borderRadius: RADIUS.field, backgroundColor: K.field, boxShadow: K.shadowField, color: K.ink, textAlignVertical: 'top' }} />
            <T {...TYPE.secondary} c={K.inkSecondary}>Solo se prepara un borrador privado. Lo revisas y pulsas Enviar en el chat para empezar un Turno.</T>
            {replacement ? <View style={{ padding: 14, gap: 10, borderRadius: 16, backgroundColor: K.field, boxShadow: K.shadowField }}><T {...TYPE.secondary} c={K.ink}>Ya hay un borrador para este Agente. El contenido nuevo no lo reemplaza sin tu confirmación.</T><Keycap label="Reemplazar borrador anterior" onPress={() => { void prepare(replacement); }} /><Keycap label="Conservar borrador anterior" onPress={() => setReplacement(null)} /></View> : <Keycap variant="primary" disabled={!chosen || busy} label={busy ? 'Preparando borrador…' : 'Preparar borrador'} onPress={() => { void prepare(); }} />}
          </>}
          {tokens.some((id) => id !== token) ? <Keycap disabled={busy} onPress={() => { void next(); }} label="Revisar contenido nuevo · conservar el anterior" /> : null}
          {error ? <T accessibilityRole="alert" {...TYPE.secondary} c={K.dangerText}>{error}</T> : null}
        </>}
      </View>
    </ScrollView><HomeIndicator />
  </View>;
}
