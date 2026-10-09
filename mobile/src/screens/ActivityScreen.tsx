import { usePalette } from '@/theme/ThemeProvider';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { router } from 'expo-router';
import type { ActivityCategory, ActivityItem, ActivityQuery } from '../../../protocol/activity';
import { DEMO_ACTIVITY_SCENARIOS, demoActivityScenario, setDemoActivityScenario, setDemoConnection } from '@/core/demo';
import { activityAgentId, activityReferenceId, ACTIVITY_VISIBLE_LIMIT } from '@/core/activity';
import { activityActionLabel, activityActorLabel, activityDate, activityDay, activityGapLabel, activityResultLabel, activityTime, activityTone } from '@/core/activityPresentation';
import { useActivity } from '@/state/useActivity';
import { DEMO, useApp, type ServerEntry } from '@/state/app';
import { goToTab } from '@/state/navigation';

import { StatusBarSpace } from '@/ui/chrome';
import { RootHeader } from '@/ui/headers';
import { Keycap, Lamp, Segmented } from '@/ui/kit';
import { M, T } from '@/ui/primitives';
import { TailnetPill } from '@/ui/TailnetSheet';
import { ServerConnectionStatus } from '@/ui/ServerConnectionStatus';

/** The Agentes tab's two sections. */
export const AGENTS_SECTIONS = ['Agentes', 'Actividad'] as const;

const categories: { label: string; value?: ActivityCategory }[] = [{ label: 'TODO' }, { label: 'CONFIGURACIÓN', value: 'configuration' }, { label: 'CONVERSACIONES', value: 'conversations' }, { label: 'TAREAS', value: 'tasks' }, { label: 'SERVIDOR', value: 'server' }];

