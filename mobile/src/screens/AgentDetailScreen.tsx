import { usePalette } from '@/theme/ThemeProvider';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import type { ApprovalMode } from '../../../protocol/agentDetails';
import type { RelayClient } from '@/core/client';
import { ago, hostOf } from '@/core/format';
import { isAgentSecurity, lowersProtection } from '@/core/agentDetails';
import { DEMO, useApp, useNow, type ServerEntry } from '@/state/app';
import { useChatVisible } from '@/state/chatVisibility';
import { confirmWithFingerprint } from '@/state/confirmWithFingerprint';
import { useReturn } from '@/state/navigation';
import { F, RADIUS, TYPE } from '@/theme/tokens';
import { StatusBarSpace, useBottomInset } from '@/ui/chrome';
import { DetailHeader } from '@/ui/headers';
import { Avatar, IconKey, Keycap, ListBlock, ListRow, SectionHeader } from '@/ui/kit';
import { M, T } from '@/ui/primitives';
import { Sheet } from '@/ui/sheet';
import { SubjectStateBlock } from '@/ui/states';
import { ServerConnectionStatus } from '@/ui/ServerConnectionStatus';
import { avatarFor } from './AgentsScreen';
import { useAgentDetails } from './agent/useAgentDetails';
import { useAgentTools } from '@/state/agentTools';
import { DEMO_AGENT_DETAILS_SCENARIOS, demoAgentDetailsScenario, setDemoAgentDetailsScenario } from '@/core/demoAgentDetails';

type Action = { kind: 'mode'; mode: ApprovalMode } | { kind: 'remove'; pattern: string } | { kind: 'add' };
const titleMode = (mode: ApprovalMode | null) => mode ? mode[0].toUpperCase() + mode.slice(1) : 'Desconocido';
const MODE_TEXT: Record<ApprovalMode, string> = {
  manual: 'Te pregunta antes de ejecutar cada comando marcado. Llega a APROB.',
  smart: 'El Guardián aprueba los comandos de bajo riesgo y te pasa los casos en que duda o niega.',
  off: 'Sin Aprobaciones. Solo para entornos aislados y de confianza.',
};

