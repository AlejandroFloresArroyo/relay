import { usePalette } from '@/theme/ThemeProvider';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Keyboard, Platform, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PaneInsetsContext } from './layoutContext';
import { relayLayout } from '@/core/relayLayout';
import { FRAME } from '@/theme/tokens';
import { PauseStrip } from './PauseStrip';
import { M, T } from './primitives';

// On a desktop browser the app is drawn inside the same 390x844 phone bezel as the prototype,
// with its fake status bar, so both can be compared side by side. On a phone (native or a
// narrow browser) the real safe areas are used instead. Wide windows use the tablet layout.
const FramedContext = createContext(false);
export const useFramed = () => useContext(FramedContext);

export function DeviceFrame({ children }: { children: ReactNode }) {
  const { K } = usePalette();
  const { width, height } = useWindowDimensions();
  const framed = Platform.OS === 'web' && width >= 500 && relayLayout(width).kind === 'compact' && height >= FRAME.height;
  if (!framed) {
    return (
      <FramedContext.Provider value={false}>
        <View style={{ flex: 1, backgroundColor: K.background }}>{children}</View>
      </FramedContext.Provider>
    );
  }
  const scale = Math.min(1, (height - 24) / FRAME.height);
  return (
    <FramedContext.Provider value={true}>
      <View style={{ flex: 1, backgroundColor: FRAME.canvas, alignItems: 'center', justifyContent: 'center' }}>
        <View
          style={{
            width: FRAME.width,
            height: FRAME.height,
            borderRadius: FRAME.radius,
            backgroundColor: FRAME.bezelColor,
            padding: FRAME.bezel,
            boxShadow: '0px 0px 0px 1px #2a2a2a, 0px 40px 80px -24px rgba(0,0,0,0.6)',
            transform: [{ scale }],
          }}>
          <View style={{ flex: 1, borderRadius: FRAME.innerRadius, overflow: 'hidden', backgroundColor: K.background }}>{children}</View>
        </View>
      </View>
    </FramedContext.Provider>
  );
}

/**
 * Top inset: the prototype's 50px status bar inside the bezel, the real safe area elsewhere.
 * The Pausa general strip sits right under it on every screen; the lock screen opts out.
 */
export function StatusBarSpace({ strip = true }: { strip?: boolean }) {
  const framed = useFramed();
  const insets = useSafeAreaInsets();
  const handled = useContext(PaneInsetsContext);
  if (handled) return null;
  const pause = strip ? <PauseStrip /> : null;
  if (!framed) return <><View style={{ height: insets.top }} />{pause}</>;
  return (<>
    <View
      style={{
        height: FRAME.statusBar,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingLeft: 36,
        paddingRight: 30,
      }}>
      <T s={15} w="600">
        9:41
      </T>
      <View style={{ position: 'absolute', left: '50%', top: 11, marginLeft: -61, width: 122, height: 35, borderRadius: 20, backgroundColor: '#000' }} />
      <M s={10}>5G ▮▮▮</M>
    </View>
    {pause}
  </>);
}

/** Bottom inset for screens without the tab bar. `min` is the padding the prototype leaves. */
export function useBottomInset(min: number): number {
  const framed = useFramed();
  const insets = useSafeAreaInsets();
  const handled = useContext(PaneInsetsContext);
  return framed || handled ? min : Math.max(min, insets.bottom + 8);
}

/** True while the software keyboard is up. */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setVisible(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

/** The home indicator pill, only drawn inside the bezel (the OS draws the real one). */
export function HomeIndicator() {
  const { K } = usePalette();
  const framed = useFramed();
  if (!framed) return null;
  return (
    <View
      style={{ pointerEvents: 'none', position: 'absolute', bottom: 8, left: '50%', marginLeft: -67, width: 134, height: 5, borderRadius: 3, backgroundColor: K.ink, opacity: 0.35 }}
    />
  );
}

/** Keep global backdrops full-window while decisions have a comfortable reading measure. */
export function useSheetBounds() {
  const { width, height, fontScale } = useWindowDimensions();
  const framed = useFramed();
  const insets = useSafeAreaInsets();
  const maxHeight = framed ? FRAME.height - 2 * FRAME.bezel - FRAME.statusBar : Math.max(0, height - insets.top);
  return !framed && relayLayout(width, fontScale).kind !== 'compact'
    ? { maxHeight, width: '100%' as const, maxWidth: 620, alignSelf: 'center' as const, left: undefined, right: undefined }
    : { maxHeight, left: 0, right: 0 };
}
