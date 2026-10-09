import { useContext, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, useWindowDimensions, View, type ViewStyle } from 'react-native';
import { usePathname } from 'expo-router';
import Svg, { Path } from 'react-native-svg';

import { approvalsHidden, revealApprovals, TABS, type TabKey } from '@/core/navigation';
import { useApp } from '@/state/app';
import { useToolsOpen } from '@/state/remoteAccess';
import { usePalette } from '@/theme/ThemeProvider';
import { ledGlow } from '@/theme/tokens';

import { HomeIndicator, useBottomInset, useFramed } from './chrome';
import { ShellNavigationContext } from './layoutContext';
import { M } from './primitives';

// ponytail: memory for this launch only (the bar unmounts in tools, on tablet and on lock); persist if asked.
let remembered = 0;

/** The phone's eight-key bar at the bottom of the tabs. Herramientas swaps it for its tool bar. */
export function TabBar({ active, onSelect }: { active: string; onSelect: (key: TabKey) => void }) {
  const { K } = usePalette();
  const bottom = useBottomInset(28);
  const provided = useContext(ShellNavigationContext);
  const pathname = usePathname();
  const { pending, selectedServer } = useApp();
  const toolsOpen = useToolsOpen(selectedServer);
  const framed = useFramed();
  const { width } = useWindowDimensions();
  const scroll = useRef<ScrollView>(null);
  const [offset, setOffset] = useState(remembered);
  // The tool bar takes its place once the tools are entered; the fingerprint gate keeps the tabs (D-21).
  if (provided || (toolsOpen && (pathname === '/tools' || pathname.startsWith('/tools/')))) return null;
  const viewport = framed ? 370 : width;
  const remember = (x: number) => { remembered = x; setOffset(x); };
  const badge = pending.length > 0 && approvalsHidden(offset, viewport);
  return (
    <View style={{ paddingBottom: bottom, backgroundColor: K.background }}>
      <ScrollView
        ref={scroll}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={72}
        decelerationRate="fast"
        scrollEventThrottle={16}
        contentOffset={{ x: offset, y: 0 }}
        onScroll={(event) => remember(event.nativeEvent.contentOffset.x)}
        contentContainerStyle={{ gap: 6, padding: 12 }}>
        {TABS.map((tab) => {
          const on = tab.key === active;
          const lit = tab.key === 'approvals' && pending.length > 0;
          return (
            <Pressable
              key={tab.key}
              onPress={() => onSelect(tab.key)}
              accessibilityLabel={tab.name}
              accessibilityState={{ selected: on }}
              role="tab"
              aria-selected={on}
              style={{
                width: 66,
                height: 56,
                borderRadius: 14,
                backgroundColor: on ? K.ink : K.key,
                boxShadow: on ? '0px 2px 3px rgba(0,0,0,0.2)' : K.shadowKey,
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
              }}>
              <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" style={on ? { filter: `drop-shadow(0px 0px 4px ${K.accent})` } : undefined}>
                <Path d={tab.icon} stroke={on ? K.accent : K.inkSecondary} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              </Svg>
              {/* Seven Mono characters at most: 61 of the key's 66 at 130 % system font (story 87). */}
              <M s={9.5} ls={0} numberOfLines={1} c={on ? K.key : K.inkSecondary}>{tab.short}</M>
              <View style={{ position: 'absolute', top: 7, right: 7, width: 8, height: 8, borderRadius: 4, backgroundColor: K.accent, boxShadow: ledGlow(K.accent), opacity: lit ? 1 : 0 }} />
            </Pressable>
          );
        })}
      </ScrollView>
      {badge ? (
        <View style={[{ position: 'absolute', top: 12, right: 0, width: 72, height: 56, alignItems: 'flex-end', justifyContent: 'center', paddingRight: 12 },
          gradient(`linear-gradient(90deg, ${K.background}00 0%, ${K.background} 55%)`)]}>
          <Pressable
            role="button"
            accessibilityLabel={`Ver ${pending.length} Aprobaciones pendientes`}
            onPress={() => { const x = revealApprovals(viewport); scroll.current?.scrollTo({ x, animated: true }); remember(x); }}
            style={{ minWidth: 39, height: 28, borderRadius: 14, paddingHorizontal: 8, backgroundColor: K.accent, boxShadow: ledGlow(K.accent), alignItems: 'center', justifyContent: 'center' }}>
            <M s={10} w="600" c={K.onAccent}>{`${pending.length} ›`}</M>
          </Pressable>
        </View>
      ) : null}
      <HomeIndicator />
    </View>
  );
}

// RN draws CSS gradients from `experimental_backgroundImage`; react-native-web takes the CSS property.
const gradient = (css: string) => (Platform.OS === 'web' ? { backgroundImage: css } : { experimental_backgroundImage: css }) as ViewStyle;
