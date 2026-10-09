// The TAILNET pill and its «Red privada» sheet (D-0-3): the VPN reading, every Servidor's answer,
// and the two ways out, «Reintentar» and «Abrir Tailscale».
import { useState } from 'react';
import { View } from 'react-native';

import { demoVpnAvailability } from '@/core/demo';
import { describeTailscaleButton, transitionTailscaleButton, type TailscaleButtonState } from '@/core/tailscaleButton';
import { tailnetName } from '@/core/tailnet';
import { DEMO, useApp } from '@/state/app';
import { openTailscale } from '@/state/openTailscale';
import { usePalette } from '@/theme/ThemeProvider';
import { TEXT_GLOW } from '@/theme/tokens';
import { TailnetPill as Pill } from './headers';
import { Keycap, Lamp } from './kit';
import { RecessedScreen } from './machinery';
import { M, T } from './primitives';
import { serverLed } from './ServerSelector';
import { Sheet } from './sheet';

const VPN = {
  available: { led: 'green', label: 'CONECTADA', phrase: 'Este teléfono está en la tailnet.' },
  absent: { led: 'red', label: 'SIN VPN', phrase: 'La red actual de Relay no usa VPN. Comprueba Tailscale.' },
  unknown: { led: 'off', label: 'SIN COMPROBAR', phrase: 'Relay no pudo comprobar su VPN.' },
} as const;

/** The TAILNET pill: its LED is the VPN reading; it opens the «Red privada» sheet and rings while it shows. */
export function TailnetPill() {
  const { vpnReading, selectedServer } = useApp();
  const [open, setOpen] = useState(false);
  const vpn = DEMO ? demoVpnAvailability(selectedServer ?? '') : vpnReading.vpn;
  return <>
    <Pill led={VPN[vpn].led} open={open} onPress={() => { setOpen(true); }} />
    <TailnetSheet vpn={vpn} visible={open} onClose={() => { setOpen(false); }} />
  </>;
}

function TailnetSheet({ vpn, visible, onClose }: { vpn: keyof typeof VPN; visible: boolean; onClose: () => void }) {
  const { K } = usePalette();
  const { servers, snapshot, refresh } = useApp();
  const [tailscale, setTailscale] = useState<TailscaleButtonState>('ready');
  const name = tailnetName(servers.map(s => s.url));
  const state = VPN[vpn];
  const retry = () => {
    const down = servers.filter(s => snapshot(s.id).reachable === false);
    if (down.length) for (const s of down) refresh(s.id); else refresh();
  };
  const launch = async () => {
    const transition = transitionTailscaleButton(tailscale, { type: 'press' });
    setTailscale(transition.state);
    if (transition.effect === 'retry') retry();
    if (transition.effect === 'open') {
      const opened = await openTailscale();
      setTailscale(current => transitionTailscaleButton(current, { type: 'result', opened }).state);
    }
  };
  const button = describeTailscaleButton(tailscale);
  return <Sheet visible={visible} onClose={onClose} title="Red privada" subtitle={name ? `TAILSCALE · ${name}` : 'TAILSCALE'} action={<>
    <Keycap label="Reintentar" onPress={retry} style={{ flex: 1 }} />
    <Keycap variant="primary" label={button.label} disabled={button.disabled} onPress={() => { void launch(); }} style={{ flex: 1 }} />
  </>}>
    <RecessedScreen radius={16} style={{ paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Lamp tone={state.led} size={9} onScreen />
      <View style={{ flex: 1, gap: 4 }}>
        <M s={13} w="600" ls={0.08} c={vpn === 'available' ? K.okTextOnScreen : vpn === 'absent' ? K.dangerTextOnScreen : K.onScreenBright}
          glow={vpn === 'available' ? TEXT_GLOW.ok : undefined}>{state.label}</M>
        <T s={13} c={K.onScreen}>{state.phrase}</T>
      </View>
    </RecessedScreen>
    <View style={{ borderRadius: 20, backgroundColor: K.field, paddingHorizontal: 12 }}>
      {servers.map((s, i) => {
        const snap = snapshot(s.id);
        return <View key={s.id} style={{ minHeight: 48, borderTopWidth: i ? 1 : 0, borderTopColor: K.line, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Lamp tone={serverLed(snap.reachable)} size={8} />
          <T s={15} w="600" c={K.ink} style={{ flex: 1 }}>{s.name}</T>
          {snap.reachable === true
            ? <M s={11} c={K.inkSecondary}>{`${Math.round(snap.latencyMs ?? 0)} MS`}</M>
            : <M s={9.5} w="600" ls={0.06} c={snap.reachable === false ? K.dangerText : K.inkTertiary}>{snap.reachable === false ? 'SIN RESPUESTA' : 'CONECTANDO…'}</M>}
        </View>;
      })}
    </View>
    <T s={13} c={K.inkSecondary}>Si un Servidor no contesta, revisa Tailscale en este teléfono y que el Puente esté corriendo en el Servidor.</T>
  </Sheet>;
}
