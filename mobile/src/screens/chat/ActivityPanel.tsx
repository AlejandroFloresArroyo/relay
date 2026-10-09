// ACTIVIDAD as a command block (F-2) in the thread, and fixed beside it on a tablet (T-1).
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { activityGauge, runningStepSeconds } from '@/core/machinery';
import type { ChatBlock } from '@/core/transcript';
import { usePalette } from '@/theme/ThemeProvider';
import { TEXT_GLOW } from '@/theme/tokens';
import { Keycap } from '@/ui/kit';
import { EngravedRule, Needle, RecessedScreen, Screws, Sweep } from '@/ui/machinery';
import { M } from '@/ui/primitives';

type Activity = Extract<ChatBlock, { kind: 'activity' }>;
const ACCENT_GLOW = TEXT_GLOW.accent;

/** The CARGA needle: the seconds of the step in progress on the fixed 0–60 s scale, at 0 with none. */
function Load({ block, now }: { block: Activity; now: number }) {
  const seconds = runningStepSeconds(block.steps, now);
  return <View testID="aguja-carga" accessible accessibilityLabel={`Carga: ${seconds === null ? 'sin paso en curso' : `${Math.floor(seconds)} s`}`}>
    <Needle reading={activityGauge(seconds)} live={seconds !== null} />
  </View>;
}

/** Barrido: orange during the Turno, red while a step waits for a Decisión; a still track otherwise. */
function TurnSweep({ block }: { block: Activity }) {
  const { K } = usePalette();
  if (!block.running) return <View style={{ height: 6, borderRadius: 3, backgroundColor: K.sweepTrackAccent }} />;
  return <Sweep tone={block.steps.some((s) => s.status === 'waiting') ? 'red' : 'orange'} />;
}

function Steps({ block, onWaitingPress }: { block: Activity; onWaitingPress: () => void }) {
  const { K } = usePalette();
  return <>{block.steps.map((s) => {
    const waiting = s.status === 'waiting';
    // «Que venza no es una avería» (D-09): only a VENCIDA row keeps neutral ink.
    const ink = waiting ? K.accent : s.status === 'error' && s.outcome !== 'VENCIDA' ? K.dangerTextOnScreen : K.onScreen;
    const glow = waiting ? ACCENT_GLOW : undefined;
    const row = <View style={{ gap: 2 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <M s={11} lh={1.5} c={ink} glow={glow} numberOfLines={1} style={{ flexShrink: 1 }}>{s.label}</M>
        <M s={11} lh={1.5} c={waiting || s.outcome ? ink : K.onScreen} glow={glow}>
          {waiting ? 'ESPERA' : s.status === 'running' ? '…' : s.outcome ?? (s.status === 'error' && s.seconds == null ? 'FALLÓ' : (s.seconds ?? 0).toFixed(1))}
        </M>
      </View>
    </View>;
    return waiting ? <Pressable key={s.id} accessibilityRole="button" onPress={onWaitingPress}>{row}</Pressable> : <View key={s.id}>{row}</View>;
  })}</>;
}

/** In the thread: needle and readout side by side, the steps below, closed by an engraved rule. */
export function ActivityCommand({ block, now, onWaitingPress }: { block: Activity; now: number; onWaitingPress: () => void }) {
  const { K } = usePalette();
  // Open while it works or is short; a long finished Turno starts folded.
  const [open, setOpen] = useState(block.running || block.steps.length <= 6);
  return <View style={{ padding: 10, gap: 8, borderRadius: 20, backgroundColor: K.block, boxShadow: K.shadowBlock }}>
    <Screws />
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <RecessedScreen radius={14} style={{ width: 112, height: 80, overflow: 'hidden' }}>
        <Load block={block} now={now} />
        <M s={9.5} c={K.onScreenLabel} style={{ position: 'absolute', left: 8, bottom: 6 }}>CARGA</M>
      </RecessedScreen>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((o) => !o)} style={{ flex: 1 }}>
        <RecessedScreen radius={14} style={{ flex: 1, minHeight: 80, paddingVertical: 10, paddingHorizontal: 12, gap: 6, justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <M s={9.5} ls={0.08} c={K.onScreenLabel}>ACTIVIDAD · {block.steps.length}</M>
            <M s={9.5} c={K.onScreenLabel}>{open ? '−' : '+'}</M>
          </View>
          <M s={20} w="600" c={K.accent} glow={ACCENT_GLOW}>{block.totalSeconds.toFixed(1)} S</M>
          <TurnSweep block={block} />
        </RecessedScreen>
      </Pressable>
    </View>
    {open ? <RecessedScreen radius={14} style={{ paddingVertical: 10, paddingHorizontal: 12, gap: 2 }}>
      <Steps block={block} onWaitingPress={onWaitingPress} />
    </RecessedScreen> : null}
    <EngravedRule />
  </View>;
}

/** ACTIVIDAD DEL TURNO on a tablet: fixed on the right, with the key to the Aprobación while one waits. */
export function TurnActivityPanel({ block, now, onWaitingPress, onReview }: { block: Activity | null; now: number; onWaitingPress: () => void; onReview?: () => void }) {
  const { K } = usePalette();
  return <View style={{ flex: 1, width: 250, padding: 12, gap: 8, borderRadius: 20, backgroundColor: K.block, boxShadow: K.shadowBlock }}>
    <Screws />
    <M s={9.5} w="600" ls={0.08} c={K.inkTertiary} accessibilityRole="header">ACTIVIDAD DEL TURNO</M>
    <RecessedScreen radius={14} style={{ height: 110, alignItems: 'center', justifyContent: 'flex-end', overflow: 'hidden' }}>
      <M s={9.5} c={K.onScreenLabel} style={{ position: 'absolute', left: 10, top: 8 }}>CARGA</M>
      {block ? <M s={13} w="600" c={K.accent} style={{ position: 'absolute', right: 10, top: 8 }}>{block.totalSeconds.toFixed(1)} S</M> : null}
      {block ? <Load block={block} now={now} /> : null}
    </RecessedScreen>
    {block ? <TurnSweep block={block} /> : null}
    <RecessedScreen radius={14} style={{ flex: 1, paddingVertical: 10, paddingHorizontal: 12, gap: 2 }}>
      {block ? <Steps block={block} onWaitingPress={onWaitingPress} /> : <M s={11} c={K.onScreenLabel}>SIN PASOS EN ESTE TURNO</M>}
    </RecessedScreen>
    {onReview ? <Keycap variant="primary" label="Revisar la Aprobación" onPress={onReview} /> : null}
  </View>;
}
