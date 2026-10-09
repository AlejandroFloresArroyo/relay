import { usePalette } from '@/theme/ThemeProvider';
import { useState, type ReactNode } from 'react';
import { usePathname } from 'expo-router';
import { View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { relayDestination } from '@/core/navigation';
import { FRAME, listBounds, relayLayout } from '@/core/relayLayout';
import { useApp } from '@/state/app';
import { useListWidths } from '@/state/listWidths';

import { useFramed } from './chrome';
import { PaneInsetsContext, PaneTopContext, ShellNavigationContext } from './layoutContext';
import { ListPane } from './ListPane';
import { PauseStrip } from './PauseStrip';
import { Rail } from './Rail';

/**
 * One mounted route tree. On a tablet (ADR 0007) the rail, an optional list (Agentes, Servidores) and
 * the detail share a row; on a phone only the route shows. The tree keeps its shape across both, so
 * a rotation never remounts the route.
 */
export function RelayShell({ children }: { children: ReactNode }) {
  const { K } = usePalette();
  const { width, fontScale } = useWindowDimensions();
  const framed = useFramed();
  const layout = relayLayout(framed ? 370 : width, fontScale);
  const destination = relayDestination(usePathname());
  const { ready, servers, sheet } = useApp();
  const insets = useSafeAreaInsets();
  const [expanded, setExpanded] = useState(false);
  const [widths, setWidths] = useListWidths();
  // Where the screen starts inside the pane: below the Pausa general strips, if any.
  const [screenY, setScreenY] = useState(0);
  const tablet = layout.kind !== 'compact' && ready && servers.length > 0 ? destination : null;
  const bounds = tablet?.list ? listBounds(width, FRAME.rail[expanded ? 'expanded' : 'collapsed']) : null;
  const edge = tablet ? FRAME.edge : 0;
  // Under an Aprobación nothing here is for a screen reader: `accessibilityViewIsModal` only works on iOS.
  return <View aria-hidden={!!sheet} accessibilityElementsHidden={!!sheet} importantForAccessibility={sheet ? 'no-hide-descendants' : 'auto'} style={{ flex: 1, flexDirection: 'row', backgroundColor: K.background,
    paddingTop: tablet ? insets.top + edge : 0,
    paddingBottom: tablet ? insets.bottom + edge : 0,
    paddingLeft: tablet ? insets.left + edge : 0,
    paddingRight: tablet ? insets.right + edge : 0,
    gap: tablet ? FRAME.gutter : 0,
  }}>
    {tablet ? <Rail key="rail" active={tablet.active} expanded={expanded} onToggle={setExpanded} /> : null}
    {tablet?.list && bounds ? <ListPane key="list" section={tablet.list} bounds={bounds} widths={widths} onWidths={setWidths} /> : null}
    <View key="content" style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
      <View accessibilityLabel="Contenido principal" style={{ flex: 1, width: '100%', maxWidth: tablet && !tablet.fullWidth && !bounds ? layout.contentMaxWidth : undefined,
        borderRadius: tablet ? 26 : 0, overflow: 'hidden', backgroundColor: K.background }}>
        {tablet ? <PauseStrip top={8} /> : null}
        <View style={{ flex: 1 }} onLayout={(event) => setScreenY(event.nativeEvent.layout.y)}>
          <PaneInsetsContext.Provider value={tablet !== null}><ShellNavigationContext.Provider value={tablet !== null}><PaneTopContext.Provider value={tablet ? insets.top + edge + screenY : 0}>{children}</PaneTopContext.Provider></ShellNavigationContext.Provider></PaneInsetsContext.Provider>
        </View>
      </View>
    </View>
  </View>;
}
