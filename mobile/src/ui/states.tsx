// One anatomy for every state (D-ES): a mono title, one phrase and a single action. The types
// impose the unified texts: «No se pudo <verbo>. Reintenta.», «Reintentar» as the only retry label,
// loading ending in «…», «SIN RESPUESTA · <qué hacer>» and «NO DISPONIBLE · ACTUALIZA EL PUENTE».
import { View } from 'react-native';

import { usePalette } from '@/theme/ThemeProvider';
import { TEXT_GLOW, TYPE } from '@/theme/tokens';
import { Keycap, Lamp, ListBlock } from './kit';
import { RecessedScreen } from './machinery';
import { M, T } from './primitives';

export type StateKind = 'loading' | 'empty' | 'error' | 'unreachable' | 'noControl' | 'unavailable' | 'noAccess';
/** The ways out the D-ES sheet names. Retry is not one: it comes only through `onRetry`, as «Reintentar». */
export type StateActionLabel = 'Escanear código' | 'Agregar Servidor' | 'Emparejar de nuevo' | 'Volver a entrar con huella';
export type StateAction = { label: StateActionLabel; onPress: () => void };

/** What a screen-wide state says. Retry is always `onRetry`, so its key always reads «Reintentar». */
export type StateSpec =
  /** «CARGANDO <WHAT>…» */
  | { kind: 'loading'; what: string; phrase?: string }
  | { kind: 'empty'; title: string; phrase: string; action?: StateAction }
  /** The generic error: «ERROR», «No se pudo <verb>. Reintenta.» and «Reintentar». */
  | { kind: 'error'; verb: string; onRetry: () => void }
  /** A named error with its own way out («CÓDIGO CADUCADO» · «Escanear código»), or «Reintentar» through `onRetry`. */
  | { kind: 'error'; title: string; phrase: string; action?: StateAction; onRetry?: () => void }
  /** «SIN RESPUESTA · <todo>», `todo` in caps, «REVISA TAILNET» by default; `title` when a diagnosis names the cause. */
  | { kind: 'unreachable'; todo?: string; title?: string; phrase: string; onRetry: () => void }
  | { kind: 'noControl' | 'noAccess'; phrase: string; action?: StateAction }
  /** «NO DISPONIBLE · ACTUALIZA EL PUENTE», unless the cause is not the Puente («MÓDULO APK NO DISPONIBLE»). */
  | { kind: 'unavailable'; title?: string; phrase: string };

type Tone = 'red' | 'orange' | 'off';
const KINDS: Record<StateKind, { label: string; tone: Tone }> = {
  loading: { label: 'CARGANDO…', tone: 'orange' },
  empty: { label: 'VACÍO', tone: 'off' },
  error: { label: 'ERROR', tone: 'red' },
  unreachable: { label: 'SIN RESPUESTA', tone: 'red' },
  noControl: { label: 'SIN CONTROL', tone: 'off' },
  unavailable: { label: 'NO DISPONIBLE', tone: 'off' },
  noAccess: { label: 'SIN ACCESO', tone: 'red' },
};
const RETRY = 'Reintentar';

type Way = { label: string; onPress: () => void };
function stateText(spec: StateSpec): { title: string; phrase?: string; action?: Way; retry?: Way } {
  switch (spec.kind) {
    case 'loading': return { title: `CARGANDO ${spec.what.toUpperCase()}…`, phrase: spec.phrase };
    case 'error': return 'verb' in spec ? { title: 'ERROR', phrase: `No se pudo ${spec.verb}. Reintenta.`, action: { label: RETRY, onPress: spec.onRetry } }
      : { title: spec.title, phrase: spec.phrase, action: spec.action, retry: spec.onRetry && { label: RETRY, onPress: spec.onRetry } };
    case 'unreachable': return { title: spec.title ?? `SIN RESPUESTA · ${spec.todo ?? 'REVISA TAILNET'}`, phrase: spec.phrase, action: { label: RETRY, onPress: spec.onRetry } };
    case 'unavailable': return { title: spec.title ?? 'NO DISPONIBLE · ACTUALIZA EL PUENTE', phrase: spec.phrase };
    case 'empty': return spec;
    default: return { title: KINDS[spec.kind].label, phrase: spec.phrase, action: spec.action };
  }
}

