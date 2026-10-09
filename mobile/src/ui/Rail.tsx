import { useEffect } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import { TABS, type TabKey } from '@/core/navigation';
import { FRAME } from '@/core/relayLayout';
import { useApp } from '@/state/app';
import { goToTab } from '@/state/navigation';
import { usePalette } from '@/theme/ThemeProvider';
import { RADIUS, ledGlow } from '@/theme/tokens';

import { EngravedRule } from './machinery';
import { M, T } from './primitives';
import { ServerSelector } from './ServerSelector';

const { collapsed: COLLAPSED, expanded: EXPANDED } = FRAME.rail;
/** Expanded keys are 200 wide: the rest of the 240 is their side margin. */
const EXPANDED_MARGIN = (EXPANDED - 200) / 2;
const RAIL_MOTION = { duration: 280, easing: Easing.bezier(0.2, 1, 0.3, 1), reduceMotion: ReduceMotion.System };
/** A horizontal swipe this long on the rail opens (→) or folds (←) it. */
const SWIPE = 40;
const ACTIVE_SHADOW = '0px 2px 3px rgba(0,0,0,0.2)';

function Glyph({ d, color }: { d: string; color: string }) {
  return <Svg width={16} height={16} viewBox="0 0 24 24"><Path d={d} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" /></Svg>;
}

/**
 * The tablet rail (D-0-riel, T-1): 72 with icons, or 240 with names and the Servidor selector. It sits
 * in the row, so opening it pushes the list and the detail instead of covering them.
 */
export function Rail({ active, expanded, onToggle }: { active: TabKey; expanded: boolean; onToggle: (expanded: boolean) => void }) {
  const { K } = usePalette();
  const { pending } = useApp();
  const width = useSharedValue(expanded ? EXPANDED : COLLAPSED);
  useEffect(() => { width.set(withTiming(expanded ? EXPANDED : COLLAPSED, RAIL_MOTION)); }, [expanded, width]);
  const sized = useAnimatedStyle(() => ({ width: width.get(), paddingHorizontal: (width.get() - COLLAPSED) / (EXPANDED - COLLAPSED) * EXPANDED_MARGIN }));
  const swipe = Gesture.Pan().withTestId('riel').activeOffsetX([-15, 15]).runOnJS(true)
    .onEnd(event => { if (event.translationX >= SWIPE) onToggle(true); else if (event.translationX <= -SWIPE) onToggle(false); });
  const key = { height: 48, borderRadius: expanded ? 12 : RADIUS.key, backgroundColor: K.key, boxShadow: K.shadowKey } as const;
  return <GestureDetector gesture={swipe}>
    <Animated.View accessibilityLabel="Navegación principal" style={[{ overflow: 'hidden', backgroundColor: K.background }, sized]}>
      <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        {expanded
          ? <Pressable accessibilityRole="button" accessibilityLabel="Plegar menú" onPress={() => onToggle(false)}
            style={[key, { borderRadius: RADIUS.key, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14 }]}>
            <Glyph d="M15 6l-6 6 6 6" color={K.ink} />
            <T s={16} w="800" ls={-0.02} c={K.ink}>relay</T>
          </Pressable>
          : <Pressable accessibilityRole="button" accessibilityLabel="Desplegar menú" onPress={() => onToggle(true)}
            style={[key, { alignItems: 'center', justifyContent: 'center' }]}>
            <Glyph d="M4 7h16M4 12h16M4 17h16" color={K.ink} />
          </Pressable>}
        <ServerSelector variant={expanded ? 'rail' : 'railCollapsed'} />
        {TABS.map(tab => {
          const selected = tab.key === active;
          const ink = selected ? K.block : K.ink;
          const waiting = tab.key === 'approvals' && pending.length > 0;
          return <Pressable key={tab.key} accessibilityRole="tab" accessibilityLabel={tab.name} accessibilityState={{ selected }}
            onPress={() => goToTab(tab.key)}
            style={[key, selected && { backgroundColor: K.ink, boxShadow: ACTIVE_SHADOW },
              expanded ? { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14 } : { alignItems: 'center', justifyContent: 'center' }]}>
            {expanded ? <>
              <View style={{ width: 14, height: 3, borderRadius: 2, backgroundColor: selected ? K.accent : K.ledOff, boxShadow: selected ? ledGlow(K.accent) : undefined }} />
              <T s={15} w="600" c={ink} numberOfLines={1} style={{ flex: 1 }}>{tab.name}</T>
              {waiting ? <M s={10} w="600" c={K.accentText}>{pending.length}</M> : null}
            </> : <>
              <Glyph d={tab.icon} color={ink} />
              {waiting ? <View style={{ position: 'absolute', top: 6, right: 6, width: 8, height: 8, borderRadius: 4, backgroundColor: K.accent, boxShadow: ledGlow(K.accent) }} /> : null}
            </>}
          </Pressable>;
        })}
        {expanded ? <View style={{ paddingTop: 12 }}><EngravedRule /></View> : null}
      </ScrollView>
    </Animated.View>
  </GestureDetector>;
}
