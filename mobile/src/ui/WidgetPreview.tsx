import { Pressable, View } from 'react-native';
import type { WidgetView } from '@/core/widget';
import { RADIUS, TEXT_GLOW, TYPE } from '@/theme/tokens';
import { usePalette } from '@/theme/ThemeProvider';
import { Keycap, Lamp } from '@/ui/kit';
import { RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';

/** «22:22» for a reading of today, «05/10 22:22» for an older one; the native widget formats the same way. */
function readingTime(at: number): string {
  const day = (date: Date) => date.toDateString();
  const today = day(new Date(at)) === day(new Date());
  return new Date(at).toLocaleString('es-MX', today ? { hour: '2-digit', minute: '2-digit', hour12: false } : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** App-only preview of the native Instrumento RemoteViews (RelayWidgetProvider); same texts and states. */
export function WidgetPreview({ view, wide, onOpen }: { view: WidgetView; wide: boolean; onOpen: () => void }) {
  const { K } = usePalette();
  const current = view.state === 'current';
  const time = view.observedAt == null ? null : readingTime(view.observedAt);
  const date = time == null ? 'SIN DATOS VISIBLES' : current ? `LECTURA ${time}` : `ÚLTIMO DATO ${time}`;
  const states = { on: 'EN LÍNEA', busy: 'TRABAJANDO', err: 'ERROR', off: 'INACTIVO' };
  const tones = { on: 'green', busy: 'orange', err: 'red', off: 'off' } as const;
  const inks = { on: K.okText, busy: K.accentText, err: K.dangerText, off: K.inkTertiary };
  const server = view.label.toUpperCase();
  const agents = <View style={{ flex: wide ? 1 : undefined, padding: wide ? 16 : 12, gap: wide ? 14 : 8, flexDirection: wide ? 'column' : 'row', justifyContent: 'center', alignItems: wide ? undefined : 'center', borderRadius: 24, backgroundColor: K.block, boxShadow: K.shadowBlock }}>
    {view.agents.length ? view.agents.map((agent, index) => <View key={index} style={{ flex: wide ? undefined : 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Lamp tone={current ? tones[agent.state] : 'off'} />
      <View style={{ flex: 1 }}>
        <T s={wide ? 15 : 14} w="700" c={K.ink} numberOfLines={1}>{agent.label}</T>
        {wide ? <M s={9.5} c={current ? inks[agent.state] : K.inkTertiary}>{current ? `${server} · ${states[agent.state]}` : server}</M> : null}
      </View>
    </View>) : <T {...TYPE.secondary} c={K.inkSecondary}>{view.state === 'neutral' ? 'Sin datos del Servidor' : 'Sin Agentes'}</T>}
  </View>;
  const panel = <RecessedScreen radius={24} style={{ width: wide ? 163 : undefined, flex: wide ? undefined : 1, padding: 16, gap: 8 }}>
    <M s={9.5} ls={0.08} c={K.onScreenLabel}>{current ? 'APROBACIONES' : view.state === 'stale' ? 'SIN LECTURA RECIENTE' : 'ABRE RELAY'}</M>
    <M s={48} w="600" c={current ? K.accent : K.onScreen} glow={current ? TEXT_GLOW.accent : undefined}>{current ? view.count : '—'}</M>
    <M s={9.5} c={K.onScreen}>{date}</M>
    {current ? null : <T {...TYPE.secondary} c={K.onScreen}>Abre Relay para actualizar.</T>}
    {wide ? <Keycap variant="primary" label={current ? 'Revisar' : 'Abrir Relay'} onPress={onOpen} style={{ borderRadius: RADIUS.key }} /> : null}
  </RecessedScreen>;
  return <Pressable onPress={wide ? undefined : onOpen} accessibilityRole={wide ? undefined : 'button'} accessibilityLabel={wide ? 'Widget amplio' : 'Widget compacto'} style={{ flexDirection: wide ? 'row' : 'column', gap: 12, padding: 12, borderRadius: 28, backgroundColor: K.background, width: wide ? 354 : 190 }}>
    {wide ? <>{agents}{panel}</> : <>{panel}{agents}</>}
  </Pressable>;
}
