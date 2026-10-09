import { usePalette } from '@/theme/ThemeProvider';
import { AgentLogs } from './AgentLogs';
import { router } from 'expo-router';
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ScrollView, View, type StyleProp, type ViewStyle } from 'react-native';

import type { DoctorReport, GatewayStatus } from '../../../protocol/protocol';
import type { GatewayAction } from '@/core/client';
import { serverConnectionPresentation } from '@/core/connectionStatus';
import { DEMO_METRICS_STATES, demoMetricsState, setDemoMetricsState } from '@/core/demo';
import { DEMO_SERVER_CONTROL_SCENARIOS, demoServerControlScenario, setDemoServerControlScenario } from '@/core/demoServerControl';
import { gaugeReading } from '@/core/machinery';
import { estimatedCost } from '@/core/serverUsage';
import { describeTailscaleButton, transitionTailscaleButton, type TailscaleButtonState } from '@/core/tailscaleButton';
import { confirmWithFingerprint } from '@/state/confirmWithFingerprint';
import { openTailscale } from '@/state/openTailscale';
import { useControlScope } from '@/state/useControlScope';
import { useServerMetrics, type MetricsView } from '@/state/useServerMetrics';
import { GatewayConfirmation } from './GatewayConfirmation';
import { ServerPauseControl } from './ServerPauseControl';
import { hostOf, uptime } from '@/core/format';
import { DEMO, useApp, usePoll } from '@/state/app';
import { goToTab, useOpenSection, useReturn } from '@/state/navigation';
import { RADIUS, TEXT_GLOW, TYPE } from '@/theme/tokens';

import { StatusBarSpace } from '@/ui/chrome';
import { DetailHeader } from '@/ui/headers';
import { BackLink, Keycap, Lamp, ListBlock, ListRow, SectionHeader } from '@/ui/kit';
import { ShellNavigationContext } from '@/ui/layoutContext';
import { Needle, Odometer, RecessedScreen, Screws } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';
import { ServerConnectionStatus } from '@/ui/ServerConnectionStatus';
import { Sheet } from '@/ui/sheet';
import { SubjectStateBlock } from '@/ui/states';

/** A gauge enters its high zone (orange) from here. */
const GAUGE_SCALE = { max: 100, redFrom: 80 };
const GATEWAY_RIM = '0px 0px 0px 1px rgba(76,199,116,0.25), 0px 0px 16px rgba(76,199,116,0.14)';

