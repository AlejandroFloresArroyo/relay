import { useLocalSearchParams } from 'expo-router';
import { useEffect, useEffectEvent, useState } from 'react';
import { Pressable, View } from 'react-native';
import { DECISION_HISTORY_LIMIT, type DecisionRecord } from '../../../protocol/protocol';
import { approvalDeadline } from '@/core/approvalTime';
import { RelayError } from '@/core/client';
import { filterDecisions, recentDecisions, type DecisionActorFilter } from '@/core/decisions';
import { DEMO_DECISION_SCENARIOS, setDemoConnection, setDemoDecisionScenario } from '@/core/demo';
import { countdown, relTime } from '@/core/format';
import { DEMO, useApp, useNow, type PendingApproval } from '@/state/app';
import { useDecisionHistory } from '@/state/useDecisionHistory';
import { usePalette } from '@/theme/ThemeProvider';
import { ledGlow, RADIUS, TEXT_GLOW, TYPE } from '@/theme/tokens';
import { StatusBarSpace } from '@/ui/chrome';
import { PullToRefresh, SwipeRow } from '@/ui/gestures';
import { RootHeader } from '@/ui/headers';
import { Keycap, ListBlock, ListRow, SectionHeader } from '@/ui/kit';
import { Lights, RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';
import { CompactStatusContext, ServerConnectionStatus } from '@/ui/ServerConnectionStatus';
import { Sheet } from '@/ui/sheet';
import { StateRow, SubjectStateBlock } from '@/ui/states';
import { TailnetPill } from '@/ui/TailnetSheet';
import { ExpiredChip } from './ApprovalSheet';

type Picker = 'agent' | 'actor' | 'origin';
type Origin = 'all' | 'relay' | 'other';
const ACTORS: readonly (readonly [DecisionActorFilter, string])[] = [['all', 'Todo'], ['person', 'Tú'], ['guardian', 'Guardián'], ['expired', 'Expiradas'], ['unknown', 'Sin atribuir']];
const ORIGINS: readonly (readonly [Origin, string])[] = [['all', 'Todos'], ['relay', 'Relay'], ['other', 'Otros canales']];

/** Aprobaciones (D-02): the AGENTE, DECIDE and CANAL selectors, the pending ones and the history. */
export function ApprovalsScreen() {
  const { K } = usePalette();
  const { pending, openApproval, servers, snapshot, refresh, refreshed } = useApp();
  const history = useDecisionHistory();
  const now = useNow(1000);
  const [agent, setAgent] = useState('all');
  const [actor, setActor] = useState<DecisionActorFilter>('all');
  const [origin, setOrigin] = useState<Origin>('all');
  const [picker, setPicker] = useState<{ kind: Picker; open: boolean }>({ kind: 'agent', open: false });
  // Demo only: `?escenario=<id>` shows one of the list's states in place of the canvas's old chips.
  const { escenario } = useLocalSearchParams<{ escenario?: string }>();
  const scenario = DEMO ? DEMO_DECISION_SCENARIOS.find(([id]) => id === escenario)?.[0] ?? 'mixed' : 'mixed';
  const retry = () => { history.retry(); refresh(); };
  const reload = async () => { await Promise.all([history.reloaded(), refreshed()]); };
  const showScenario = useEffectEvent(() => {
    setDemoDecisionScenario(scenario);
    if (scenario === 'offline') for (const server of servers) setDemoConnection(server.id, 'offline');
    retry();
  });
  useEffect(() => { if (DEMO && escenario) showScenario(); }, [escenario]);
  const demoLoading = DEMO && scenario === 'loading';

  const records = (demoLoading ? [] : history.results).flatMap(result => (result.data?.decisions ?? []).map(record => ({ ...record, serverId: result.server.id, serverName: result.server.name, stale: !!result.error, agentScope: JSON.stringify([result.server.id, record.agentId]) }))).sort((a, b) => b.at - a.at);
  const agentRows = [...servers.flatMap(server => snapshot(server.id).agents.map(value => ({ id: value.id, name: value.name, serverId: server.id, serverName: server.name }))), ...records.map(record => ({ id: record.agentId, name: record.agentName, serverId: record.serverId, serverName: record.serverName }))];
  const agents = [...new Map(agentRows.map(value => [JSON.stringify([value.serverId, value.id]), value])).entries()];

  const matching = filterDecisions(records, agent, actor, origin);
  const visible = recentDecisions(matching);
  const historyLimited = records.length >= DECISION_HISTORY_LIMIT || history.results.some(result => !!result.data?.window && result.data.window.total > result.data.decisions.length);
  const shownPending = (demoLoading ? [] : pending).filter(value => (agent === 'all' || JSON.stringify([value.serverId, value.approval.agentId]) === agent) && origin !== 'other');
  const loading = demoLoading || history.results.some(result => result.loading && !result.data) || servers.some(server => snapshot(server.id).reachable === null);
  const allUncertain = history.results.flatMap(result => (result.data?.uncertain ?? []).map(record => ({ ...record, serverId: result.server.id, serverName: result.server.name, agentScope: JSON.stringify([result.server.id, record.agentId]) })));
  const uncertain = allUncertain.filter(record => (agent === 'all' || record.agentScope === agent) && origin !== 'other');
  const unreachable = (error: unknown) => error instanceof RelayError && ['unreachable', 'timeout', 'cleartext_blocked'].includes(error.code);
  const confirmed = servers.length > 0 && servers.every(server => snapshot(server.id).reachable === true) && history.results.every(result => !result.error) && allUncertain.length === 0;
  const failed = history.results.length > 0 && history.results.every(result => result.error && !result.data) && !history.results.every(result => unreachable(result.error));

  const agentOptions: [string, string][] = [['all', 'Todos'], ...agents.map(([id, value]): [string, string] => [id, agents.filter(([, other]) => other.id === value.id).length > 1 ? `${value.name} · ${value.serverName}` : value.name])];
  const pickers = {
    agent: { label: 'AGENTE', title: 'Agente', value: agent, options: agentOptions, choose: setAgent },
    actor: { label: 'DECIDE', title: 'Quién decide', value: actor, options: ACTORS, choose: (id: string) => setActor(id as DecisionActorFilter) },
    origin: { label: 'CANAL', title: 'Canal', value: origin, options: ORIGINS, choose: (id: string) => setOrigin(id as Origin) },
  };
  const shown = pickers[picker.kind];
  const close = () => setPicker(current => ({ ...current, open: false }));
  const count = pending.length;

  return <View style={{ flex: 1, backgroundColor: K.background }}>
    <StatusBarSpace />
    <PullToRefresh onRefresh={reload} contentContainerStyle={{ paddingBottom: 20, gap: 12 }}>
      <View>
        <RootHeader title="Aprobaciones" right={<TailnetPill />} />
        <M s={9.5} ls={0.06} c={K.inkTertiary} style={{ paddingHorizontal: 16 }}>{loading ? '—' : `${count} ${count === 1 ? 'PENDIENTE' : 'PENDIENTES'} · ${records.length} EN EL HISTORIAL`}</M>
      </View>
      <View style={{ marginHorizontal: 12, flexDirection: 'row', gap: 6 }}>
        {(Object.keys(pickers) as Picker[]).map(kind => {
          const { label, value, options } = pickers[kind];
          const text = options.find(([id]) => id === value)?.[1] ?? '';
          return <Pressable key={kind} accessibilityRole="button" accessibilityLabel={`${label} · ${text}`} onPress={() => setPicker({ kind, open: true })}
            style={{ flex: 1, minHeight: 48, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12, backgroundColor: K.block, boxShadow: K.shadowBlock, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <M s={9.5} ls={0.04} c={K.inkTertiary}>{label}</M>
              <T s={13} w="600" c={K.ink} numberOfLines={1}>{text}</T>
            </View>
            <T s={12} c={K.inkSecondary}>⇕</T>
          </Pressable>;
        })}
      </View>
      <CompactStatusContext.Provider value={true}>
        {servers.map(server => <ServerConnectionStatus key={server.id} serverId={server.id} />)}
      </CompactStatusContext.Provider>
      {servers.filter(server => snapshot(server.id).reachable === false).map(server => <StateRow key={server.id} name={server.name} kind="unreachable" onRetry={() => refresh(server.id)} />)}
      {history.results.filter(result => unreachable(result.error) && snapshot(result.server.id).reachable !== false).map(result => <StateRow key={result.server.id} name={result.server.name} kind="unreachable" onRetry={retry} />)}
      {uncertain.map(record => <RecessedScreen key={`${record.serverId}:${record.id}`} rim radius={16} style={{ marginHorizontal: 12, padding: 16, gap: 8 }}>
        <M s={13} w="600" ls={0.08} c={K.accent} glow={TEXT_GLOW.accent}>DECISIÓN SIN CONFIRMAR</M>
        <M s={11} c={K.onScreenBright}>{record.command}</M>
        <T {...TYPE.secondary} c={K.onScreen}>No se conoce el resultado. Relay no enviará esta elección otra vez.</T>
      </RecessedScreen>)}
      {history.results.filter(result => result.error && result.data).map(result => <T key={result.server.id} {...TYPE.secondary} c={K.inkTertiary} style={{ paddingHorizontal: 16 }}>{result.server.name}: historial guardado · último dato {relTime(result.data!.capturedAt, now)}. No se pudo actualizar el historial. Reintenta.</T>)}
      {loading ? <View style={{ marginHorizontal: 12 }}><SubjectStateBlock spec={{ kind: 'loading', what: 'Aprobaciones' }} /></View> : null}
      {failed ? <View style={{ marginHorizontal: 12 }}><SubjectStateBlock spec={{ kind: 'error', verb: 'cargar el historial', onRetry: retry }} /></View> : null}
      {!failed ? history.results.filter(result => result.error && !result.data && !unreachable(result.error)).map(result => <View key={result.server.id} style={{ marginHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T {...TYPE.secondary} c={K.inkSecondary} style={{ flex: 1 }}>No se pudo cargar el historial de {result.server.name}. Reintenta.</T>
        <Keycap variant="link" label="Reintentar" onPress={retry} />
      </View>) : null}
      {shownPending.length > 0 ? <>
        <SectionHeader title={`PENDIENTES · ${shownPending.length}`} />
        {shownPending.map(value => <PendingCard key={`${value.serverId}:${value.approval.id}`} value={value} now={now} offline={snapshot(value.serverId).reachable === false} onOpen={() => openApproval(value)} />)}
      </> : null}
      {!loading && !failed && confirmed && pending.length === 0
        ? <View style={{ marginHorizontal: 12 }}><SubjectStateBlock spec={{ kind: 'empty', title: 'SIN APROBACIONES PENDIENTES', phrase: 'Aquí aparecen cuando un Agente pida permiso.' }} /></View>
        : null}
      {records.length > 0 ? <>
        <SectionHeader title={`HISTORIAL RECIENTE · ${visible.length} DE ${records.length}`} />
        {historyLimited ? <T {...TYPE.secondary} c={K.inkTertiary} style={{ paddingHorizontal: 16 }}>Mostrando los {visible.length} registros más recientes de este filtro (máximo 100 visibles). Los filtros se aplican solo a los últimos 100 registros de cada Servidor. El registro original se conserva en el Servidor.</T> : null}
        {visible.length === 0
          ? <T {...TYPE.secondary} c={K.inkTertiary} style={{ paddingHorizontal: 16 }}>No hay registros con estos filtros.</T>
          : <ListBlock>{visible.map(record => <DecisionRow key={`${record.serverId}:${record.id}`} record={record} now={now} />)}</ListBlock>}
      </> : null}
    </PullToRefresh>
    <Sheet visible={picker.open} onClose={close} title={shown.title}>
      <ListBlock style={{ marginHorizontal: 0 }}>
        {shown.options.map(([id, label]) => <ListRow key={id} title={label} value={id === shown.value ? 'ELEGIDO' : undefined} valueTone="accent" onPress={() => { shown.choose(id); close(); }} />)}
      </ListBlock>
    </Sheet>
  </View>;
}

/** A pending Aprobación: countdown, command on its screen with the red foquitos, and «Revisar ›». Swiping it right opens its sheet, never approves it. */
function PendingCard({ value, now, offline, onOpen }: { value: PendingApproval; now: number; offline: boolean; onOpen: () => void }) {
  const { K } = usePalette();
  const a = value.approval;
  const deadline = approvalDeadline(a.expiresAt, value.clockOffsetMs);
  const expired = deadline !== null && deadline <= now;
  const live = !offline && !expired;
  const fill = deadline === null || !live ? 0 : Math.min(1, Math.max(0, (deadline - now) / Math.max(1, deadline - (a.createdAt + (value.clockOffsetMs ?? 0)))));
  return <SwipeRow testID={`approval-${value.serverId}-${a.id}`} swipeRight={live ? { label: 'Revisar', onAction: onOpen } : undefined}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Revisar comando de ${a.agentName}`} accessibilityState={{ disabled: !live }} disabled={!live} onPress={onOpen}
      style={{ margin: 12, marginVertical: 4, padding: 12, gap: 10, borderRadius: RADIUS.block, backgroundColor: K.block, opacity: offline ? 0.6 : 1,
        boxShadow: live ? `${K.shadowBlock}, 0px 0px 0px 1.5px ${K.accent}, ${ledGlow(K.accent)}` : K.shadowBlock }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 24 }}>
        <M s={9.5} ls={0.06} c={K.inkTertiary} style={{ flex: 1 }}>{a.agentName.toUpperCase()} · {value.serverName.toUpperCase()} · CREADA {relTime(a.createdAt + (value.clockOffsetMs ?? 0), now)}</M>
        {offline ? <M {...TYPE.label} c={K.dangerText}>SIN RESPUESTA</M>
          : expired ? <ExpiredChip />
          : deadline !== null ? <M s={13} w="600" c={K.accentText}>{countdown(deadline - now)}</M>
          : <M {...TYPE.label} c={K.accentText}>PENDIENTE</M>}
      </View>
      {deadline !== null ? <View style={{ height: 4, borderRadius: 2, backgroundColor: K.field, overflow: 'hidden' }}>
        <View style={{ alignSelf: 'flex-end', width: `${fill * 100}%`, height: 4, backgroundColor: K.accent, boxShadow: ledGlow(K.accent) }} />
      </View> : null}
      <RecessedScreen radius={14} style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
        <M s={16} w="500" c={K.accent} glow={TEXT_GLOW.accent} numberOfLines={2}><M s={16} w="500" c={K.onScreenLabel}>$ </M>{a.command}</M>
      </RecessedScreen>
      {live ? <Lights tone="red" /> : null}
      {a.risk ? <T {...TYPE.secondary} lh={1.45} c={K.inkSecondary}>{a.risk.summary}</T> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <M {...TYPE.label} ls={0.06} c={K.accentText}>{a.risk ? `RIESGO ${a.risk.level}/5` : ''}</M>
        <T s={15} w="600" c={K.accentText}>Revisar ›</T>
      </View>
    </Pressable>
  </SwipeRow>;
}

const BADGE: Record<DecisionRecord['actor'], string> = { person: 'TÚ', guardian: 'AUTO', expired: 'EXP', unknown: '?' };

/** A row of the history: who decided as a badge, the command, where and when, and the outcome. It carries no light. */
function DecisionRow({ record, now }: { record: DecisionRecord & { serverName?: string }; now: number }) {
  const { K } = usePalette();
  const expired = record.outcome === 'expired';
  const label = expired ? 'EXPIRÓ SIN RESPUESTA' : record.outcome === 'approved' ? 'APROBADA' : record.outcome === 'rejected' ? 'RECHAZADA' : 'EJECUTADO · SIN ATRIBUIR';
  const tone = record.outcome === 'approved' ? K.okText : record.outcome === 'rejected' ? K.dangerText : K.inkTertiary;
  return <View style={{ minHeight: 72, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
    <View style={{ width: 40, height: 40, borderRadius: 12, boxShadow: `inset 0px 0px 0px 1.5px ${K.onScreenLabel}`, alignItems: 'center', justifyContent: 'center' }}>
      <M s={9.5} c={K.inkSecondary}>{BADGE[record.actor]}</M>
    </View>
    <View style={{ flex: 1, gap: 2 }}>
      <M s={13} c={expired ? K.inkTertiary : K.ink} numberOfLines={2} style={{ textDecorationLine: expired ? 'line-through' : 'none' }}>{record.command}</M>
      {record.commandTruncated ? <M s={9.5} c={K.inkTertiary}>COMANDO ABREVIADO</M> : null}
      <T {...TYPE.secondary} c={K.inkSecondary}>{record.agentName} · {record.serverName} · {record.originLabel} · {relTime(record.at, now)}</T>
      <M s={9.5} ls={0.06} c={K.inkTertiary}>{record.timeKind === 'result' ? 'HORA DEL RESULTADO' : 'HORA DE LA DECISIÓN'}</M>
      <M {...TYPE.label} ls={0.06} c={tone}>{label}{record.actor === 'guardian' ? ' · GUARDIÁN' : record.actor === 'person' ? ' · TÚ' : ''}</M>
    </View>
  </View>;
}
