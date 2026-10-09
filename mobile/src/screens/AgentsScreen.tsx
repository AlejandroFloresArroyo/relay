import { useState } from 'react';
import { router, usePathname } from 'expo-router';
import { Pressable, View, type ImageSourcePropType } from 'react-native';

import type { Agent } from '../../../protocol/protocol';
import { DEMO_CONNECTION_SCENARIOS, demoConnectionScenario, setDemoConnection } from '@/core/demo';
import { agentAvatarKey, type AgentAvatarKey } from '@/core/agentAvatars';
import { agentActivity, agentLight } from '@/core/machinery';
import { ms, plainPreview, relTime } from '@/core/format';
import { DEMO, useApp, useNow, type PendingApproval, type ServerEntry } from '@/state/app';
import { usePalette } from '@/theme/ThemeProvider';
import { TEXT_GLOW } from '@/theme/tokens';
import { ActivityScreen, AGENTS_SECTIONS } from './ActivityScreen';

import { StatusBarSpace } from '@/ui/chrome';
import { PullToRefresh, SwipeRow } from '@/ui/gestures';
import { RootHeader } from '@/ui/headers';
import { Avatar, IconKey, Keycap, Lamp, LedTrio, ListBlock, Segmented } from '@/ui/kit';
import { EngravedRule, Lights, RecessedScreen, Screws, Sweep } from '@/ui/machinery';
import { HazardFrame, PauseSymbol } from '@/ui/PauseStrip';
import { M, T } from '@/ui/primitives';
import { CompactStatusContext, ServerConnectionStatus } from '@/ui/ServerConnectionStatus';
import { StateRow } from '@/ui/states';
import { TailnetPill } from '@/ui/TailnetSheet';

// Bundled images shared by automatic assignments in demo and real connections.
const AGENT_AVATARS: Record<AgentAvatarKey, ImageSourcePropType> = {
  hermes: require('@/assets/avatars/hermes.png'),
  caduceus: require('@/assets/avatars/caduceus.png'),
  raven: require('@/assets/avatars/raven.png'),
  torch: require('@/assets/avatars/torch.png'),
  astrolabe: require('@/assets/avatars/astrolabe.png'),
  sandal: require('@/assets/avatars/sandal.png'),
  lighthouse: require('@/assets/avatars/lighthouse.png'),
  owl: require('@/assets/avatars/owl.png'),
};
export const avatarFor = (agentId: string): ImageSourcePropType => AGENT_AVATARS[agentAvatarKey(agentId)];

const ACCENT_GLOW = TEXT_GLOW.accent;

/**
 * Agentes (F-1): every Servidor's Agentes, with Actividad in its segmented. `pane` is the tablet's
 * list beside a Conversación (T-1): title only, compact rows, and the open Agente inverted.
 */
export function AgentsScreen({ pane = false }: { pane?: boolean }) {
  const [section, setSection] = useState<(typeof AGENTS_SECTIONS)[number]>('Agentes');
  return section === 'Actividad'
    ? <ActivityScreen onAgents={() => setSection('Agentes')} />
    : <AgentListScreen pane={pane} onActivity={() => setSection('Actividad')} />;
}

function AgentListScreen({ pane, onActivity }: { pane: boolean; onActivity: () => void }) {
  const { K } = usePalette();
  const { servers, pending, refreshed } = useApp();
  // The Conversación open beside the tablet list: /chat/<server>/<agent>.
  const [, route, openServer, openAgent] = usePathname().split('/');
  return (
    <View style={{ flex: 1, backgroundColor: pane ? undefined : K.background }}>
      <StatusBarSpace />
      <PullToRefresh onRefresh={refreshed} contentContainerStyle={{ paddingTop: 4, paddingBottom: 14, gap: 12 }}>
        <RootHeader title="Agentes" right={pane ? undefined : <>
          <TailnetPill />
          <IconKey round glyph="+" accessibilityLabel="Agregar servidor" onPress={() => router.push('/connect')} />
        </>} />
        {pane ? null : <View style={{ marginHorizontal: 12 }}>
          <Segmented options={AGENTS_SECTIONS} value="Agentes" onChange={(section) => { if (section === 'Actividad') onActivity(); }} />
        </View>}
        {pending[0] ? <ApprovalCommand pending={pending} compact={pane} /> : null}
        {servers.map((s) => (
          <ServerGroup key={s.id} server={s} pane={pane} openAgent={route === 'chat' && openServer === s.id ? openAgent : undefined} />
        ))}
      </PullToRefresh>
    </View>
  );
}