/** A filter: Mono 9.5 caps on a key; the chosen one is inverted, like the segmented. */
function Filter({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const { K } = usePalette();
  return <Pressable role="button" accessibilityState={{ selected: active }} hitSlop={{ top: 4, bottom: 4 }} onPress={onPress} style={{
    minHeight: 40, paddingHorizontal: 12, borderRadius: 12, justifyContent: 'center', backgroundColor: active ? K.ink : K.key, boxShadow: active ? undefined : K.shadowKey,
  }}>
    <M s={9.5} ls={0.06} c={active ? K.block : K.inkSecondary}>{label}</M>
  </Pressable>;
}

function EventIcon({ item }: { item: ActivityItem }) {
  const { K } = usePalette();
  const color = activityTone(item.result) === 'red' ? K.dangerTextOnScreen : K.onScreen;
  return <View style={{ width: 28, height: 28, borderRadius: 9, backgroundColor: K.screen, alignItems: 'center', justifyContent: 'center' }}><Svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    {item.category === 'server' ? <><Rect x={4} y={4} width={16} height={16} rx={2}/><Path d="M4 10h16M7 7h1M7 15h1M11 15h6"/></> : item.category === 'conversations' ? <Path d="M4 5h16v11H9l-5 4z"/> : item.category === 'tasks' ? <><Path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2"/></> : <Path d="m12 3 7 3v6c0 4-4 7-7 9-3-2-7-5-7-9V6z"/>}
  </Svg></View>;
}
function ActivityRow({ item, server, canInteract }: { item: ActivityItem; server: ServerEntry; canInteract: () => boolean }) {
  const { K } = usePalette();
  const [selected, setSelected] = useState(false);
  const tone = activityTone(item.result); const failed = tone === 'red';
  const agent = item.scope.kind === 'agent' ? item.scope.agentId : null;
  const navigate = (conversation = false) => {
    if (!canInteract() || !activityReferenceId(server.id)) return;
    if (agent && !activityAgentId(agent)) return;
    if (conversation && agent && activityReferenceId(item.conversationId)) router.push({ pathname: '/chat/[server]/[agent]', params: { server: server.id, agent, conversationId: item.conversationId } });
    else if (agent) router.push({ pathname: '/agent/[server]/[agent]', params: { server: server.id, agent } });
    else router.push({ pathname: '/server/[server]', params: { server: server.id } });
  };
  return <View style={{ flexDirection: 'row', gap: 8, alignItems: 'stretch' }}>
    <M s={9.5} c={K.inkTertiary} style={{ width: 42, paddingTop: 12 }}>{activityTime(item.at)}</M>
    <View style={{ width: 28, alignItems: 'center', paddingTop: 7 }}><EventIcon item={item}/><View style={{ width: 2, flex: 1, minHeight: 12, backgroundColor: K.line, marginTop: 4 }}/></View>
    <Pressable accessibilityRole="button" accessibilityLabel={activityActionLabel[item.action] + ', ' + activityResultLabel[item.result]} onPress={() => { if (canInteract()) setSelected(value => !value); }} style={{ flex: 1, minWidth: 0, marginVertical: 4, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 16, gap: 4, backgroundColor: failed ? K.dangerSurface : K.block, boxShadow: K.shadowBlock, ...(selected ? { borderWidth: 1, borderColor: K.accent } : {}) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><M s={9.5} c={K.inkTertiary} numberOfLines={1} style={{ flex: 1 }}>{agent ? agent.toUpperCase() : 'SERVIDOR'}</M><Lamp tone={tone} size={6}/><M s={9.5} c={tone === 'red' ? K.dangerText : tone === 'orange' ? K.accentText : K.inkSecondary}>{activityResultLabel[item.result]}</M></View>
      <T s={13} lh={1.35} c={K.ink}>{activityActionLabel[item.action]}</T>
      <M s={9.5} c={K.inkTertiary}>{activityActorLabel(item, server.deviceId)}</M>
      {selected ? <View style={{ gap: 7, paddingTop: 6 }}>
        {item.result === 'requested' ? <T s={13} c={K.inkSecondary}>Solicitud registrada; no confirma que se haya aplicado.</T> : item.result === 'accepted' ? <T s={13} c={K.inkSecondary}>Solicitud aceptada; no confirma su finalización.</T> : item.result === 'uncertain' ? <T s={13} c={K.inkSecondary}>El resultado quedó sin confirmar.</T> : item.result === 'failed' ? <T s={13} c={K.inkSecondary}>El resultado quedó sin confirmar; el cambio pudo tener efectos.</T> : item.result === 'rejected' ? <T s={13} c={K.inkSecondary}>Solicitud rechazada; no indica un fallo técnico.</T> : null}
        {agent && item.conversationId ? <><Pressable accessibilityRole="button" onPress={() => navigate(true)} style={{ minHeight: 40, justifyContent: 'center' }}><M s={9.5} c={K.accentText}>ABRIR CONVERSACIÓN ›</M></Pressable><T s={13} c={K.inkTertiary}>Referencia registrada; puede haber cambiado. Abre la Conversación, sin un punto exacto.</T></> : null}
        <Pressable accessibilityRole="button" onPress={() => navigate()} style={{ minHeight: 40, justifyContent: 'center' }}><M s={9.5} c={K.accentText}>{agent ? 'VER AGENTE ›' : 'ADMINISTRAR SERVIDOR ›'}</M></Pressable>
      </View> : null}
    </Pressable>
  </View>;
}
function ServerActivity({ serverId, query, refreshKey }: { serverId: string; query: ActivityQuery; refreshKey: number }) {
  const { K } = usePalette();
  const feed = useActivity(serverId, query, refreshKey);
  if (!feed.server || !feed.presenting) return null;
  const items = feed.page?.items ?? [];
  const dashed = { borderBottomWidth: 1, borderStyle: 'dashed', borderColor: K.line } as const;
  return <View style={{ gap: 8, paddingHorizontal: 12 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}><M s={9.5} w="600" ls={0.06} c={K.ink}>{feed.server.name.toUpperCase()}</M><View style={{ flex: 1, height: 1, backgroundColor: K.line }}/><M s={9.5} c={K.inkTertiary}>{items.length} REGISTROS</M></View>
    <ServerConnectionStatus serverId={serverId}/>
    {feed.diagnosis?.kind === 'known' ? <T s={13} c={K.dangerText}>{feed.diagnosis.label}</T> : null}
    {feed.page ? <M s={9.5} c={K.inkTertiary}>Fecha del Servidor · UTC · {activityDate(feed.page.capturedAt)}{feed.phase === 'ready' ? ' · CONSULTA FIJA' : ' · ÚLTIMA LECTURA'}</M> : null}
    {feed.phase === 'loading' && feed.active ? <T s={13} c={K.inkSecondary}>Cargando Actividad…</T> : null}
    {feed.phase === 'offline' ? <T s={13} c={K.inkSecondary}>{feed.page ? 'Sin conexión. Última lectura en memoria; solo lectura.' : 'Sin conexión. No hay una lectura de Actividad en memoria.'}</T> : null}
    {feed.notice ? <T s={13} c={K.dangerText}>{feed.notice}</T> : null}
    {feed.phase === 'ready' && items.length === 0 ? <M s={9.5} c={K.inkTertiary} style={{ ...dashed, paddingVertical: 12 }}>SIN ACTIVIDAD EN ESTA CONSULTA</M> : null}
    {items.map((item, index) => <View key={item.id}>
      {index > 0 && activityGapLabel(items[index - 1].at, item.at) ? <M s={9.5} c={K.inkTertiary} style={{ ...dashed, paddingVertical: 10, marginLeft: 50 }}>{activityGapLabel(items[index - 1].at, item.at)}</M> : null}
      {index === 0 || activityDay(items[index - 1].at) !== activityDay(item.at) ? <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 8, marginBottom: 7 }}><M s={9.5} w="600" c={K.ink}>{activityDay(item.at)}</M><View style={{ flex: 1, height: 1, backgroundColor: K.line }}/></View> : null}
      <ActivityRow item={item} server={feed.server!} canInteract={feed.canInteract}/>
    </View>)}
    {items.length >= ACTIVITY_VISIBLE_LIMIT ? <T s={13} c={K.inkSecondary}>Hasta 500 registros por Servidor. Actualiza para consultar los nuevos.</T> : null}
    {feed.page?.nextCursor && feed.phase === 'ready' ? <Keycap disabled={feed.moreBusy} onPress={() => void feed.loadMore()} label={feed.moreBusy ? 'CARGANDO…' : 'CARGAR MÁS · ' + feed.server.name.toUpperCase()} /> : null}
    {feed.active || feed.phase === 'blocked' ? <Pressable accessibilityRole="button" onPress={feed.refresh} style={{ minHeight: 40, justifyContent: 'center' }}><M s={9.5} c={K.accentText}>ACTUALIZAR · {feed.server.name.toUpperCase()}</M></Pressable> : null}
  </View>;
}
export function ActivityScreen({ onAgents = () => goToTab('agents') }: { onAgents?: () => void }) {
  const { K } = usePalette();
  const app = useApp(); const [serverId, setServerId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | undefined>(); const [category, setCategory] = useState<ActivityCategory | undefined>();
  const [failuresOnly, setFailuresOnly] = useState(false); const [refreshKey, setRefreshKey] = useState(0);
  const servers = app.servers.filter(server => !serverId || server.id === serverId);
  const agents = [...new Set(servers.flatMap(server => app.snapshot(server.id).agents.map(agent => agent.id).filter(activityAgentId)))];
  const query: ActivityQuery = { agentId, category, failuresOnly };
  const filters = { paddingHorizontal: 12, gap: 6 };
  return <View style={{ flex: 1, backgroundColor: K.background }}>
    <StatusBarSpace/><ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: 4, paddingBottom: 18, gap: 12 }}>
      <RootHeader title="Agentes" right={<TailnetPill/>}/>
      <View style={{ marginHorizontal: 12 }}><Segmented options={AGENTS_SECTIONS} value="Actividad" onChange={section => { if (section === 'Agentes') onAgents(); }}/></View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={filters}><Filter label="TODOS LOS SERVIDORES" active={!serverId} onPress={() => { setServerId(null); setAgentId(undefined); }}/>{app.servers.map(server => <Filter key={server.id} label={server.name.toUpperCase()} active={server.id === serverId} onPress={() => { setServerId(server.id); setAgentId(undefined); }}/>)}</ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={filters}><Filter label="TODOS LOS AGENTES" active={!agentId} onPress={() => setAgentId(undefined)}/>{agents.map(id => <Filter key={id} label={id.toUpperCase()} active={agentId === id} onPress={() => setAgentId(id)}/>)}<Filter label="SOLO FALLOS" active={failuresOnly} onPress={() => setFailuresOnly(value => !value)}/></ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={filters}>{categories.map(option => <Filter key={option.label} label={option.label} active={category === option.value} onPress={() => setCategory(option.value)}/>)}</ScrollView>
      {servers.length > 1 ? <T s={13} c={K.inkTertiary} style={{ paddingHorizontal: 16 }}>Cada Servidor conserva su orden y reloj; no se comparan fechas entre máquinas.</T> : null}
      {!servers.length ? <View style={{ marginHorizontal: 12, padding: 16, borderRadius: 20, backgroundColor: K.block, boxShadow: K.shadowBlock }}><T s={15} c={K.ink}>No hay Servidores en esta consulta.</T></View> : null}
      {servers.map(server => <ServerActivity key={server.id} serverId={server.id} query={query} refreshKey={refreshKey}/>)}
      <Pressable accessibilityRole="button" onPress={() => { void app.refresh(); setRefreshKey(value => value + 1); }} style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 16 }}><M s={9.5} c={K.accentText}>ACTUALIZAR ACTIVIDAD</M></Pressable>
      {DEMO ? <View style={{ paddingHorizontal: 16, gap: 6 }}><T s={13} c={K.inkTertiary}>Datos de demostración</T><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{DEMO_ACTIVITY_SCENARIOS.map(scenario => <Filter key={scenario.id} label={scenario.name} active={demoActivityScenario(app.servers[0]?.id ?? '') === scenario.id} onPress={() => { for (const server of app.servers) { setDemoActivityScenario(server.id, scenario.id); setDemoConnection(server.id, scenario.id === 'offline' || scenario.id === 'partial' && server.id === 'homelab' ? 'offline' : 'compatible'); } void app.refresh(); setRefreshKey(value => value + 1); }}/>)}</View></View> : null}
    </ScrollView>
  </View>;
}