/** A section: its mono header (with an optional right-hand note) over its content. */
function Section({ label, right, children }: { label: string; right?: string; children: ReactNode }) {
  const { K } = usePalette();
  return <View style={{ gap: 8 }}>
    <View style={{ paddingRight: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <SectionHeader title={label} />
      {right ? <M s={9.5} w="600" ls={0.08} c={K.inkTertiary}>{right}</M> : null}
    </View>
    {children}
  </View>;
}
function Note({ children, tone = 'secondary' }: { children: ReactNode; tone?: 'secondary' | 'danger' | 'accent' }) {
  const { K } = usePalette();
  return <T {...TYPE.secondary} c={{ secondary: K.inkSecondary, danger: K.dangerText, accent: K.accentText }[tone]} style={{ paddingHorizontal: 16 }}>{children}</T>;
}
/** Free-standing block (not a list): the usage panel. */
function Card({ children }: { children: ReactNode }) {
  const { K } = usePalette();
  return <View style={{ marginHorizontal: 12, padding: 16, gap: 12, borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock }}>{children}</View>;
}

export function AgentDetailScreen({ serverId, agentId }: { serverId: string; agentId: string }) {
  const { K } = usePalette();
  const app = useApp();
  const server = app.servers.find(s => s.id === serverId);
  if (!server) return <View style={{ flex: 1, padding: 18, backgroundColor: K.background }}><StatusBarSpace /><T>Este Servidor ya no está disponible.</T></View>;
  return <AgentDetail key={JSON.stringify([server.id, server.url, server.key, server.deviceId, agentId])} server={server} agentId={agentId} client={app.clientFor(serverId)} />;
}

function AgentDetail({ server, agentId, client }: { server: ServerEntry; agentId: string; client: RelayClient }) {
  const { K } = usePalette();
  const { snapshot, refresh } = useApp();
  const snap = snapshot(server.id), now = useNow(), bottom = useBottomInset(12);
  const scope = JSON.stringify([server.id, server.url, agentId]);
  const data = useAgentDetails(client, agentId, scope, snap.reachable);
  const toolState = useAgentTools(server.id, agentId);
  const toolsets = toolState.tools?.toolsets, skills = toolState.skills?.skills;
  const toolsMeta = [toolsets ? `${toolsets.filter(t => t.enabled).length} DE ${toolsets.length}` : null, skills ? `${skills.length} SKILLS` : null].filter(Boolean).join(' · ')
    || (toolState.loading ? 'CONSULTANDO…' : 'SIN LECTURA');
  const visible = useChatVisible();
  const [page, setPage] = useState<'identity' | 'approvals'>('identity');
  const [action, setAction] = useState<Action | null>(null), [pattern, setPattern] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  // The sheet keeps showing the last action while it slides out.
  const [shown, setShown] = useState<Action | null>(null);
  if (action && action !== shown) setShown(action);
  const [scenario, setScenario] = useState(() => demoAgentDetailsScenario(server.id));
  const busyRef = useRef(false), alive = useRef(true);
  const details = data.details;
  const readonly = !visible || snap.reachable !== true || data.cached || data.loading || !details?.security.writable;
  if (readonly && action !== null) setAction(null);
  const current = useRef({ readonly, revision: details?.security.revision });
  useEffect(() => { current.current = { readonly, revision: details?.security.revision }; }, [readonly, details?.security.revision]);
  useFocusEffect(useCallback(() => { alive.current = true; return () => { alive.current = false; }; }, []));
  const request = async (change: Action, revision: string) => {
    if (busyRef.current || current.current.readonly) return;
    busyRef.current = true; setBusy(true); setError(null);
    const valid = () => alive.current && !current.current.readonly && current.current.revision === revision;
    try {
      if (change.kind === 'remove' || change.kind === 'mode' && details && lowersProtection(details.security, change.mode)) {
        const confirmed = await confirmWithFingerprint(change.kind === 'remove' ? 'Quitar regla de bloqueo' : 'Cambiar Modo de aprobación');
        if (!confirmed || !valid()) return;
      }
      if (!valid()) return;
      const security = change.kind === 'mode'
        ? await client.setApprovalMode(agentId, { mode: change.mode, revision })
        : await client.changeBlockRule(agentId, { action: change.kind === 'remove' ? 'remove' : 'add', pattern: change.kind === 'remove' ? change.pattern : pattern.trim(), revision });
      if (!valid()) return;
      if (!isAgentSecurity(security)) throw new Error();
      data.updateSecurity(security); setAction(null); setPattern('');
    } catch { if (valid()) { setError('El cambio quedó sin confirmar. Revisa la ficha antes de repetirlo.'); data.retry(); } }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };
  const choose = (mode: ApprovalMode) => {
    if (readonly || busyRef.current || !details) return;
    const selected = details.security.pendingMode?.mode ?? details.security.mode;
    if (mode === selected) return;
    if (lowersProtection(details.security, mode)) setAction({ kind: 'mode', mode }); else void request({ kind: 'mode', mode }, details.security.revision);
  };
  const name = details?.name ?? snap.agents.find(a => a.id === agentId)?.name ?? agentId;
  // The Modo de aprobación page is drawn here: its return (and back key) goes to the identity, named by the Agente.
  const ret = useReturn(page === 'approvals' ? { label: name, go: () => setPage('identity') } : null);
  const retry = () => { refresh(server.id); data.retry(); };
  const openChat = (conversationId?: string, list = false) => router.push({ pathname: '/chat/[server]/[agent]', params: { server: server.id, agent: agentId, ...(conversationId ? { conversationId } : {}), ...(list ? { conversations: '1' } : {}) } });
  const openSection = (section: 'memory' | 'soul' | 'tools') => router.push({ pathname: `/agent/[server]/[agent]/${section}` as '/agent/[server]/[agent]', params: { server: server.id, agent: agentId } });
  const pending = details?.security.pendingMode;
  const mode = details?.security.mode ?? null;
  const selectedMode = pending?.mode ?? mode;
  const trio = readonly ? 'off' : details?.status ?? 'off';
  const header = page === 'approvals'
    ? <DetailHeader back={ret?.label ?? name} onBack={ret?.go ?? (() => setPage('identity'))} title="Modo de aprobación" subtitle={`${agentId.toUpperCase()} · MODO Y REGLAS DE BLOQUEO`} />
    : <DetailHeader back={ret?.label ?? 'Agentes'} onBack={ret?.go ?? (() => router.back())}
      identity={{ name, state: trio, line: `${server.name.toUpperCase()} · ${hostOf(server.url).toUpperCase()}`, avatar: <Avatar source={avatarFor(agentId)} size={48} faded={readonly} />, lineLabel: 'Ver Servidor', onLinePress: () => router.push({ pathname: '/server/[server]', params: { server: server.id } }) }} />;
  const deny = details?.security.deny;
  return <View style={{ flex: 1, backgroundColor: K.background }}>
    <StatusBarSpace /><ServerConnectionStatus serverId={server.id} />
    {header}
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: 12, paddingBottom: bottom, gap: 16 }}>
      {data.loading && !details ? <View style={{ marginHorizontal: 12 }}><SubjectStateBlock spec={{ kind: 'loading', what: 'ficha' }} /></View> : null}
      {!data.loading && !details ? <View style={{ marginHorizontal: 12 }}><SubjectStateBlock spec={snap.reachable === false
        ? { kind: 'unreachable', phrase: `${server.name} no contesta; no se pudo leer la ficha de ${agentId}. Comprueba Tailscale y el Puente en el Servidor.`, onRetry: retry }
        : { kind: 'error', verb: 'cargar la ficha', onRetry: retry }} /></View> : null}
      {details ? <>
        {readonly ? <View style={{ paddingHorizontal: 16, gap: 4 }}>
          <M {...TYPE.label} c={K.dangerText}>SOLO LECTURA · {ago(details.capturedAt, now).toUpperCase()}</M>
          <T {...TYPE.secondary} c={K.inkSecondary}>{details.security.reason ?? (snap.reachable === false ? 'Se muestra lo último conocido.' : data.error ?? 'Actualizando la ficha…')}</T>
          <Keycap variant="link" label="Reintentar" onPress={retry} style={{ alignSelf: 'flex-start' }} />
        </View> : null}
        {page === 'identity' ? <>
          {!readonly ? <View style={{ marginHorizontal: 12, flexDirection: 'row', gap: 8 }}>
            <Keycap variant="primary" label="Abrir chat" onPress={() => openChat()} style={{ flex: 1 }} />
            <Keycap label="Conversaciones" onPress={() => openChat(undefined, true)} style={{ flex: 1 }} />
          </View> : null}
          <Section label="MODELO">
            <ListBlock><ListRow plate="LLM" title={details.defaultModel.model} meta={`PROVEEDOR · ${details.defaultModel.provider.toUpperCase()} · SE CAMBIA EN EL SERVIDOR`} /></ListBlock>
          </Section>
          <Section label="COMPORTAMIENTO">
            <ListBlock>
              <ListRow plate="SOUL" title="Personalidad" meta="SOUL.md" chevron onPress={() => openSection('soul')} />
              <ListRow plate="APRB" title="Modo de aprobación" meta={pending ? `${mode?.toUpperCase() ?? 'DESCONOCIDO'} · PENDIENTE ${pending.mode.toUpperCase()}` : titleMode(mode).toUpperCase()} chevron onPress={() => setPage('approvals')} />
              <ListRow plate="DENY" title="Reglas de bloqueo" meta={deny === null ? 'NO DISPONIBLES' : `${deny?.length ?? 0} REGLAS · SIEMPRE SE BLOQUEAN`} chevron onPress={() => setPage('approvals')} />
            </ListBlock>
          </Section>
          <Section label="MEMORIA Y HERRAMIENTAS">
            <ListBlock>
              <ListRow plate="MEM" title="Memoria" meta={`DE ${name.toUpperCase()} EN ${server.name.toUpperCase()}`} chevron onPress={() => openSection('memory')} />
              <ListRow plate="TOOL" title="Herramientas y skills" meta={toolsMeta} chevron onPress={() => openSection('tools')} />
            </ListBlock>
          </Section>
          <Section label="USO">
            <Card>{details.usage ? <>
              <View style={{ flexDirection: 'row', gap: 16 }}>
                {[{ name: 'HOY', value: details.usage.today }, { name: 'ÚLTIMOS 7 DÍAS', value: details.usage.last7days }].map(row => <View key={row.name} style={{ flex: 1, gap: 5 }}>
                  <M {...TYPE.label} c={K.inkTertiary}>{row.name}</M>
                  <M {...TYPE.reading} c={K.accentText}>{row.value.estimatedCostUsd === null ? 'COSTO DESCONOCIDO' : `≈ $${row.value.estimatedCostUsd.toFixed(2)}`}</M>
                  <M s={9.5} c={K.inkSecondary}>{row.value.tokens.toLocaleString()} TOKENS</M>
                </View>)}
              </View>
              <View style={{ height: 56, flexDirection: 'row', gap: 7, alignItems: 'flex-end' }}>
                {details.usage.daily.map((day, i, all) => <View key={day.day} style={{ flex: 1, alignItems: 'center', gap: 4 }}>
                  <View style={{ height: Math.max(2, 35 * day.tokens / Math.max(1, ...all.map(d => d.tokens))), width: '100%', borderRadius: 3, backgroundColor: i === all.length - 1 ? K.accent : K.ok }} />
                  <M s={9.5} c={K.inkTertiary}>{day.day.slice(8)}</M>
                </View>)}
              </View>
              <T {...TYPE.secondary} c={K.inkSecondary}>Basado en Conversaciones iniciadas en cada fecha, con sus acumulados actuales. No incluye consumo auxiliar.</T>
              <M s={9.5} c={K.inkTertiary}>CAPTURA · {new Date(details.usage.capturedAt).toLocaleString()} · {details.usage.timezone}</M>
            </> : <T {...TYPE.secondary} c={K.inkSecondary}>{details.usageError ?? 'Uso no disponible.'}</T>}</Card>
          </Section>
          <Section label="CONVERSACIONES RECIENTES">
            {details.recentConversations.length
              ? <ListBlock>{details.recentConversations.map(conversation => <ListRow key={conversation.id} title={conversation.title ?? 'Conversación sin título'}
                meta={`${conversation.originLabel.toUpperCase()} · ${conversation.messageCount} MENSAJES · ${ago(conversation.lastActiveAt, now)}`} onPress={() => openChat(conversation.id)} />)}</ListBlock>
              : <Note>Este Agente todavía no tiene Conversaciones.</Note>}
          </Section>
        </> : <>
          <Section label="MODO DE APROBACIÓN" right="PARA COMANDOS MARCADOS">
            <ListBlock>{(['manual', 'smart', 'off'] as const).map(m => {
              const chosen = m === selectedMode;
              return <Pressable key={m} accessibilityRole="radio" accessibilityLabel={`Modo ${titleMode(m)}`} accessibilityState={{ checked: chosen, disabled: readonly || busy }} disabled={readonly || busy} onPress={() => choose(m)}
                style={{ minHeight: 72, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12, opacity: readonly ? 0.45 : 1 }}>
                <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: chosen ? K.accent : K.ledOff, alignItems: 'center', justifyContent: 'center' }}>
                  {chosen ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: K.accent }} /> : null}
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <T {...TYPE.body} c={m === 'off' ? K.dangerText : K.ink}>{titleMode(m)}{m === mode ? ' · ACTUAL' : ''}{pending?.mode === m ? ' · PENDIENTE' : ''}</T>
                  <T {...TYPE.secondary} c={K.inkSecondary}>{MODE_TEXT[m]}</T>
                </View>
              </Pressable>;
            })}</ListBlock>
          </Section>
          {pending ? <M s={9.5} c={K.accentText} style={{ paddingHorizontal: 16 }}>PENDIENTE: {pending.mode.toUpperCase()}</M> : null}
          <Note>El cambio se guarda pendiente y se aplica antes del siguiente Turno de Relay. Al aplicarlo, otros canales activos pueden notar el nuevo modo.</Note>
          {details.security.reason ? <Note tone="danger">{details.security.reason}</Note> : null}
          <Section label="POLÍTICA DEL GUARDIÁN" right="SOLO LECTURA">
            <View style={{ marginHorizontal: 12, padding: 14, gap: 8, borderRadius: RADIUS.block, backgroundColor: K.screen, boxShadow: K.shadowScreen }}>
              <M s={10} lh={1.7} c={K.onScreen}>{details.security.guardianPolicy ?? (details.security.writable ? 'Política predeterminada de Hermes; texto no disponible.' : 'Relay no pudo leer la política del Guardián.')}</M>
              <M s={9.5} c={K.onScreenLabel}>SE CAMBIA EN EL SERVIDOR</M>
            </View>
          </Section>
          <Section label="REGLAS DE BLOQUEO" right={deny ? `${deny.length} REGLAS` : 'NO DISPONIBLES'}>
            <ListBlock>
              {deny?.length ? deny.map((p, i) => <View key={`${i}:${p}`} style={{ minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: K.danger }} />
                <M s={11} c={K.ink} style={{ flex: 1 }}>{p}</M>
                {!readonly ? <IconKey glyph="×" accessibilityLabel={`Quitar regla ${p}`} onPress={() => { if (!busy) setAction({ kind: 'remove', pattern: p }); }} /> : null}
              </View>) : <T {...TYPE.secondary} c={K.inkSecondary} style={{ paddingVertical: 14 }}>{deny === null ? 'Relay no pudo leer las reglas.' : 'No hay reglas de bloqueo. Añade patrones de comandos que el Agente nunca debe ejecutar.'}</T>}
              {!readonly ? <Pressable accessibilityRole="button" accessibilityLabel="Añadir regla de bloqueo" disabled={busy} onPress={() => { setPattern(''); setAction({ kind: 'add' }); }} style={{ minHeight: 56, justifyContent: 'center' }}>
                <M {...TYPE.label} c={K.accentText}>+ AÑADIR REGLA</M>
              </Pressable> : null}
            </ListBlock>
          </Section>
          <Note>Se bloquean siempre, incluso con el Modo de aprobación en Off. Los patrones son globs, no expresiones regulares.</Note>
        </>}
      </> : null}
      {error ? <Note tone="danger">{error}</Note> : null}
      {DEMO ? <View style={{ marginHorizontal: 12 }}><Keycap label={`Ficha demo: ${DEMO_AGENT_DETAILS_SCENARIOS.find(s => s.id === scenario)?.name} · Cambiar`} onPress={() => {
        const i = DEMO_AGENT_DETAILS_SCENARIOS.findIndex(s => s.id === scenario);
        const next = DEMO_AGENT_DETAILS_SCENARIOS[(i + 1) % DEMO_AGENT_DETAILS_SCENARIOS.length];
        setScenario(next.id); setDemoAgentDetailsScenario(server.id, next.id); data.retry();
      }} /></View> : null}
    </ScrollView>
    <Sheet visible={!!action && !!details} onClose={() => { if (!busy) setAction(null); }}
      title={!shown ? '' : shown.kind === 'add' ? 'Nueva regla de bloqueo' : shown.kind === 'remove' ? '¿Quitar la regla?' : shown.mode === 'off' ? '¿Desactivar aprobaciones?' : '¿Pasar a Smart?'}
      subtitle={!shown ? undefined : shown.kind === 'add' ? 'GLOB · NO EXPRESIÓN REGULAR' : 'BAJA LA PROTECCIÓN · PIDE HUELLA'}
      action={shown && details ? <>
        <Keycap label="Cancelar" disabled={busy} onPress={() => setAction(null)} style={{ flex: 1 }} />
        <Keycap label={busy ? 'Guardando…' : shown.kind === 'add' ? 'Añadir regla' : shown.kind === 'remove' ? 'Quitar con huella' : shown.mode === 'off' ? 'Desactivar con huella' : 'Pasar a Smart'}
          variant={shown.kind === 'remove' || shown.kind === 'mode' && shown.mode === 'off' ? 'danger' : 'primary'}
          disabled={busy || shown.kind === 'add' && (!pattern.trim() || /[\x00-\x1f\x7f]/.test(pattern))} onPress={() => { void request(shown, details.security.revision); }} style={{ flex: 1.3 }} />
      </> : undefined}>
      {shown && details ? <>
        {shown.kind === 'add'
          ? <TextInput accessibilityLabel="Patrón de bloqueo" placeholder="git push --force*" placeholderTextColor={K.inkTertiary} value={pattern} onChangeText={setPattern} editable={!busy} maxLength={256} autoCapitalize="none" autoCorrect={false}
            style={{ minHeight: 48, borderRadius: 12, padding: 12, backgroundColor: K.field, boxShadow: K.shadowField, color: K.ink, fontFamily: F.mono['400'], fontSize: 13 }} />
          : <T {...TYPE.body} c={K.ink}>{shown.kind === 'remove' ? `${shown.pattern} dejará de bloquearse siempre.` : shown.mode === 'off' ? `${details.name} ejecutará cualquier comando marcado sin preguntarte.` : 'El Guardián aprobará por su cuenta los comandos de bajo riesgo.'}</T>}
        <T {...TYPE.secondary} c={K.inkSecondary}>{shown.kind === 'add' ? 'Los comandos que coincidan se bloquean siempre, también con el Modo de aprobación en Off.' : shown.kind === 'remove' ? `Lo decidirá el Modo de aprobación (${titleMode(mode)}). Quitar una regla baja la protección.` : shown.mode === 'off' ? 'Las reglas de bloqueo siguen activas. Úsalo solo en entornos aislados.' : 'Los casos en que el Guardián duda o niega seguirán llegando a APROB. Las reglas de bloqueo no cambian.'}</T>
      </> : null}
    </Sheet>
  </View>;
}