/** Bloque de mando de Aprobación (F-1): a screwed block around a lit screen with the red sweep. The tablet list keeps the screen alone, with red lights (T-1). */
function ApprovalCommand({ pending, compact }: { pending: PendingApproval[]; compact: boolean }) {
  const { K } = usePalette();
  const { openApproval } = useApp();
  const first = pending[0];
  const label = `${pending.length} ${pending.length === 1 ? 'APROBACIÓN PENDIENTE' : 'APROBACIONES PENDIENTES'}`;
  const screen = <RecessedScreen rim radius={compact ? 16 : 14} style={{ paddingVertical: 14, paddingHorizontal: 14, gap: 10 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {compact ? null : <Lamp tone="orange" size={9} />}
      <M s={9.5} w="600" ls={0.06} c={K.accent} glow={ACCENT_GLOW} numberOfLines={1} style={{ flex: 1 }}>{label}</M>
      {compact ? null : <T s={16} c={K.onScreenBright}>›</T>}
    </View>
    {compact ? <Lights tone="red" /> : <>
      <T s={13} c={K.onScreen} numberOfLines={1}>
        {first.approval.agentName} quiere ejecutar <M s={11} c={K.onScreen}>{first.approval.command}</M>
      </T>
      <Sweep tone="red" />
    </>}
  </RecessedScreen>;
  return <Pressable accessibilityRole="button" onPress={() => openApproval(first)} style={{ marginHorizontal: 12 }}>
    {compact ? screen : <View style={{ padding: 12, borderRadius: 20, backgroundColor: K.block, boxShadow: K.shadowBlock }}>
      <Screws />
      {screen}
    </View>}
  </Pressable>;
}

function ServerGroup({ server, pane, openAgent }: { server: ServerEntry; pane: boolean; openAgent?: string }) {
  const { K } = usePalette();
  const { snapshot, refresh } = useApp();
  const snap = snapshot(server.id);
  const down = snap.reachable === false;
  const paused = snap.serverControl?.paused === true;
  const now = useNow();
  const [scenario, setScenario] = useState(() => demoConnectionScenario(server.id));
  const cycleDemo = () => {
    const index = DEMO_CONNECTION_SCENARIOS.findIndex((s) => s.id === scenario);
    const next = DEMO_CONNECTION_SCENARIOS[(index + 1) % DEMO_CONNECTION_SCENARIOS.length];
    setDemoConnection(server.id, next.id);
    setScenario(next.id);
    refresh(server.id);
  };
  const demo = DEMO && !pane ? <View style={{ paddingHorizontal: 16 }}>
    <Keycap variant="link" label={`Demostración: ${DEMO_CONNECTION_SCENARIOS.find((s) => s.id === scenario)?.name} · Cambiar`} onPress={cycleDemo} />
  </View> : null;

  // A Servidor without response is a compact row, never the big block (ADR 0007).
  if (down && snap.down?.kind !== 'known') {
    return <View style={{ gap: 8 }}>
      {demo}
      <StateRow name={server.name} kind="unreachable" onRetry={() => refresh(server.id)} rows={snap.agents.length ? snap.agents.map((a) => a.name) : undefined} />
    </View>;
  }

  const list = (
    <ListBlock style={paused ? { marginHorizontal: 0 } : undefined}>
      {snap.agents.length === 0 ? (
        <T key="empty" s={13} c={K.inkTertiary} style={{ paddingVertical: 16 }}>
          {snap.reachable ? 'Este servidor no tiene perfiles.' : 'Conectando…'}
        </T>
      ) : null}
      {snap.agents.map((a) => (
        <AgentRow key={a.id} agent={a} serverId={server.id} now={now} paused={paused} dark={paused || down} pane={pane} open={a.id === openAgent} />
      ))}
    </ListBlock>
  );
  return (
    <View style={{ gap: 12 }}>
      <View style={{ paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Lamp tone={down ? 'red' : paused ? 'orange' : snap.reachable ? 'green' : 'off'} />
        <M s={9.5} w="600" ls={0.06} c={K.ink}>{server.name.toUpperCase()}</M>
        {paused ? <M s={9.5} ls={0.06} c={K.accentText} numberOfLines={1}>EN PAUSA</M> : null}
        <View style={{ flex: 1 }}><EngravedRule /></View>
        <M s={9.5} ls={0.06} c={down ? K.dangerText : K.inkTertiary} numberOfLines={1}>
          {down ? snap.down?.label : snap.latencyMs != null ? ms(snap.latencyMs) : '…'}
        </M>
      </View>
      {demo}
      <CompactStatusContext.Provider value><ServerConnectionStatus serverId={server.id} /></CompactStatusContext.Provider>
      {paused ? <HazardFrame radius={22} pad={4} style={{ marginHorizontal: 12 }}>{list}</HazardFrame> : list}
    </View>
  );
}

/** `dark`: paused or down, so the last snapshot's lights, badge and status no longer hold. */
function AgentRow({ agent, serverId, now, paused, dark, pane, open }: { agent: Agent; serverId: string; now: number; paused: boolean; dark: boolean; pane: boolean; open: boolean }) {
  const { K } = usePalette();
  const light = dark ? 'off' : agentLight(agentActivity(agent));
  const status = dark ? 'off' : agent.status;
  const openChat = () => router.push({ pathname: '/chat/[server]/[agent]', params: { server: serverId, agent: agent.id } });
  const ink = open ? K.onInk : K.ink;
  // Foquitos under the text: red while a Decisión waits, orange during a Turno, none at rest.
  const strip = light === 'off' ? null : <View accessible accessibilityLabel={`${agent.name}: ${light === 'red' ? 'espera una Decisión' : 'trabajando'}`} style={{ paddingTop: 4 }}>
    <Lights tone={light} />
  </View>;
  // F-1 / T-1: while the Turno runs and no Decisión waits, the list says so in words.
  const writing = light === 'orange';
  const typing = (style?: object) => <T s={13} c={open ? K.onInk : K.inkSecondary} numberOfLines={1} style={style}>está escribiendo…</T>;
  const statusLamp = { on: 'green', busy: 'orange', err: 'red', off: 'off' } as const;
  return <SwipeRow testID={`agente-${serverId}-${agent.id}`} swipeRight={{ label: 'Abrir', onAction: openChat }}>
    <Pressable accessibilityRole="button" onPress={openChat} style={{
      minHeight: pane ? 64 : 80, paddingVertical: 12, flexDirection: 'row', gap: 12, alignItems: pane ? 'center' : 'flex-start',
      ...(open ? { backgroundColor: K.ink, borderRadius: 16, marginHorizontal: -8, paddingHorizontal: 8 } : null),
    }}>
      {paused ? <PauseSymbol size={40} /> : <Avatar source={avatarFor(agent.id)} size={40} />}
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T s={15} w="700" c={ink} numberOfLines={1} style={{ flexShrink: 1 }}>{agent.name}</T>
          {agent.pendingApprovals > 0 && !pane && (paused || !dark) ? (
            <View style={{ minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, backgroundColor: K.accent, alignItems: 'center', justifyContent: 'center' }}>
              <M s={10} w="600" c={K.onAccent}>{agent.pendingApprovals}</M>
            </View>
          ) : null}
        </View>
        {pane ? null : writing ? typing() : <T s={13} c={K.inkSecondary} numberOfLines={1}>{agent.lastMessage ? plainPreview(agent.lastMessage.text) : 'Sin mensajes todavía'}</T>}
        {pane && writing ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><View style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>{strip}</View>{typing({ flexShrink: 0 })}</View> : strip}
      </View>
      {paused ? <M s={9.5} ls={0.06} c={K.accentText}>EN PAUSA</M>
        : pane ? <Lamp tone={statusLamp[status]} size={8} />
        : <View style={{ alignItems: 'flex-end', gap: 8 }}>
          <M s={11} c={K.inkSecondary}>{agent.lastMessage ? relTime(agent.lastMessage.at, now) : ''}</M>
          <LedTrio state={status} />
        </View>}
    </Pressable>
  </SwipeRow>;
}
