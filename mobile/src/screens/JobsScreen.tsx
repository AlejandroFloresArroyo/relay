import { usePalette } from '@/theme/ThemeProvider';
import { useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import type { JobHistory, ScheduledJob, ScheduledJobInput } from '../../../protocol/scheduledJobs';
import { DEMO_JOB_SCENARIOS, setDemoJobScenario } from '@/core/demo';
import { jobHasFailed, jobIsPaused, jobIsRunning, jobStateLabel, jobScheduleLabel, jobTime, jobWindow } from '@/core/scheduledJobs';
import { DEMO, useApp, useNow, usePoll } from '@/state/app';
import { useJobAction } from '@/state/useJobAction';
import { F, RADIUS, TYPE } from '@/theme/tokens';
import { StatusBarSpace } from '@/ui/chrome';
import { M, T } from '@/ui/primitives';
import { RootHeader } from '@/ui/headers';
import { Keycap, IconKey, Lamp, ListBlock, Segmented } from '@/ui/kit';
import { PullToRefresh, SwipeRow } from '@/ui/gestures';
import { RecessedScreen, Screws, Sweep } from '@/ui/machinery';
import { Sheet, Toast } from '@/ui/sheet';
import { SubjectStateBlock } from '@/ui/states';
import { HeaderServerSelector, ServerDown } from '@/ui/ServerSelector';
import { useReturn, type ReturnLink } from '@/state/navigation';
import { ServerConnectionStatus } from '@/ui/ServerConnectionStatus';
function Button({ label, onPress, disabled = false, orange = false, compact = false }: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  orange?: boolean;
  compact?: boolean;
}) {
  return <Keycap label={label} variant={orange ? 'primary' : 'normal'} disabled={disabled} onPress={onPress} style={compact ? { flex: 1 } : undefined} />;
}
/** A selectable chip: the chosen one is inverted. */
function Choice({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const { K } = usePalette();
  return <Pressable role="button" accessibilityState={{ selected: active }} onPress={onPress}
    style={{ minHeight: 32, paddingHorizontal: 11, borderRadius: RADIUS.chip, justifyContent: 'center', backgroundColor: active ? K.ink : K.key, boxShadow: active ? undefined : K.shadowKey }}>
    <M {...TYPE.label} c={active ? K.block : K.inkSecondary}>{label}</M>
  </Pressable>;
}
function Frame({ serverId, title, back, children }: {
  serverId: string;
  title: string;
  back?: ReturnLink | null;
  children: React.ReactNode;
}) {
  const { K } = usePalette();
  return <View style={{ flex: 1, backgroundColor: K.background }}>
  <StatusBarSpace />
  <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 12, gap: 9, paddingBottom: 24 }}>
  {back ? <Pressable onPress={back.go} accessibilityRole="button" accessibilityLabel={`Volver a ${back.label}`}>
  <T c={K.accentText} s={14} w="600">‹ {back.label}</T>
  </Pressable> : null}
  <T s={26} w="700" ls={-0.025}>{title}</T>
  <ServerConnectionStatus serverId={serverId}/>{children}
  </ScrollView>
  </View>;
}
function Form({ initial, timezone, onSave, onCancel, busy, editing, agents, agent, onAgent }: {
  initial?: ScheduledJob;
  timezone: string | null;
  onSave: (input: ScheduledJobInput) => void;
  onCancel: () => void;
  busy: boolean;
  editing: boolean;
  agents?: {
    id: string;
    name: string;
  }[];
  agent?: string;
  onAgent?: (id: string) => void;
}) {
  const { K } = usePalette();
  const [name, setName] = useState(initial?.name ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [schedule, setSchedule] = useState(initial?.schedule ?? '0 9 * * 1-5');
  const [deliver, setDeliver] = useState(initial?.deliver ?? 'local');
  const [skills, setSkills] = useState(initial?.skills.join(', ') ?? '');
  const [repeat, setRepeat] = useState(initial?.repeat?.toString() ?? '');
  const [error, setError] = useState<string | null>(null);
  function save() {
    const times = repeat.trim() ? Number(repeat) : null;
    if (!name.trim() || !prompt.trim() && !skills.trim() && !initial?.script || !schedule.trim() || !deliver.trim() || Array.from(name).length > 200 || Array.from(prompt).length > 5000 || times !== null && (!Number.isInteger(times) || times < 1)) {
      setError('Revisa nombre, instrucción, horario, entrega y repeticiones.');
      return;
    }
    onSave({ name: name.trim(), prompt, schedule: schedule.trim(), deliver: deliver.trim(), skills: skills.split(',').map(s => s.trim()).filter(Boolean), repeat: times });
  }
  return <View style={{ gap: 12 }}>
  <T s={20} w="700">{editing ? 'Editar tarea' : 'Nueva tarea'}</T>
  {agents ? <>
    <M s={10} c={K.inkTertiary}>AGENTE</M>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{agents.map(a => <Choice key={a.id} label={a.name} active={a.id === agent} onPress={() => onAgent?.(a.id)}/>)}</View>
    </> : null}
  {[["Nombre", name, setName], ["Instrucción", prompt, setPrompt], ["Horario", schedule, setSchedule], ["Entrega", deliver, setDeliver], ["Skills (separadas por coma)", skills, setSkills], ["Repeticiones (vacío: sin límite)", repeat, setRepeat]].map(([label, value, set]) => <View key={label as string} style={{ gap: 5 }}>
    <M s={10} c={K.inkTertiary}>{(label as string).toUpperCase()}</M>{label === 'Horario' ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>{[['Cada hora', '0 * * * *'], ['Diario', '0 9 * * *'], ['Laborables', '0 9 * * 1-5'], ['Semanal', '0 9 * * 1']].map(([preset, expression]) => <Choice key={preset} label={preset} active={schedule === expression} onPress={() => { if (!busy)
          setSchedule(expression); }}/>)}</View> : null}<TextInput accessibilityLabel={label as string} value={value as string} onChangeText={set as (s: string) => void} multiline={label === 'Instrucción'} editable={!busy} style={{ backgroundColor: K.field, color: K.ink, fontFamily: F.sans['400'], fontSize: 14, padding: 12, borderRadius: 12, minHeight: label === 'Instrucción' ? 86 : 44 }}/>
    </View>)}
  <RecessedScreen radius={14} style={{ padding: 12, gap: 6 }}>
  <T c={K.onScreenBright} s={13}>{jobScheduleLabel(schedule)}</T>
  <M c={K.okTextOnScreen} s={10}>{schedule}</M>
  <M c={K.onScreenLabel} {...TYPE.label}>{timezone ?? 'ZONA DE HERMES NO DISPONIBLE'}</M>
  </RecessedScreen>
  <T s={12} c={K.inkSecondary}>Cron de 5 campos, intervalo «every 30m» o fecha ISO con zona. Hermes calcula el horario y los cambios de hora en {timezone ?? 'una zona aún no disponible'}.</T>
  <T s={12} c={K.inkTertiary}>Modelo, directorio y script se cambian en el Servidor.</T>
  {error ? <T c={K.dangerText}>{error}</T> : null}
  <Button label={busy ? 'Confirmando…' : editing ? 'Guardar con huella' : 'Crear con huella'} orange disabled={busy || !timezone || !agent && !editing} onPress={save}/>
  <Button label="Cancelar" disabled={busy} onPress={onCancel}/>
  </View>;
}
export function JobsScreen({ serverId }: {
  serverId: string;
}) {
  const { K } = usePalette();
  const { clientFor, snapshot, servers } = useApp();
  const client = useMemo(() => clientFor(serverId), [clientFor, serverId]);
  const snap = snapshot(serverId);
  const [filter, setFilter] = useState<typeof FILTERS[number]>('Todas');
  const [creating, setCreating] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ScheduledJob | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const agents = snap.agents;
  const agent = chosen ?? agents[0]?.id ?? '';
  const signature = agents.map(a => a.id).join('\0');
  const list = usePoll(async () => snap.reachable === true ? Promise.all(agents.map(async (a) => {
    try {
      return { agent: a.id, data: await client.scheduledJobs(a.id), error: false };
    }
    catch {
      return { agent: a.id, data: null, error: true };
    }
  })) : null, [client, signature, snap.reachable], null);
  const jobs = (list.data ?? []).flatMap(a => a.data?.jobs ?? []).sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.name.localeCompare(b.name));
  const selected = list.data?.find(a => a.agent === agent)?.data;
  const server = servers.find(s => s.id === serverId);
  const action = useJobAction(JSON.stringify([serverId, agent, server?.url, server?.key, server?.deviceId]), snap.reachable === true);
  const filtered = jobs.filter(j => filter === 'Todas' || filter === 'Activas' && j.enabled || filter === 'Pausadas' && jobIsPaused(j) || filter === 'Con fallo' && jobHasFailed(j.lastStatus));
  // The running Tarea rises to the command block; the rows keep the rest.
  const running = filter === 'Todas' || filter === 'Activas' ? filtered.find(jobIsRunning) : undefined;
  const rows = filtered.filter(j => j !== running);
  const now = useNow();
  const toggle = (j: ScheduledJob) => void action.perform(!j.enabled, async (isCurrent) => { await client.jobAction(j.agentId, j.id, j.enabled ? 'pause' : 'resume'); if (!isCurrent()) return; list.reload(); });
  const run = (j: ScheduledJob) => void action.perform(true, async (isCurrent) => { await client.jobAction(j.agentId, j.id, 'run'); if (!isCurrent()) return; setToast('Hermes aceptó ejecutar la tarea.'); list.reload(); });
  const open = (j: ScheduledJob) => router.push({ pathname: '/jobs/[server]/[agent]/[job]', params: { server: serverId, agent: j.agentId, job: j.id } });
  return <View style={{ flex: 1, backgroundColor: K.background }}>
  <StatusBarSpace />
  <RootHeader title={creating ? 'Nueva tarea' : 'Tareas'} right={<>
    <HeaderServerSelector />
    {creating ? null : <IconKey glyph="+" accessibilityLabel="Nueva tarea" disabled={!agents.length || snap.reachable !== true} onPress={() => { setCreating(true); }} />}
  </>} />
  <ServerDown serverId={serverId} />
  <PullToRefresh onRefresh={list.reloaded} contentContainerStyle={{ gap: 12, paddingTop: 8, paddingBottom: 24 }}>
  {action.error ? <View style={{ paddingHorizontal: 16 }}><T c={K.dangerText}>{action.error}</T><Keycap variant="link" label="Reintentar" onPress={list.reload} style={{ alignSelf: 'flex-start' }} /></View> : null}
  {creating ? <View style={{ paddingHorizontal: 16 }}><Form agents={agents} agent={agent} onAgent={setChosen} timezone={selected?.timezone ?? null} editing={false} busy={action.busy} onCancel={() => setCreating(false)} onSave={input => void action.perform(true, async isCurrent => { await client.createJob(agent, input); if (!isCurrent()) return; setCreating(false); list.reload(); })}/></View> : <>
  <M s={9.5} ls={0.06} c={K.inkTertiary} style={{ paddingHorizontal: 16 }}>{server?.name.toUpperCase()} · {jobs.length} TAREAS · ORDEN POR PRÓXIMA</M>
  <View style={{ paddingHorizontal: 12 }}><Segmented options={FILTERS} value={filter} onChange={setFilter} /></View>
  {list.data === null && snap.reachable !== false ? <View style={{ paddingHorizontal: 12 }}><SubjectStateBlock spec={{ kind: 'loading', what: 'tareas' }} /></View> : null}
  {(list.data ?? []).filter(a => a.error).map(a => <View key={a.agent} style={{ paddingHorizontal: 12 }}><SubjectStateBlock spec={{ kind: 'error', verb: `cargar las tareas de ${a.agent}`, onRetry: list.reload }} /></View>)}
  {running ? <CommandBlock job={running} now={now} onPress={() => open(running)} /> : null}
  {rows.length ? <ListBlock>{rows.map(j => <JobRow key={JSON.stringify([j.agentId, j.id])} job={j} now={now} onOpen={() => open(j)} onToggle={() => toggle(j)} onRun={() => setConfirming(j)} />)}</ListBlock> : null}
  {list.data && !filtered.length ? <T {...TYPE.secondary} c={K.inkSecondary} style={{ paddingHorizontal: 16 }}>No hay tareas en este filtro.</T> : null}
  {DEMO ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 12 }}>{DEMO_JOB_SCENARIOS.map(s => <Choice key={s} label={{normal:'Normal',loading:'Cargando',empty:'Vacío',error:'Error', 'history-error':'Error de historial','write-error':'Error al guardar'}[s]} active={false} onPress={() => { setDemoJobScenario(serverId, s); list.reload(); }}/>)}</View> : null}
  </>}
  </PullToRefresh>
  <Sheet visible={confirming !== null} onClose={() => setConfirming(null)} title="¿Ejecutar ahora?" subtitle={confirming?.name}
    aside={<Keycap variant="link" label="Cancelar" onPress={() => setConfirming(null)} />}
    action={<Keycap variant="primary" label="Ejecutar ahora" onPress={() => { const j = confirming; setConfirming(null); if (j) run(j); }} />}>
    <T {...TYPE.secondary} c={K.inkSecondary}>Ejecutar ahora pide huella: Hermes ejecuta la tarea una vez, sin cambiar su horario.</T>
  </Sheet>
  {toast ? <Toast message={toast} onHide={() => setToast(null)} /> : null}
  </View>;
}