/**
 * Estado de pantalla, the big block (D-11_D-12): a recessed screen with three LEDs, the title, the
 * phrase and the action. Only for a state of the screen's own subject (a Tablero with no Tarjetas,
 * a Servidor's ficha). A Servidor SIN RESPUESTA is the subject only in its ficha and in the TAILNET
 * sheet; anywhere else the same Servidor's state is a `StateRow`.
 */
export function SubjectStateBlock({ spec }: { spec: StateSpec }) {
  const { K } = usePalette();
  const { title, phrase, action, retry } = stateText(spec);
  const tone = KINDS[spec.kind].tone;
  const look = {
    red: { ink: K.dangerTextOnScreen, glow: TEXT_GLOW.danger, rim: `${K.shadowScreen}, 0px 0px 0px 1px rgba(229,83,61,0.3), 0px 0px 16px rgba(229,83,61,0.14)` },
    orange: { ink: K.accent, glow: TEXT_GLOW.accent, rim: `${K.shadowScreen}, ${K.shadowAccentRim}` },
    off: { ink: K.onScreenBright, glow: undefined, rim: K.shadowScreen },
  }[tone];
  return <RecessedScreen radius={20} style={{ padding: 24, gap: 12, boxShadow: look.rim }}>
    <View style={{ flexDirection: 'row', gap: 6 }}>
      <Lamp size={9} tone="off" onScreen />
      <Lamp size={9} tone={tone === 'orange' ? 'orange' : 'off'} onScreen />
      <Lamp size={9} tone={tone === 'red' ? 'red' : 'off'} onScreen />
    </View>
    <M s={13} w="600" ls={0.08} c={look.ink} glow={look.glow} accessibilityRole="header">{title}</M>
    {phrase ? <T s={15} lh={1.45} c={K.onScreen}>{phrase}</T> : null}
    {action || retry ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {[action, retry].map(way => way ? <Keycap key={way.label} variant="screen" label={way.label} onPress={way.onPress} /> : null)}
    </View> : null}
  </RecessedScreen>;
}

/**
 * Estado en línea, the compact row: what a list shows for a Servidor in this state. Alone (D-02)
 * it reads «<SERVIDOR> · <ESTADO>», `label` naming a diagnosed cause; with `rows` (F-1) it heads the Servidor's group and dims each
 * row beside the action. `action` names the way out and `onRetry` adds «Reintentar».
 */
export function StateRow({ name, kind, label, onRetry, action, rows }: { name: string; kind: StateKind; label?: string; onRetry?: () => void; action?: StateAction; rows?: string[] }) {
  const { K } = usePalette();
  const tone = KINDS[kind].tone;
  label ??= KINDS[kind].label;
  const ink = { red: K.dangerText, orange: K.accentText, off: K.inkTertiary }[tone];
  const key = <>
    {action ? <Keycap variant="link" label={action.label} onPress={action.onPress} /> : null}
    {onRetry ? <Keycap variant="link" label={RETRY} onPress={onRetry} /> : null}
  </>;
  if (!rows) {
    return <View style={{ marginHorizontal: 12, minHeight: 48, paddingHorizontal: 12, borderRadius: 16, backgroundColor: K.block, boxShadow: K.shadowBlock, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Lamp tone={tone} />
      <M {...TYPE.label} ls={0.06} c={ink} style={{ flex: 1 }}>{name.toUpperCase()} · {label}</M>
      {key}
    </View>;
  }
  return <View style={{ gap: 12 }}>
    <View style={{ paddingHorizontal: 16, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8 }}>
      <Lamp tone={tone} />
      <M {...TYPE.label} ls={0.06} c={K.ink}>{name.toUpperCase()}</M>
      <M {...TYPE.label} ls={0.06} c={ink} style={{ marginLeft: 'auto' }}>{label}</M>
    </View>
    <ListBlock>
      {rows.map(row => <View key={row} style={{ minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <T s={15} w="700" c={K.ink} style={{ flex: 1, opacity: 0.5 }}>{row}</T>
        {key}
      </View>)}
    </ListBlock>
  </View>;
}