/** La ficha del Servidor (F-4, T-2): its state (gateway, uptime, gauges, Pausa general), then its destinations. */
export function ServerScreen({ serverId }: { serverId: string }) {
  const { K } = usePalette();
  const { servers, clientFor, snapshot, refresh, selectServer } = useApp();
  const wide = useContext(ShellNavigationContext);
  const ret = useReturn();
  const open = useOpenSection();
  const server = servers.find((s) => s.id === serverId);
  const client = useMemo(() => clientFor(serverId), [clientFor, serverId]);
  const snap = snapshot(serverId);
  const down = snap.reachable === false;
  const autoPoll = snap.down?.automaticRetry !== false;
  const name = server?.name ?? 'Servidor';

  const info = usePoll(() => client.server(), [client, snap.reachable]);
  const gw = usePoll(() => client.gateway(), [client], autoPoll ? 5000 : null);
  const jobs = usePoll(() => client.jobs(), [client], autoPoll ? 30000 : null);
  const week = usePoll(() => client.usage('week'), [client, snap.reachable]);

  const [demoControl, setDemoControl] = useState(() => demoServerControlScenario(serverId));
  const [demoMetrics, setDemoMetrics] = useState(demoMetricsState);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [doctoring, setDoctoring] = useState(false);
  const [acting, setActing] = useState<GatewayAction | null>(null);
  const [confirmation, setConfirmation] = useState<{ action: 'stop' | 'restart'; current: () => boolean } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const actingRef = useRef(false);
  const scope = useControlScope(client, !down);
  const metrics = useServerMetrics(client, snap.health?.body, scope.visible);
  const decisionGeneration = useRef(0);
  const cancelGateway = useCallback(() => { decisionGeneration.current++; setConfirmation(null); }, []);
  const [decisionScope, setDecisionScope] = useState({ client, visible: scope.visible, revision: scope.revision });
  // LockGate preserves this screen's mount. Retire its decision before rendering a new scope.
  if (decisionScope.client !== client || decisionScope.visible !== scope.visible || decisionScope.revision !== scope.revision) {
    setDecisionScope({ client, visible: scope.visible, revision: scope.revision }); setConfirmation(null);
  }
  const confirmGateway = (action: 'stop' | 'restart') => {
    const current = scope.begin();
    const generation = ++decisionGeneration.current;
    if (current) setConfirmation({ action, current: () => current() && generation === decisionGeneration.current });
  };

  const runDoctor = async () => {
    if (doctoring) return;
    setDoctoring(true);
    try {
      setDoctor(await client.doctor());
    } catch {
      refresh();
      setDoctor({ ranAt: Date.now(), checks: [{ label: 'Doctor', value: 'sin respuesta', ok: false }] });
    } finally {
      setDoctoring(false);
    }
  };
  // The prototype shows the diagnosis already filled in; only the demo runs it unasked.
  useEffect(() => {
    if (DEMO) void client.doctor().then(setDoctor, () => {});
  }, [client]);

  const act = async (action: GatewayAction) => {
    if (actingRef.current || down) return;
    const current = scope.begin();
    if (!current) return;
    actingRef.current = true; setActing(action); setActionError(null); cancelGateway();
    try {
      const confirmed = action !== 'start' || await confirmWithFingerprint('Iniciar gateway con huella');
      if (!current()) return;
      if (!confirmed) {
        setActionError('No se confirmó la huella. El gateway no cambió.'); return;
      }
      const result = await client.gatewayAction(action);
      if (current()) gw.setData(result);
    } catch {
      if (!current()) return;
      setActionError('El cambio del gateway quedó sin confirmar. Reintenta cuando vuelva a responder.');
      refresh(); gw.reload();
    } finally { actingRef.current = false; setActing(null); }
  };

  const status: GatewayStatus | null = gw.data;
  const active = status?.state === 'active';
  const enabledJobs = jobs.data?.filter((job) => job.enabled).length;
  // A partial week still shows what is known, as Uso y costo does.
  const cost = week.data ? week.data.total.estimatedCostUsd ?? week.data.totalsKnown.estimatedCostUsd : null;
  const line = `${hostOf(server?.url ?? '').toUpperCase()}${info.data ? ` · HERMES ${info.data.hermesVersion}` : ''}`;

  const gateway = <RecessedScreen radius={wide ? 16 : 14} style={[{ paddingHorizontal: 14, paddingVertical: 10, boxShadow: active ? `${K.shadowScreen}, ${GATEWAY_RIM}` : K.shadowScreen },
    wide ? { width: 237, justifyContent: 'space-between', paddingVertical: 14 } : { minHeight: 66, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
    <View style={{ gap: 6 }}>
      <M s={9.5} ls={0.08} c={K.onScreenLabel}>GATEWAY</M>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Lamp tone={active ? 'green' : 'off'} size={10} onScreen />
        <M s={wide ? 24 : 20} w="600" c={active ? K.okTextOnScreen : K.onScreen} glow={active ? TEXT_GLOW.ok : undefined}>
          {acting ? 'PENDIENTE…' : gw.error ? 'SIN RESPUESTA' : status == null ? '…' : active ? 'ACTIVO' : status.state === 'stopped' ? 'DETENIDO' : 'DESCONOCIDO'}
        </M>
      </View>
    </View>
    <View style={{ gap: 6, alignItems: wide ? 'flex-start' : 'flex-end' }}>
      {wide ? null : <M s={9.5} ls={0.08} c={K.onScreenLabel}>UPTIME</M>}
      {/* uptimeSeconds counts seconds: 533 520 reads 6D04:12. */}
      <Odometer value={uptime(active ? (status?.uptimeSeconds ?? null) : null).replace(' ', '')} />
    </View>
  </RecessedScreen>;

  const gauges = <Gauges metrics={metrics} wide={wide} />;

  const keys = <View style={{ flexDirection: 'row', gap: 8 }}>
    <Keycap label="Iniciar" disabled={down || !!acting || active} onPress={() => { void act('start'); }} style={{ flex: 1 }} />
    <Keycap label="Detener" variant="danger" disabled={down || !!acting || !active} onPress={() => confirmGateway('stop')} style={{ flex: 1 }} />
    <Keycap label="Reiniciar" disabled={down || !!acting} onPress={() => confirmGateway('restart')} style={{ flex: 1 }} />
  </View>;

  const pause = <ServerPauseControl key={`${serverId}:${demoControl}`} client={client} name={name} down={down} wide={wide} />;

  const destinations = <ListBlock style={wide ? { marginHorizontal: 0 } : undefined}>
    <ListRow plate="TERM" title="Herramientas" value="PIDE HUELLA" chevron
      onPress={() => { selectServer(serverId); router.push({ pathname: '/tools/[server]', params: { server: serverId } }); }} />
    <ListRow plate="CRON" title="Tareas programadas" chevron onPress={() => open(serverId, 'jobs')}
      value={enabledJobs === undefined ? undefined : enabledJobs === 0 ? 'SIN TAREAS ACTIVAS' : `${enabledJobs} ${enabledJobs === 1 ? 'ACTIVA' : 'ACTIVAS'}`} />
    <ListRow plate="USO" title="Uso y costo" value={cost === null ? undefined : `${estimatedCost(cost)} SEM.`} chevron
      onPress={() => { selectServer(serverId); router.push({ pathname: '/usage/[server]', params: { server: serverId } }); }} />
  </ListBlock>;

  return (
    <View style={{ flex: 1, backgroundColor: K.background }}>
      <StatusBarSpace />
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24, gap: 12 }}>
        {wide
          ? <View style={{ paddingHorizontal: 16, paddingTop: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 12 }}>
            {ret ? <BackLink to={ret.label} onPress={ret.go} /> : null}
            <T {...TYPE.title} c={K.ink} accessibilityRole="header">{name}</T>
            <M s={9.5} ls={0.04} c={K.inkTertiary}>{line}</M>
          </View>
          : <DetailHeader back={ret?.label ?? 'Servidores'} onBack={ret?.go ?? (() => goToTab('servers'))} title={name} subtitle={line} />}

        {down ? <DownState serverId={serverId} name={name} /> : wide ? <>
          <InstrumentBlock radius={24} style={{ marginHorizontal: 12, minHeight: 202, padding: 12, flexDirection: 'row', gap: 10 }}>{gateway}{gauges}</InstrumentBlock>
          <View style={{ marginHorizontal: 12, flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
            <View style={{ flex: 1, gap: 12 }}>{pause}{keys}</View>
            <View style={{ flex: 1 }}>{destinations}</View>
          </View>
        </> : <>
          <InstrumentBlock radius={RADIUS.block} style={{ marginHorizontal: 12, padding: 10, gap: 8 }}>{gateway}{gauges}{keys}</InstrumentBlock>
          <View style={{ marginHorizontal: 12 }}>{pause}</View>
          {destinations}
        </>}
        {down ? destinations : null}

        {actionError ? <T {...TYPE.secondary} c={K.dangerText} style={{ paddingHorizontal: 16 }}>{actionError}</T> : null}
        {DEMO ? <View style={{ paddingHorizontal: 16 }}>
          <Keycap variant="link" label={`Control demo: ${DEMO_SERVER_CONTROL_SCENARIOS.find((scenario) => scenario.id === demoControl)?.name} · Cambiar`} onPress={() => {
            const index = DEMO_SERVER_CONTROL_SCENARIOS.findIndex((scenario) => scenario.id === demoControl);
            const next = DEMO_SERVER_CONTROL_SCENARIOS[(index + 1) % DEMO_SERVER_CONTROL_SCENARIOS.length];
            setDemoServerControlScenario(serverId, next.id); setDemoControl(next.id); gw.reload(); refresh(serverId);
          }} />
          <Keycap variant="link" label={`Métricas demo: ${DEMO_METRICS_STATES.find((state) => state.id === demoMetrics)?.name} · Cambiar`} onPress={() => {
            const next = DEMO_METRICS_STATES[(DEMO_METRICS_STATES.findIndex((state) => state.id === demoMetrics) + 1) % DEMO_METRICS_STATES.length];
            setDemoMetricsState(next.id); setDemoMetrics(next.id);
          }} />
        </View> : null}

        <ServerActions serverId={serverId} name={name} canUpdate={!!server && scope.visible} />

        {!down ? <>
          <SectionHeader title="DIAGNÓSTICO" action={{ label: doctoring ? 'Ejecutando…' : 'Ejecutar doctor', onPress: () => { void runDoctor(); } }} />
          <ListBlock>
            {doctor ? doctor.checks.map((check) => <ListRow key={check.label} title={check.label} value={check.value} valueTone={check.ok ? 'neutral' : 'accent'} />)
              : [<ListRow key="none" title="Sin ejecutar todavía." />]}
          </ListBlock>
          <View style={{ paddingHorizontal: 12 }}><AgentLogs key={serverId} serverId={serverId} /></View>
        </> : null}
      </ScrollView>
      {confirmation && scope.visible ? <GatewayConfirmation action={confirmation.action} visible={scope.visible} serverName={name} onConfirm={() => { if (confirmation.current()) void act(confirmation.action); }} onCancel={cancelGateway} /> : null}
    </View>
  );
}

/** Bloque de instrumentos: a screwed block. */
function InstrumentBlock({ radius, style, children }: { radius: number; style: StyleProp<ViewStyle>; children: ReactNode }) {
  const { K } = usePalette();
  return <View style={[{ borderRadius: radius, backgroundColor: K.block, boxShadow: K.shadowBlock }, style]}><Screws />{children}</View>;
}

/** CPU, MEM and DISCO, or why they are missing. Fixed-data needles: they move only when the reading changes. */
function Gauges({ metrics, wide }: { metrics: MetricsView; wide: boolean }) {
  const { K } = usePalette();
  if (metrics.state === 'not_advertised') {
    return <RecessedScreen radius={wide ? 16 : 12} style={[{ justifyContent: 'center', paddingHorizontal: 16 }, wide ? { flex: 1 } : { minHeight: 72 }]}>
      <T {...TYPE.secondary} c={K.onScreen}>Actualiza el Puente para ver CPU, MEM y DISCO</T>
    </RecessedScreen>;
  }
  const reading = metrics.state === 'reading' ? metrics.metrics : null;
  const stale = metrics.state === 'reading' && metrics.stale && reading !== null;
  const values: [string, number | null][] = [['CPU', reading?.cpuPercent ?? null], ['MEM', reading?.memoryPercent ?? null], ['DISCO', reading?.diskPercent ?? null]];
  return <View style={{ flex: wide ? 3 : undefined, flexDirection: 'row', gap: wide ? 10 : 8 }}>
    {values.map(([label, value]) => <Gauge key={label} label={label} value={value} stale={stale} wide={wide} />)}
  </View>;
}

function Gauge({ label, value, stale, wide }: { label: string; value: number | null; stale: boolean; wide: boolean }) {
  const { K } = usePalette();
  const reading = gaugeReading(value ?? 0, GAUGE_SCALE);
  const scale = wide ? 1.55 : 0.78;
  const shown = <M s={wide ? 13 : 9.5} w={wide ? '600' : '400'} c={value !== null && reading.red ? K.accent : K.onScreen}>{value === null ? '— %' : `${Math.round(value)} %`}</M>;
  const old = stale ? <M s={9.5} w="600" c={K.accent}>VIEJA</M> : null;
  return <RecessedScreen radius={wide ? 16 : 12} style={{ flex: 1, height: wide ? undefined : 72, overflow: 'hidden', alignItems: 'center' }}>
    {wide ? <View style={{ alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 10 }}>
      <M s={9.5} c={K.onScreenLabel}>{label}</M>{old}<View style={{ flex: 1 }} />{shown}
    </View> : null}
    <View style={{ width: 112 * scale, height: 80 * scale, marginTop: wide ? 8 : 0 }}>
      <View style={{ width: 112, height: 80, transformOrigin: 'top left', transform: [{ scale }] }}><Needle data reading={reading} /></View>
    </View>
    {wide ? null : <>
      {old ? <View style={{ position: 'absolute', top: 4, left: 8 }}>{old}</View> : null}
      <View style={{ position: 'absolute', left: 8, right: 8, bottom: 5, flexDirection: 'row', justifyContent: 'space-between' }}>
        <M s={9.5} c={K.onScreenLabel}>{label}</M>{shown}
      </View>
    </>}
  </RecessedScreen>;
}

/**
 * The state of a Servidor that does not answer, here where it is the subject: the big block with
 * «Reintentar» and «Abrir Tailscale», or «Emparejar de nuevo» when it no longer accepts this phone.
 */
function DownState({ serverId, name }: { serverId: string; name: string }) {
  const { snapshot, refresh } = useApp();
  const [tailscale, setTailscale] = useState<TailscaleButtonState>('ready');
  const diagnosis = serverConnectionPresentation(snapshot(serverId))?.diagnosis;
  const pair = () => router.push({ pathname: '/connect', params: { serverId } });
  if (diagnosis?.kind === 'unreachable') {
    const button = describeTailscaleButton(tailscale);
    const launch = async () => {
      const transition = transitionTailscaleButton(tailscale, { type: 'press' });
      setTailscale(transition.state);
      if (transition.effect === 'retry') refresh(serverId);
      if (transition.effect === 'open') {
        const opened = await openTailscale();
        setTailscale((current) => transitionTailscaleButton(current, { type: 'result', opened }).state);
      }
    };
    return <View style={{ marginHorizontal: 12, gap: 12 }}>
      <SubjectStateBlock spec={{ kind: 'unreachable', phrase: `${name} no contesta. Revisa Tailscale en este teléfono y que el Puente esté corriendo.`, onRetry: () => refresh(serverId) }} />
      <Keycap variant="primary" label={button.label} disabled={button.disabled} onPress={() => { void launch(); }} />
    </View>;
  }
  if (diagnosis?.action === 'pair') {
    return <View style={{ marginHorizontal: 12 }}>
      <SubjectStateBlock spec={{ kind: 'noAccess', phrase: `Este dispositivo perdió el acceso a ${name}.`, action: { label: 'Emparejar de nuevo', onPress: pair } }} />
    </View>;
  }
  return <View style={{ marginHorizontal: 12 }}><ServerConnectionStatus serverId={serverId} subject /></View>;
}

/** What this phone does with the Servidor (15-2, 15-3): its APK update, default, pairing again and removal. */
function ServerActions({ serverId, name, canUpdate }: { serverId: string; name: string; canUpdate: boolean }) {
  const { K } = usePalette();
  const { servers, removeServer, setDefaultServer } = useApp();
  const isDefault = servers.find((s) => s.id === serverId)?.isDefault === true;
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutate = async (remove: boolean) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (remove) { await removeServer(serverId); setConfirmRemove(false); goToTab('servers'); } else await setDefaultServer(serverId);
    } catch { setError(remove ? 'No se pudo quitar el Servidor. Reintenta.' : 'No se pudo marcar como predeterminado. Reintenta.'); } finally { setBusy(false); }
  };
  return <>
    <SectionHeader title="EN ESTE TELÉFONO" />
    <ListBlock>
      <ListRow plate="APK" title="Actualización APK" chevron onPress={() => { if (canUpdate) router.push({ pathname: '/app-update/[server]', params: { server: serverId } }); }} />
      {isDefault ? null : <ListRow title="Marcar como predeterminado" meta="SE ABRE PRIMERO AL INICIAR" disabled={busy} onPress={() => { void mutate(false); }} />}
      <ListRow title="Emparejar de nuevo" meta="UN CÓDIGO NUEVO DE RELAYD PAIR" chevron disabled={busy} onPress={() => router.push({ pathname: '/connect', params: { serverId } })} />
      <ListRow title="Quitar de Relay" meta="NO TOCA NADA EN EL SERVIDOR" disabled={busy} onPress={() => { setError(null); setConfirmRemove(true); }} />
    </ListBlock>
    {error && !confirmRemove ? <T {...TYPE.secondary} c={K.dangerText} style={{ paddingHorizontal: 16 }}>{error}</T> : null}
    <Sheet visible={confirmRemove} onClose={() => setConfirmRemove(false)} title={`¿Quitar ${name}?`} subtitle="SOLO EN ESTE TELÉFONO" action={<>
      <Keycap label="Cancelar" disabled={busy} onPress={() => setConfirmRemove(false)} style={{ flex: 1 }} />
      <Keycap label="Quitar" variant="danger" disabled={busy} onPress={() => { void mutate(true); }} style={{ flex: 1 }} />
    </>}>
      <T {...TYPE.secondary} c={K.inkSecondary}>Relay olvida la dirección y su emparejamiento. Hermes y sus Agentes siguen funcionando en el Servidor; puedes volver a agregarlo.</T>
      {error ? <T {...TYPE.secondary} c={K.dangerText}>{error}</T> : null}
    </Sheet>
  </>;
}
