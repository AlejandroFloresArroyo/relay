import { usePalette } from '@/theme/ThemeProvider';
import { useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import type { LogLevel } from '../../../protocol/protocol';
import { DEMO, useApp, usePoll } from '@/state/app';
import { DEMO_LOG_STATES, setDemoLogs } from '@/core/demo';

import { TYPE } from '@/theme/tokens';
import { Keycap, Lamp, Segmented } from '@/ui/kit';
import { RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';

const LEVELS = ['TODO', 'INFO', 'WARN', 'ERROR'] as const;
/** A scope pill (an Agente's name): the chosen one is inverted. */
function Pill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const { K } = usePalette();
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: active }} hitSlop={{ top: 4, bottom: 4 }} onPress={onPress}
    style={{ minHeight: 40, minWidth: 48, paddingHorizontal: 14, borderRadius: 12, justifyContent: 'center', alignItems: 'center', backgroundColor: active ? K.ink : K.key, boxShadow: active ? undefined : K.shadowKey }}>
    <T {...TYPE.body} c={active ? K.block : K.inkSecondary}>{label}</T>
  </Pressable>;
}

export function AgentLogs({ serverId }: { serverId: string }) {
  const { K } = usePalette();
  const { clientFor, snapshot, servers } = useApp();
  const client = useMemo(() => clientFor(serverId), [clientFor, serverId]);
  const origin = servers.find(server => server.id === serverId)?.url ?? '';
  const snap = snapshot(serverId);
  const [level, setLevel] = useState<LogLevel | null>(null);
  const [agentId, setAgentId] = useState<string | undefined>();
  const [demoState, setDemoState] = useState('normal');
  const logScroll = useRef<ScrollView>(null);
  const query = `${serverId}/${agentId ?? 'default'}/${level ?? 'DEBUG'}/${demoState}`;
  const result = usePoll(async () => {
    try { return { query, client, origin, lines: await client.logs(level ?? 'DEBUG', 100, agentId), failed: false }; }
    catch { return { query, client, origin, lines: [], failed: true }; }
  }, [client, origin, level, agentId, demoState], snap.down?.automaticRetry === false ? null : 4000);
  const current = result.data?.query === query && result.data.client === client && result.data.origin === origin ? result.data : null;
  const logs = { data: current?.lines, error: current?.failed, reload: result.reload };
  const status = snap.reachable === false ? 'SIN RESPUESTA' : logs.error ? 'ERROR' : logs.data ? 'EN VIVO' : 'CARGANDO…';
  return <View style={{ gap: 8 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 }}>
      <T {...TYPE.block} c={K.ink}>Logs</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Lamp tone={snap.reachable === false || logs.error ? 'red' : !logs.data ? 'orange' : 'green'} />
        <M {...TYPE.label} c={snap.reachable === false || logs.error ? K.dangerText : !logs.data ? K.accentText : K.okText}>{status}</M>
      </View>
    </View>
    <T {...TYPE.secondary} c={K.inkSecondary} style={{ paddingHorizontal: 16 }}>Agente · {agentId ?? 'default'} · {snap.reachable === false ? 'Último estado conocido' : 'Servidor seleccionado'}</T>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 12 }}>
      <Pill label="default" active={!agentId} onPress={() => setAgentId(undefined)} />
      {snap.agents.filter(a => a.id !== 'default').map(a => <Pill key={a.id} label={a.name} active={agentId === a.id} onPress={() => setAgentId(a.id)} />)}
    </ScrollView>
    <View style={{ marginHorizontal: 12 }}><Segmented options={LEVELS} value={level ?? 'TODO'} onChange={value => setLevel(value === 'TODO' ? null : value)} /></View>
    <RecessedScreen radius={16} style={{ marginHorizontal: 12, height: 168 }}><ScrollView ref={logScroll} onContentSizeChange={() => logScroll.current?.scrollToEnd({ animated: false })} nestedScrollEnabled contentContainerStyle={{ padding: 12, gap: 4 }}>
      {logs.error ? <T s={13} c={K.onScreen}>No se pudieron cargar los logs. Reintenta.</T> : !logs.data ? <T s={13} c={K.onScreen}>Cargando logs…</T> : !logs.data.length ? <T s={13} c={K.onScreen}>Sin logs para este filtro.</T> : logs.data.map((line, i) => <View key={i} style={{ flexDirection: 'row', gap: 8 }}><M s={9.5} lh={1.85} c={K.onScreenLabel}>{line.t}</M><M s={9.5} lh={1.85} c={line.level === 'ERROR' ? K.dangerTextOnScreen : line.level === 'WARN' ? K.accent : K.onScreenLabel}>{line.level}</M><M s={9.5} lh={1.85} c={K.onScreen} style={{ flex: 1 }}>{line.msg}</M></View>)}
    </ScrollView></RecessedScreen>
    <View style={{ paddingHorizontal: 12, flexDirection: 'row' }}><Keycap variant="link" label="Actualizar logs" onPress={logs.reload} /></View>
    {DEMO ? <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16 }}>{DEMO_LOG_STATES.map(state => <Pressable key={state} accessibilityRole="button" onPress={() => { setDemoLogs(state); setDemoState(state); }}><M s={9.5} c={K.inkSecondary}>{state}</M></Pressable>)}</View> : null}
  </View>;
}
