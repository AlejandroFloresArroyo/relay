import { useState, type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { activityGauge, gaugeReading } from '@/core/machinery';
import { useNow } from '@/state/app';
import { StillMotion } from '@/state/motion';
import { usePalette } from '@/theme/ThemeProvider';
import { RADIUS, TEXT_GLOW, TYPE } from '@/theme/tokens';
import { StatusBarSpace } from '@/ui/chrome';
import { PullToRefresh, SwipeRow } from '@/ui/gestures';
import { DetailHeader, RootHeader, ServerSwitch, TailnetPill, ToolHeader } from '@/ui/headers';
import { IconKey, Keycap, ListBlock, ListRow, SectionHeader, Segmented } from '@/ui/kit';
import { EngravedRule, HoldKey, Lights, Needle, Odometer, RecessedScreen, Screws, Sweep, VoiceBox } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';
import { Sheet, Toast } from '@/ui/sheet';
import { StateRow, SubjectStateBlock, type StateSpec } from '@/ui/states';

/**
 * Demo only: every piece of S-15 «Maquinaria y luz», moving and as «reducir movimiento» leaves it,
 * and the 3.1 base components in each of their states. `?sheet=1` opens with the TAILNET sheet up.
 */
export function MachineryDemoScreen() {
  const { K } = usePalette();
  const now = useNow(1000);
  // A step that runs 70 s and starts over: the ACTIVIDAD needle crosses its red zone at 45 s.
  const step = Math.floor(now / 1000) % 70;
  // A fixed reading (CPU) that changes every 4 s.
  const cpu = [18, 42, 67, 91][Math.floor(now / 4000) % 4];
  const uptime = 6 * 86400 + 4 * 3600 + 12 * 60 + Math.floor(now / 1000) % 3600;
  const [held, setHeld] = useState({ approve: 0, pause: 0 });
  return <View style={{ flex: 1, backgroundColor: K.background }}><StatusBarSpace /><ScrollView contentContainerStyle={{ paddingBottom: 24 }}><View style={{ padding: 12, gap: 12, flexDirection: 'row', flexWrap: 'wrap' }}>
    <T {...TYPE.title} c={K.ink} style={{ width: '100%' }}>Maquinaria y luz</T>
    <T {...TYPE.secondary} c={K.inkSecondary} style={{ width: '100%' }}>Demostración de S-15 con datos sintéticos. Cada pieza en movimiento y como la deja «reducir movimiento».</T>
    <Sample label="1 · FOQUITOS ANALÓGICOS" twice>
      <RecessedScreen radius={14} style={{ padding: 16, gap: 14 }}><Lights tone="orange" /><Lights tone="red" /></RecessedScreen>
    </Sample>
    <Sample label="2 · BARRIDO" twice>
      <RecessedScreen radius={14} style={{ padding: 14, gap: 12 }}><Sweep tone="orange" /><Sweep tone="red" /></RecessedScreen>
    </Sample>
    <Sample label="3 · CAJA DE VOZ" twice>
      <RecessedScreen radius={14} style={{ padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <VoiceBox onScreen /><T {...TYPE.secondary} c={K.onScreen}>está escribiendo…</T>
      </RecessedScreen>
    </Sample>
    <Sample label="4 · AGUJA" twice>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Dial label="ACTIVIDAD" value={`${step.toFixed(1)} S`}><Needle reading={activityGauge(step)} live /></Dial>
        <Dial label="CPU" value={`${cpu} %`}><Needle reading={gaugeReading(cpu, { max: 100, redFrom: 80 })} /></Dial>
      </View>
    </Sample>
    <Sample label="5 · BLOQUE DE MANDO (TORNILLOS)">
      <View style={{ height: 64, borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock }}><Screws /></View>
    </Sample>
    <Sample label="6 · REGLA GRABADA">
      <EngravedRule />
      <RecessedScreen style={{ padding: 12 }}><EngravedRule onScreen /></RecessedScreen>
    </Sample>
    <Sample label="7 · CUENTAKILÓMETROS" twice>
      <RecessedScreen style={{ padding: 10, alignSelf: 'flex-start' }}><Odometer value={odometerUptime(uptime)} /></RecessedScreen>
    </Sample>
    <Sample label="8 · TECLA QUE SE MANTIENE">
      <HoldKey accessibilityLabel="Aprobar, mantén 1 segundo" onComplete={() => setHeld(count => ({ ...count, approve: count.approve + 1 }))}>
        <T {...TYPE.body} c={K.ink}>Aprobar · mantén</T>
      </HoldKey>
      <HoldKey accessibilityLabel="Pausa general, mantén 1 segundo" stepped onComplete={() => setHeld(count => ({ ...count, pause: count.pause + 1 }))}>
        <T {...TYPE.body} c={K.ink}>Pausa general · pasos de 50 ms</T>
      </HoldKey>
      <M {...TYPE.data} c={K.inkSecondary}>COMPLETADAS · APROBAR {held.approve} · PAUSA {held.pause}</M>
    </Sample>
    <Sample label="9 · PANTALLA EMPOTRADA">
      <RecessedScreen style={{ padding: 14 }}><M {...TYPE.data} c={K.onScreen}>Pantalla con scanlines</M></RecessedScreen>
      <RecessedScreen rim style={{ padding: 14 }}>
        <M {...TYPE.reading} c={K.accent} glow={TEXT_GLOW.accent}>BORDE LUMINOSO</M>
      </RecessedScreen>
    </Sample>
  </View><BaseComponentSamples /></ScrollView></View>;
}

const pass = () => {};
const STATES: [string, StateSpec][] = [
  ['CARGANDO…', { kind: 'loading', what: 'tablero', phrase: 'Relay lee las Tarjetas de atlas.' }],
  ['VACÍO', { kind: 'empty', title: 'SIN APROBACIONES PENDIENTES', phrase: 'Aquí aparecen cuando un Agente pida permiso.' }],
  ['ERROR', { kind: 'error', verb: 'cargar el Tablero', onRetry: pass }],
  ['SIN RESPUESTA', { kind: 'unreachable', phrase: 'atlas no contesta; no se pudo leer SOUL.md. Relay lo reintenta solo.', onRetry: pass }],
  ['SIN CONTROL', { kind: 'noControl', phrase: 'Ahora no hay control sobre atlas. Tus terminales siguen ahí.', action: { label: 'Volver a entrar con huella', onPress: pass } }],
  ['NO DISPONIBLE', { kind: 'unavailable', phrase: 'El Puente de atlas no ofrece Trabajo.' }],
  ['NO DISPONIBLE · OTRA CAUSA', { kind: 'unavailable', title: 'MÓDULO APK NO DISPONIBLE', phrase: 'Necesitas Android 12 o posterior.' }],
  ['SIN ACCESO', { kind: 'noAccess', phrase: 'Este dispositivo perdió el acceso a atlas.', action: { label: 'Emparejar de nuevo', onPress: pass } }],
];

/** The 3.1 base components on the screen's own background, as a screen would place them. */
function BaseComponentSamples() {
  const { K } = usePalette();
  const { sheet: sheetParam } = useLocalSearchParams<{ sheet?: string }>();
  const [sheet, setSheet] = useState(sheetParam === '1');
  const [toast, setToast] = useState<string | null>(null);
  const [period, setPeriod] = useState<'Hoy' | 'Semana' | 'Mes'>('Semana');
  const [view, setView] = useState<'Agentes' | 'Actividad'>('Agentes');
  const [panels, setPanels] = useState<'Un panel' | 'Dos paneles'>('Dos paneles');
  const [reloads, setReloads] = useState(0);
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 24, paddingTop: 12 }}>
    <T {...TYPE.title} c={K.ink} style={{ width: '100%', paddingHorizontal: 16 }}>Componentes base</T>
    <Group label="10 · ENCABEZADO A">
      <RootHeader title="Agentes" right={<><TailnetPill led="green" open={sheet} onPress={() => setSheet(true)} /><IconKey round glyph="+" accessibilityLabel="Agregar Agente" onPress={pass} /></>} />
      <RootHeader title="Tablero" right={<><ServerSwitch name="atlas" led="green" onPress={pass} /><IconKey glyph="⋯" accessibilityLabel="Más acciones" onPress={pass} /></>} />
      <RootHeader title="Agentes" right={<TailnetPill led="green" open onPress={pass} />} />
    </Group>
    <Group label="11 · ENCABEZADO B Y DE HERRAMIENTA">
      <DetailHeader back="dev" onBack={pass} title="Personalidad" subtitle="DEV · SOUL.md" />
      <DetailHeader back="Agentes" onBack={pass} right={<IconKey glyph=">_" accessibilityLabel="Terminal" onPress={pass} />} identity={{ name: 'dev', line: 'ATLAS · QWEN3-CODER-480B', state: 'busy' }} />
      <DetailHeader back="atlas" onBack={pass} right={<View style={{ minHeight: 24, paddingHorizontal: 8, borderRadius: 8, backgroundColor: K.field, justifyContent: 'center' }}><M {...TYPE.label} c={K.accentText}>≈ ESTIMADO</M></View>} title="Uso y costo" subtitle="12–14 OCT · CÁLCULO GUARDADO 14 OCT 12:00 (HORA DE ATLAS)" />
      <ToolHeader back="Agentes" onBack={pass} server="atlas" />
    </Group>
    <Group label="12 · TECLAS">
      <View style={{ paddingHorizontal: 12, gap: 8 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Keycap label="Reintentar" onPress={pass} style={{ flex: 1 }} />
          <Keycap variant="primary" label="Abrir Tailscale" onPress={pass} style={{ flex: 1 }} />
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Keycap variant="dark" label="dev" onPress={pass} style={{ flex: 1 }} />
          <Keycap variant="danger" label="Detener" onPress={pass} style={{ flex: 1 }} />
          <Keycap label="Iniciar" disabled onPress={pass} style={{ flex: 1 }} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Keycap variant="link" label="Reintentar" onPress={pass} />
          <View style={{ flex: 1 }} />
          <IconKey glyph=">_" accessibilityLabel="Terminal" onPress={pass} />
          <IconKey glyph="⋯" accessibilityLabel="Más acciones" onPress={pass} />
          <IconKey round glyph="+" accessibilityLabel="Agregar" onPress={pass} />
        </View>
      </View>
    </Group>
    <Group label="13 · HOJA Y TOAST">
      <View style={{ paddingHorizontal: 12, gap: 8 }}>
        <Keycap label="Abrir la hoja TAILNET" onPress={() => setSheet(true)} />
        <Keycap label="Mostrar un toast" onPress={() => setToast('Comando copiado')} />
        <View style={{ height: 60 }}><Toast message="Aprobada · dev en atlas" onHide={pass} bottom={8} /></View>
      </View>
    </Group>
    <Group label="14 · ESTADOS · BLOQUE GRANDE">
      {STATES.map(([label, spec]) => <View key={label} style={{ paddingHorizontal: 12, gap: 6 }}>
        <M {...TYPE.label} c={K.inkTertiary}>{label}</M>
        <SubjectStateBlock spec={spec} />
      </View>)}
    </Group>
    <Group label="15 · ESTADOS · FILA COMPACTA">
      <StateRow name="homelab" kind="unreachable" onRetry={pass} rows={['ops']} />
      <StateRow name="homelab" kind="unreachable" onRetry={pass} />
      <StateRow name="atlas" kind="noAccess" action={{ label: 'Emparejar de nuevo', onPress: pass }} />
      <StateRow name="atlas" kind="unavailable" />
      <StateRow name="atlas" kind="loading" />
    </Group>
    <Group label="16 · RECARGAR Y FILA DESLIZABLE">
      <View style={{ height: 200, marginHorizontal: 12, borderRadius: RADIUS.block, backgroundColor: K.field, boxShadow: K.shadowField, overflow: 'hidden' }}>
        <PullToRefresh onRefresh={() => new Promise<void>(resolve => { setTimeout(() => { setReloads(count => count + 1); resolve(); }, 2500); })} contentContainerStyle={{ padding: 12 }}>
          <T {...TYPE.secondary} c={K.inkSecondary}>Arrastra hacia abajo más de 60 px y suelta. Recargas: {reloads}.</T>
        </PullToRefresh>
      </View>
      <ListBlock>
        <SwipeRow testID="swipe-dev" swipeRight={{ label: 'Abrir chat', onAction: () => setToast('→ Abrir chat · dev') }}>
          <ListRow title="dev" description="Agente → abre la Conversación" />
        </SwipeRow>
        <SwipeRow testID="swipe-job" swipeRight={{ label: 'Pausar', onAction: () => setToast('→ Pausar · limpieza diaria') }} swipeLeft={{ label: 'Ejecutar ahora', onAction: () => setToast('← Ejecutar ahora pide confirmación') }}>
          <ListRow title="limpieza diaria" description="Tarea → pausa · ← ejecutar ahora" />
        </SwipeRow>
      </ListBlock>
    </Group>
    <Group label="17 · FILAS DE BLOQUE Y CABECERA DE SECCIÓN">
      <SectionHeader title="ENCONTRADOS POR ATLAS" action={{ label: 'Buscar otra vez', onPress: pass }} />
      <ListBlock>
        <ListRow plate="TERM" title="Herramientas" value="PIDE HUELLA" chevron onPress={pass} />
        <ListRow plate="CRON" title="Tareas programadas" value="1 FALLÓ" valueTone="danger" chevron onPress={pass} />
        <ListRow plate="USO" title="Uso y costo" value="≈ $1.08 SEM." chevron onPress={pass} />
      </ListBlock>
      <SectionHeader title="PENDIENTES · 1" />
      <ListBlock>
        <ListRow plate="SOUL" title="Personalidad" meta="SOUL.md" chevron onPress={pass} />
        <ListRow title="Aplicar preset SOUL" chevron disabled onPress={pass} />
      </ListBlock>
    </Group>
    <Group label="18 · SEGMENTADO">
      <View style={{ paddingHorizontal: 12, gap: 12 }}>
        <Segmented options={['Agentes', 'Actividad'] as const} value={view} onChange={setView} />
        <Segmented options={['Hoy', 'Semana', 'Mes'] as const} value={period} onChange={setPeriod} />
        <Segmented options={['Un panel', 'Dos paneles'] as const} value={panels} onChange={setPanels} />
      </View>
    </Group>
    <Sheet visible={sheet} onClose={() => setSheet(false)} title="Red privada" subtitle="TAILSCALE · TAILNET-7F2C"
      action={<><Keycap label="Reintentar" onPress={pass} style={{ flex: 1 }} /><Keycap variant="primary" label="Abrir Tailscale" onPress={pass} style={{ flex: 1 }} /></>}>
      <RecessedScreen radius={16} style={{ padding: 16 }}>
        <M s={13} w="600" ls={0.08} c={K.okTextOnScreen} glow={TEXT_GLOW.ok}>CONECTADA</M>
        <T {...TYPE.secondary} c={K.onScreen}>Este teléfono está en la tailnet.</T>
      </RecessedScreen>
      <StateRow name="homelab" kind="unreachable" onRetry={pass} />
      <T {...TYPE.secondary} c={K.inkSecondary}>Si un Servidor no contesta, revisa Tailscale en este teléfono y que el Puente esté corriendo en el Servidor.</T>
    </Sheet>
    {toast ? <Toast key={toast} message={toast} onHide={() => setToast(null)} /> : null}
  </View>;
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return <View style={{ flexGrow: 1, flexBasis: 360, maxWidth: 520, gap: 12 }}>
    <SectionHeader title={label} />
    {children}
  </View>;
}

/** One S-15 piece on its block; `twice` shows it moving and held at rest, side by side where they fit. */
function Sample({ label, twice = false, children }: { label: string; twice?: boolean; children: ReactNode }) {
  const { K } = usePalette();
  return <View style={{ flexGrow: 1, flexBasis: 340, borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock, padding: 16, gap: 10 }}>
    <M {...TYPE.label} c={K.inkTertiary}>{label}</M>
    {twice ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
      <View style={{ flexGrow: 1, flexBasis: 260, gap: 8 }}><M {...TYPE.label} c={K.inkTertiary}>EN MOVIMIENTO</M>{children}</View>
      <View style={{ flexGrow: 1, flexBasis: 260, gap: 8 }}><M {...TYPE.label} c={K.inkTertiary}>REDUCIR MOVIMIENTO</M><StillMotion value>{children}</StillMotion></View>
    </View> : children}
  </View>;
}

function Dial({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  const { K } = usePalette();
  return <View style={{ gap: 4 }}>
    <RecessedScreen radius={14} style={{ width: 112, height: 80, overflow: 'hidden' }}>{children}</RecessedScreen>
    <M {...TYPE.label} c={K.inkTertiary}>{label} · {value}</M>
  </View>;
}

/** Uptime as the canvas writes it: days, «D», hours and minutes («6D04:12»), with seconds so the demo rolls. */
function odometerUptime(seconds: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(seconds / 86400)}D${pad(Math.floor(seconds / 3600) % 24)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}