const FILTERS = ['Todas', 'Activas', 'Pausadas', 'Con fallo'] as const;

/** The running Tarea (F-6): its next hour and «EJECUTÁNDOSE» on a recessed screen, with the sweep. */
function CommandBlock({ job, now, onPress }: { job: ScheduledJob; now: number; onPress: () => void }) {
  const { K } = usePalette();
  return <Pressable accessibilityRole="button" accessibilityLabel={`${job.name}, ${job.agentId}`} onPress={onPress}
    style={{ marginHorizontal: 12, padding: 10, borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock }}>
    <Screws />
    <RecessedScreen radius={14} style={{ padding: 12, gap: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <M s={9.5} ls={0.08} c={K.onScreen}>PRÓXIMA · {jobWindow(job.nextRunAt, job.timezone, now).toUpperCase()}</M>
        <M s={9.5} ls={0.08} c={K.accent}>EJECUTÁNDOSE</M>
      </View>
      <T {...TYPE.body} c={K.onScreenBright}>{job.name}</T>
      <Sweep tone="orange" />
    </RecessedScreen>
  </Pressable>;
}

/** A Tarea row: → pauses or resumes, ← asks to run now (only while active; Hermes would resume it otherwise). */
function JobRow({ job, now, onOpen, onToggle, onRun }: { job: ScheduledJob; now: number; onOpen: () => void; onToggle: () => void; onRun: () => void }) {
  const { K } = usePalette();
  const failed = job.enabled && jobHasFailed(job.lastStatus);
  return <SwipeRow testID={`job-${job.agentId}-${job.id}`}
    swipeRight={{ label: job.enabled ? 'Pausar' : 'Reanudar', onAction: onToggle }}
    swipeLeft={job.enabled ? { label: 'Ejecutar ahora', onAction: onRun } : undefined}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${job.name}, ${job.agentId}`} onPress={onOpen} style={{ minHeight: 64, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Lamp tone={!job.enabled ? 'off' : failed ? 'red' : 'green'} size={8} />
      <View style={{ flex: 1, gap: 2 }}>
        <T {...TYPE.body} c={K.ink} numberOfLines={1}>{job.name}</T>
        <M s={9.5} ls={0.04} c={failed ? K.dangerText : K.inkTertiary}>{job.schedule} · {!job.enabled ? jobStateLabel(job) : failed ? 'ÚLTIMA FALLÓ' : job.agentId.toUpperCase()}{job.enabled && job.nextRunAt !== null && !job.timezone ? ' · ZONA NO DISPONIBLE' : ''}</M>
      </View>
      <View style={{ minHeight: 28, paddingHorizontal: 8, borderRadius: 8, backgroundColor: K.field, boxShadow: K.shadowField, justifyContent: 'center' }}>
        <M s={11} c={K.ink}>{job.enabled ? jobWindow(job.nextRunAt, job.timezone, now) : '—'}</M>
      </View>
    </Pressable>
  </SwipeRow>;
}
interface JobDetailProps {
  serverId: string;
  agentId: string;
  jobId: string;
}
export function JobDetailScreen(props: JobDetailProps) {
  const { servers } = useApp();
  const server = servers.find(s => s.id === props.serverId);
  const scope = JSON.stringify([props.serverId, props.agentId, props.jobId, server?.url, server?.key, server?.deviceId]);
  return <JobDetailContent key={scope} {...props}/>;
}
function JobDetailContent({ serverId, agentId, jobId }: JobDetailProps) {
  const { K } = usePalette();
  const { clientFor, snapshot, servers } = useApp();
  const client = useMemo(() => clientFor(serverId), [clientFor, serverId]);
  const snap = snapshot(serverId);
  const detail = usePoll(() => client.scheduledJob(agentId, jobId), [client, agentId, jobId]);
  const history = usePoll(() => client.jobHistory(agentId, jobId), [client, agentId, jobId]);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const moreBusy = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const server = servers.find(s => s.id === serverId);
  const action = useJobAction(JSON.stringify([serverId, agentId, jobId, server?.url, server?.key, server?.deviceId]), snap.reachable === true);
  const ret = useReturn();
  const job = detail.data;
  const reload = () => { detail.reload(); history.reload(); };
  async function more() {
    if (moreBusy.current || !history.data?.hasMore) return;
    const isCurrent = action.capture();
    if (!isCurrent()) return;
    const offset = history.data.executions.length;
    moreBusy.current = true;
    setLoadingMore(true);
    try {
      const next = await client.jobHistory(agentId, jobId, offset);
      if (!isCurrent()) return;
      history.setData(previous => !isCurrent() || previous?.executions.length !== offset ? previous
        : { executions: [...previous.executions, ...next.executions], hasMore: next.hasMore });
    }
    catch {
      if (isCurrent()) setNotice('No se pudo cargar más historial. Reintenta.');
    }
    finally { moreBusy.current = false; setLoadingMore(false); }
  }
  return <Frame serverId={serverId} title={editing?'Editar tarea':job?.name ?? 'Tarea programada'} back={ret}>
  <M s={10} c={K.inkTertiary}>{agentId.toUpperCase()} · {server?.name.toUpperCase()}</M>
  {detail.error ? <T c={K.dangerText}>No se pudo consultar la tarea. Reintenta. Puede haberse borrado o el Servidor no responde.</T> : null}
  {!job && !detail.error ? <T>Cargando tarea…</T> : null}
  {job ? <>
      <RecessedScreen radius={18} style={{ padding: 16, gap: 6 }}>
    <M {...TYPE.label} c={K.onScreenLabel}>PRÓXIMA EJECUCIÓN · {jobStateLabel(job)}</M>
    <M s={17} c={K.accent}>{job.enabled ? jobTime(job.nextRunAt, job.timezone) : 'PAUSADA'}</M>
    <M {...TYPE.label} c={K.onScreenLabel}>{job.timezone ?? 'Zona de Hermes no disponible'}</M>
    </RecessedScreen>
      {editing ? <Form key={JSON.stringify([agentId, jobId])} initial={job} timezone={job.timezone} editing busy={action.busy} onCancel={() => setEditing(false)} onSave={input => void action.perform(true, async isCurrent => { const result = await client.editJob(agentId, jobId, input); if (!isCurrent()) return; detail.setData(result); setEditing(false); })}/> : <>
    <View style={{ borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock, padding: 14, gap: 10 }}>
      <M {...TYPE.label} c={K.inkTertiary}>HORARIO</M>
      <T>{jobScheduleLabel(job.schedule)}</T>
      <M s={10}>{job.schedule}</M>
      <M {...TYPE.label} c={K.inkTertiary}>LE PIDE A {agentId.toUpperCase()}</M>
      <T style={{ backgroundColor: K.field, padding: 10, borderRadius: 10 }}>{job.prompt || 'Sin instrucción de texto'}</T>
      <M {...TYPE.label} c={K.inkTertiary}>ENTREGA EN</M>
      <T>{job.deliver==='local'?'Servidor · sin entrega externa':job.deliver}</T>
      {job.skills.length?<T s={12}>Skills: {job.skills.join(', ')}</T>:null}{job.repeat!==null?<T s={12}>Repeticiones: {job.repeat}</T>:null}
      </View>
    <View style={{ borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock, padding: 14, gap: 12 }}>{[['MODELO', job.model], ['DIRECTORIO', job.workdir], ['SCRIPT', job.script]].map(([label, value]) => <View key={label} style={{ flexDirection: 'row', gap: 12 }}>
        <M {...TYPE.label} c={K.inkTertiary} style={{ width: 80 }}>{label}</M>
        <M s={11} style={{ flex: 1 }}>{value ?? (label==='SCRIPT'?'Sin script':label==='MODELO'?'Predeterminado del Agente':'Predeterminado de Hermes')}</M>
        </View>)}<M {...TYPE.label} c={K.inkTertiary}>SE CAMBIAN EN EL SERVIDOR</M>
      </View>
    <T s={12} c={K.inkSecondary}>{job.enabled ? 'Ejecutar ahora pide huella: Hermes puede reanudar la tarea.' : 'Hermes reanuda al ejecutar: reanuda primero con huella.'}</T>
    <View style={{ flexDirection: 'row', gap: 6 }}>
      <Button compact label="Ejecutar ahora" orange disabled={action.busy || !!detail.error || !job.enabled} onPress={() => void action.perform(true, async isCurrent => { const result = await client.jobAction(agentId, jobId, 'run'); if (!isCurrent()) return; detail.setData(result); setNotice('Hermes aceptó ejecutar la tarea. Consulta el historial para ver el resultado.'); reload(); })}/>
    <Button compact label={job.enabled ? 'Pausar' : 'Reanudar'} disabled={action.busy || !!detail.error} onPress={() => void action.perform(!job.enabled, async isCurrent => { const result = await client.jobAction(agentId, jobId, job.enabled ? 'pause' : 'resume'); if (!isCurrent()) return; detail.setData(result); })}/>
      <Button compact label="Editar" disabled={action.busy || !!detail.error} onPress={() => setEditing(true)}/>
      <Button compact label="Borrar" disabled={action.busy || !!detail.error} onPress={() => setDeleting(true)}/>
      </View>
      </>}
      {deleting ? <View style={{ borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock, padding: 16, gap: 12 }}>
      <T w="700">¿Borrar esta tarea?</T>
      <T>Se eliminará «{job.name}» de {agentId}. Ya no se ejecutará automáticamente.</T>
      <Button label="Confirmar borrado" disabled={action.busy} onPress={() => void action.perform(false, async isCurrent => { await client.deleteJob(agentId, jobId); if (!isCurrent()) return; ret?.go(); })}/>
      <Button label="Conservar tarea" onPress={() => setDeleting(false)}/>
      </View> : null}
  </> : null}
  {action.error ? <T c={K.dangerText}>{action.error}</T> : null}{notice ? <T>{notice}</T> : null}
  <M s={10} c={K.inkTertiary}>HISTORIAL</M>{history.error ? <T c={K.dangerText}>El historial no está disponible en el Servidor.</T> : history.data ? <History data={history.data} timezone={job?.timezone ?? null}/> : <T>Cargando historial…</T>}
  {history.data?.hasMore ? <Button label="Cargar más historial" disabled={loadingMore} onPress={() => void more()}/> : null}<Button label="Actualizar" onPress={reload}/>
  </Frame>;
}
function History({ data, timezone }: {
  data: JobHistory;
  timezone: string | null;
}) {
  const { K } = usePalette();
  const labels = { claimed: 'RECLAMADA', running: 'EN CURSO', completed: 'COMPLETADA', failed: 'FALLÓ', unknown: 'DESCONOCIDO' };
  return <View style={{ borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock, padding: 14, gap: 14 }}>{data.executions.length === 0 ? <T>Sin ejecuciones registradas.</T> : data.executions.map(e => <View key={e.id} style={{ gap: 5 }}>
    <M s={11}>{jobTime(Date.parse(e.claimedAt), timezone)} · {labels[e.status]}</M>{e.startedAt && e.finishedAt ? <M {...TYPE.label}>{Math.max(0, Math.round((Date.parse(e.finishedAt) - Date.parse(e.startedAt)) / 1000))} s</M> : null}{e.deliveryOutcome ? <T s={12}>Entrega: {({delivered:'entregada',failed:'falló',unverified:'no verificada'} as Record<string,string>)[e.deliveryOutcome]??e.deliveryOutcome}</T> : null}{e.scheduledInstant ? <T s={12}>Programada: {jobTime(Date.parse(e.scheduledInstant), timezone)}</T> : null}</View>)}</View>;
}
