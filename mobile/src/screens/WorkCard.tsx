// A Tarjeta of Trabajo (D-17): a row of the phone's list block, or a card of the tablet's five columns.
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import type { KanbanItem } from '../../../protocol/kanban';
import { WORK_COLUMNS, nextColumn } from '@/core/kanban';
import { usePalette } from '@/theme/ThemeProvider';
import { RADIUS, TYPE } from '@/theme/tokens';
import { Lamp } from '@/ui/kit';
import { SwipeRow } from '@/ui/gestures';
import { Lights } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';

type Card = { item: KanbanItem; name: string; blockerNumbers: string; fresh: boolean; writable: boolean; open: () => void };

/** The Agente or «Sin asignar» in a sunken chip with its LED. */
function AgentChip({ item, name }: { item: KanbanItem; name: string }) {
  const { K } = usePalette();
  return <View style={{ alignSelf: 'flex-start', minHeight: 22, paddingHorizontal: 8, borderRadius: 8, backgroundColor: K.field, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
    <Lamp tone={item.agentId ? 'green' : 'off'} size={6} />
    <M s={9.5} c={item.agentId ? K.ink : K.inkTertiary}>{name}</M>
  </View>;
}

function Blockers({ numbers }: { numbers: string }) {
  const { K } = usePalette();
  return <M s={9.5} ls={0.04} c={K.dangerText}>BLOQUEADO POR {numbers}</M>;
}

/** Phone: → passes the Tarjeta to the next column (skipping BLOQUEADO; nothing in HECHO). */
export function WorkRow({ item, name, blockerNumbers, fresh, writable, open, compact, onNext }: Card & { compact: boolean; onNext: () => void }) {
  const { K } = usePalette();
  const next = nextColumn(item.column);
  return <SwipeRow testID={`work-${item.number}`} swipeRight={writable && next ? { label: `Pasar a ${WORK_COLUMNS[next]}`, onAction: onNext } : undefined}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Abrir elemento ${item.number}`} accessibilityHint={writable ? 'Desliza a la derecha para pasarla a la columna siguiente.' : 'Copia de solo lectura.'}
      onPress={open} style={{ minHeight: 64, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 12, opacity: fresh ? 1 : 0.6 }}>
      <M s={11} c={K.inkTertiary}>#{item.number}</M>
      <View style={{ flex: 1, gap: 4 }}>
        <T {...TYPE.body} c={K.ink} numberOfLines={compact ? 1 : 3}>{item.title}</T>
        {item.column === 'blocked' ? <Blockers numbers={blockerNumbers} /> : null}
        {compact ? null : <AgentChip item={item} name={name} />}
        {item.column === 'in_progress' && !compact ? <Lights tone="orange" /> : null}
      </View>
      <T s={18} c={K.inkTertiary}>›</T>
    </Pressable>
  </SwipeRow>;
}

const LIFT_MS = 250;
const SETTLE = { duration: 300, easing: Easing.bezier(0.2, 1, 0.3, 1) };

/**
 * Tablet: held and dragged, the card follows the finger; `onMove` says how far it has travelled
 * (null when it is let go or cancelled) so the screen can mark the column under it, and `onDrop`
 * gets the final travel, only when the finger lifted: a drag the system cancels drops nothing. The screen decides the column and whether it opens the block picker.
 */
/** How far a held card has travelled, and where it started in its column and how tall it is. */
export type Travel = { dx: number; dy: number; at: number; size: number };

export function WorkTile({ item, name, blockerNumbers, fresh, writable, open, onLift, onMove, onDrop }: Card & {
  onLift: () => void; onMove: (travel: Travel | null) => void; onDrop: (travel: Travel) => void;
}) {
  const { K } = usePalette();
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const lifted = useSharedValue(false);
  // Where the card sits in its column, from layout: plain state, so it is merged into the travel on the JS side.
  const [spot, setSpot] = useState({ at: 0, size: 0 });
  const moved = (dx: number, dy: number): Travel => ({ dx, dy, ...spot });
  const move = (dx: number, dy: number) => { onMove(moved(dx, dy)); };
  const drop = (dx: number, dy: number) => { onDrop(moved(dx, dy)); };
  const pan = Gesture.Pan().withTestId(`work-card-${item.number}`).enabled(writable).activateAfterLongPress(LIFT_MS)
    .onStart(() => { lifted.set(true); scheduleOnRN(onLift); })
    .onUpdate(event => { x.set(event.translationX); y.set(event.translationY); scheduleOnRN(move, event.translationX, event.translationY); })
    .onEnd((event, success) => { if (success) scheduleOnRN(drop, event.translationX, event.translationY); })
    .onFinalize(() => {
      lifted.set(false); x.set(withTiming(0, SETTLE)); y.set(withTiming(0, SETTLE));
      scheduleOnRN(onMove, null);
    });
  const follow = useAnimatedStyle(() => ({ zIndex: lifted.get() ? 10 : 0, transform: [{ translateX: x.get() }, { translateY: y.get() }, { rotate: lifted.get() ? '-1deg' : '0deg' }] }));
  return <GestureDetector gesture={pan}>
    <Animated.View testID={`work-tile-${item.number}`} style={follow} onLayout={event => { setSpot({ at: event.nativeEvent.layout.y, size: event.nativeEvent.layout.height }); }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Abrir elemento ${item.number}`} accessibilityHint={writable ? 'Mantén pulsado y arrastra a otra columna.' : 'Copia de solo lectura.'}
        onPress={open} style={{ padding: 10, gap: 6, borderRadius: RADIUS.key + 2, backgroundColor: K.block, boxShadow: K.shadowBlock, opacity: fresh ? 1 : 0.6 }}>
        <M s={9.5} c={K.inkTertiary}>#{item.number}</M>
        <T s={14} w="600" c={K.ink} numberOfLines={3}>{item.title}</T>
        {item.column === 'blocked' ? <Blockers numbers={blockerNumbers} /> : null}
        <AgentChip item={item} name={name} />
      </Pressable>
    </Animated.View>
  </GestureDetector>;
}
