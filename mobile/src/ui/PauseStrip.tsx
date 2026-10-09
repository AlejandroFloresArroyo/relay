import { usePalette } from '@/theme/ThemeProvider';
import { useRef, useState, type ReactNode } from 'react';
import { AppState, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';

import { confirmWithFingerprint } from '@/state/confirmWithFingerprint';
import { useApp, type ServerEntry } from '@/state/app';
import { Keycap } from './kit';
import { M } from './primitives';


/** Warning stripes (20·4): orange on ink at 135°, 7px bands. */
export function HazardFrame({ radius, pad, style, children }: { radius: number; pad: number; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const { K } = usePalette();
  const { width } = useWindowDimensions();
  return <View style={[{ borderRadius: radius, padding: pad, overflow: 'hidden', backgroundColor: K.onAccent }, style]}>
    <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}>
      {Array.from({ length: Math.ceil(width / 19.8) + 12 }, (_, i) => <View key={i} style={{ position: 'absolute', width: 7, top: -120, bottom: -120, left: i * 19.8 - 120, backgroundColor: K.accent, transform: [{ rotate: '45deg' }] }} />)}
    </View>
    {children}
  </View>;
}

/** Shown instead of an Agente's avatar while its Servidor is in Pausa general. */
export function PauseSymbol({ size = 46 }: { size?: number }) {
  const { K } = usePalette();
  return <View accessibilityLabel="Agente en pausa" style={{ width: size, height: size, borderRadius: size * 0.27, backgroundColor: K.onAccent, flexDirection: 'row', gap: 3, alignItems: 'center', justifyContent: 'center' }}>
    <View style={{ width: 4, height: 13, borderRadius: 1, backgroundColor: K.accent }} /><View style={{ width: 4, height: 13, borderRadius: 1, backgroundColor: K.accent }} />
  </View>;
}

/** One strip per paused Servidor, fixed under the status bar on every screen. */
export function PauseStrip({ top = 0 }: { top?: number }) {
  const { servers, snapshot } = useApp();
  const paused = servers.filter((server) => snapshot(server.id).serverControl?.paused === true);
  return paused.length ? <View style={{ gap: 6, marginHorizontal: 12, marginTop: top, marginBottom: 8 }}>{paused.map((server) => <ServerPauseStrip key={server.id} server={server} />)}</View> : null;
}

function ServerPauseStrip({ server }: { server: ServerEntry }) {
  const { K } = usePalette();
  const { snapshot, clientFor, refresh } = useApp();
  const snap = snapshot(server.id);
  const control = snap.serverControl;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const running = useRef(false);
  const name = server.name.toUpperCase();
  const resume = async () => {
    if (running.current) return;
    running.current = true; setBusy(true); setFailure(null);
    const client = clientFor(server.id);
    // The fingerprint belongs to this Servidor's client while Relay stays in front.
    const current = () => AppState.currentState === 'active' && clientFor(server.id) === client;
    try {
      if (!await confirmWithFingerprint(`Reanudar ${server.name} con huella`, current)) { setFailure('NO SE CONFIRMÓ LA HUELLA · SIGUE EN PAUSA'); return; }
      await client.resumeServer();
    } catch {
      setFailure('NO SE PUDO REANUDAR · REVISA EL SERVIDOR');
    } finally { running.current = false; setBusy(false); refresh(); }
  };
  const detail = failure ?? (control?.phase === 'pending' ? 'CAMBIO PENDIENTE EN EL SERVIDOR'
    : control?.phase === 'failed' || control?.hermesPaused !== true ? 'PAUSA SIN CONFIRMAR · RELAY NO ADMITE TURNOS' : 'RELAY NO ADMITE TURNOS');
  const blocked = busy || control?.phase === 'pending' || snap.reachable === false;
  // Franja naranja «PAUSA GENERAL · <SERVIDOR>» with «Reanudar» (F-4); resuming asks for the fingerprint.
  return <View style={{ minHeight: 56, borderRadius: 14, backgroundColor: K.accent, boxShadow: K.shadowPrimary, paddingVertical: 4, paddingRight: 4, paddingLeft: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <M s={9.5} w="600" ls={0.07} c={K.onAccent} numberOfLines={1}>{`PAUSA GENERAL · ${name}`}</M>
      <M s={9.5} w={failure ? '600' : '400'} ls={0.04} c={K.onAccent} numberOfLines={1}>{detail}</M>
    </View>
    <Keycap variant="dark" label={busy ? 'Reanudando…' : 'Reanudar'} accessibilityLabel={`Reanudar ${server.name} con huella`} disabled={blocked} onPress={() => { void resume(); }} />
  </View>;
}
