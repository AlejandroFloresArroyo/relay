// Screen headers of Relay 3.1: A (root), B (detail, with a named return) and the tool header.
// Rows wrap instead of cutting or splitting text when the system font grows (up to 130 %).
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

import { usePalette } from '@/theme/ThemeProvider';
import { TYPE } from '@/theme/tokens';
import { BackLink, Lamp, LedTrio, type LampTone, type TrioState } from './kit';
import { M, T } from './primitives';

/** Encabezado A: the root title (Hanken 28/700) and, on the right, the screen's pill and keys. */
export function RootHeader({ title, right }: { title: string; right?: ReactNode }) {
  const { K } = usePalette();
  return <View style={{ minHeight: 56, paddingLeft: 16, paddingRight: 12, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
    <T {...TYPE.title} c={K.ink} accessibilityRole="header">{title}</T>
    {right ? <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 8 }}>{right}</View> : null}
  </View>;
}

/**
 * Encabezado B: the return «‹ <padre>» (its text comes from navigation), optional keys or chip on
 * its right, then an optional identity (avatar, name, mono line, which can be a link, and ON/BSY/ERR) and/or a title
 * with its mono subtitle.
 */
export function DetailHeader({ back, onBack, right, identity, title, subtitle }: {
  /** No return when there is no parent (a tool opened where no navigation gives one). */
  back?: string; onBack?: () => void; right?: ReactNode;
  identity?: { name: string; line: string; state: TrioState; avatar?: ReactNode; onLinePress?: () => void; lineLabel?: string };
  title?: string; subtitle?: string;
}) {
  const { K } = usePalette();
  return <View style={{ paddingLeft: 16, paddingRight: 12 }}>
    <View style={{ minHeight: 48, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      {back && onBack ? <BackLink to={back} onPress={onBack} /> : null}
      {right ? <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 8 }}>{right}</View> : null}
    </View>
    {identity ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 2 }}>
      {identity.avatar ?? <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: K.screen }} />}
      <View style={{ flex: 1, gap: 2 }}>
        <T {...TYPE.subtitle} ls={-0.015} c={K.ink} accessibilityRole="header">{identity.name}</T>
        {identity.onLinePress
          ? <Pressable accessibilityRole="button" accessibilityLabel={identity.lineLabel} hitSlop={{ top: 8, bottom: 8 }} onPress={identity.onLinePress}><M s={9.5} ls={0.04} c={K.inkTertiary}>{identity.line}</M></Pressable>
          : <M s={9.5} ls={0.04} c={K.inkTertiary}>{identity.line}</M>}
      </View>
      <LedTrio state={identity.state} />
    </View> : null}
    {title ? <T {...TYPE.title} c={K.ink} accessibilityRole="header">{title}</T> : null}
    {subtitle ? <M s={9.5} ls={0.04} c={K.inkTertiary} style={{ paddingTop: 4 }}>{subtitle}</M> : null}
  </View>;
}

/** Encabezado de herramienta: the return and the «SERVIDOR · <NOMBRE>» chip of the chosen Servidor. */
export function ToolHeader({ back, onBack, server, led = 'green', extra }: { back?: string; onBack?: () => void; server: string; led?: LampTone; extra?: ReactNode }) {
  const { K } = usePalette();
  return <DetailHeader back={back} onBack={onBack} right={<>
    <View style={{ minHeight: 28, paddingHorizontal: 10, borderRadius: 8, backgroundColor: K.field, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Lamp tone={led} />
      <M s={9.5} ls={0.06} c={K.ink}>SERVIDOR · {server.toUpperCase()}</M>
    </View>
    {extra}
  </>} />;
}

/** Pastilla TAILNET with the network's LED; `open` rings it while its sheet is up. */
export function TailnetPill({ led, open = false, onPress }: { led: LampTone; open?: boolean; onPress: () => void }) {
  const { K } = usePalette();
  return <Pressable accessibilityRole="button" accessibilityLabel="TAILNET" accessibilityState={{ expanded: open }} hitSlop={{ top: 4, bottom: 4 }} onPress={onPress} style={{
    minWidth: 94, minHeight: 40, paddingHorizontal: 14, borderRadius: 999, backgroundColor: K.screen, flexDirection: 'row', alignItems: 'center', gap: 8,
    boxShadow: open ? `${K.shadowScreen}, 0px 0px 0px 2px ${K.background}, 0px 0px 0px 4px ${K.accent}` : K.shadowScreen,
  }}>
    <Lamp tone={led} />
    <M s={9.5} ls={0.06} c={K.onScreenBright}>TAILNET</M>
  </Pressable>;
}

/** Selector de Servidor in header A: the chosen Servidor's LED and name, and «⇕». It opens the Servidores sheet. */
export function ServerSwitch({ name, led, onPress }: { name: string; led: LampTone; onPress: () => void }) {
  const { K } = usePalette();
  return <Pressable accessibilityRole="button" accessibilityLabel={`Servidor ${name}`} hitSlop={{ top: 4, bottom: 4 }} onPress={onPress} style={{
    minWidth: 85, minHeight: 40, paddingHorizontal: 12, borderRadius: 12, backgroundColor: K.screen, boxShadow: K.shadowScreen, flexDirection: 'row', alignItems: 'center', gap: 8,
  }}>
    <Lamp tone={led} />
    <M s={9.5} ls={0.06} c={K.onScreenBright}>{name.toUpperCase()}</M>
    <M s={9.5} c={K.accent}>⇕</M>
  </Pressable>;
}
