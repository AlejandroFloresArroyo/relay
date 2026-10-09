import { usePalette } from '@/theme/ThemeProvider';
import * as LocalAuthentication from 'expo-local-authentication';
import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform, Pressable, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { DEMO_LOCK_NOTICE } from '@/core/demo';
import { idleLockCountdown, createLockGate, configureLockGate, lockGateReducer, lockGateView } from '@/core/lock';
import { DEMO, useApp, useNow } from '@/state/app';
import { ChatVisibilityProvider } from '@/state/chatVisibility';
import { useSharedDraftLock } from '@/state/sharedDrafts';
import { RemoteAccessProvider } from '@/state/remoteAccess';
import { shareReceiver } from '@/native/externalShare';

import { HomeIndicator, StatusBarSpace, useBottomInset } from '@/ui/chrome';
import { FingerprintIcon } from '@/ui/icons';
import { Keycap, Lamp } from '@/ui/kit';
import { RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';
import { ledGlow, TEXT_GLOW, TYPE } from '@/theme/tokens';

/** Relay's mark: the orange LED between two dark ones on a recessed pill. */
function LogoPill() {
  const { K } = usePalette();
  return <View style={{ width: 150, height: 64, borderRadius: 32, backgroundColor: K.screen, boxShadow: K.shadowScreen, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-evenly' }}>
    <Lamp tone="off" onScreen size={19.2} /><Lamp tone="orange" size={19.2} /><Lamp tone="off" onScreen size={19.2} />
  </View>;
}

/** The biometric gate and the three lock surfaces from canvases 22b·1–3. */
export function LockGate({ children }: { children: ReactNode }) {
  const { ready, settings, servers } = useApp();
  if (!ready) return null;
  const enabled = !DEMO && Platform.OS !== 'web' && settings.faceid && servers.length > 0;
  return <Gate enabled={enabled} delayMs={settings.autoLockMs}>{children}</Gate>;
}

function Gate({ enabled, delayMs, children }: { enabled: boolean; delayMs: number; children: ReactNode }) {
  const { K } = usePalette();
  const { pending, lockPreview, previewLock } = useApp();
  const [gate, dispatch] = useReducer(lockGateReducer, { enabled, delayMs }, (config) => createLockGate(config, Date.now()));
  const locked = gate.lock.locked;
  const [lastActivity, setLastActivity] = useState(() => Date.now());
  const [active, setActive] = useState(AppState.currentState === 'active');
  const prompting = useRef(false);
  const drafts = useSharedDraftLock();
  const leaving = useRef<Promise<string[]> | null>(null);
  const wasLocked = useRef(locked);
  const [authenticating, setAuthenticating] = useState(false);
  const now = useNow(250);
  const bottom = useBottomInset(40);
  useEffect(() => {
    dispatch({ type: 'configured', enabled, delayMs });
    const reset = setTimeout(() => setLastActivity(Date.now()), 0);
    return () => clearTimeout(reset);
  }, [enabled, delayMs]);

  const unlock = useCallback(async () => {
    if (DEMO && lockPreview) { previewLock(null); return; }
    if (prompting.current) return;
    prompting.current = true;
    setAuthenticating(true);
    try {
      // Android can authenticate with the phone code when biometrics are unavailable.
      // An unavailable authenticator never grants access on its own.
      const res = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Desbloquear Relay con huella',
        fallbackLabel: 'Usar el código del teléfono',
        disableDeviceFallback: false,
      });
      if (res.success) dispatch({ type: 'unlocked' });
    } catch {
      // Stay locked; the user can retry.
    } finally {
      prompting.current = false;
      setAuthenticating(false);
      setLastActivity(Date.now());
    }
  }, [dispatch, lockPreview, previewLock]);

  useEffect(() => {
    if (gate.prompt) {
      dispatch({ type: 'prompted' });
      void unlock();
    }
  }, [gate.prompt, unlock]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      setActive(state === 'active');
      if (state === 'background') {
        leaving.current = shareReceiver.pending();
        dispatch({ type: 'background', now: Date.now() });
      }
      else if (state === 'active') {
        setLastActivity(Date.now());
        dispatch({ type: 'foreground', now: Date.now() });
      }
    });
    return () => sub.remove();
  }, [dispatch, unlock]);

  // Locking purges shared drafts. A lock on return covers what was pending when Relay left;
  // content shared while it was away waits behind the lock, as on a cold start.
  useEffect(() => {
    const newlyLocked = locked && !wasLocked.current;
    wasLocked.current = locked;
    if (newlyLocked) { void drafts(true, leaving.current ?? shareReceiver.pending()); leaving.current = null; }
    else if (!locked) { void drafts(false); if (active) leaving.current = null; }
  }, [locked, active, drafts]);

  const countdown = idleLockCountdown(lastActivity, now, delayMs, enabled && active && !locked && !authenticating);
  useEffect(() => {
    if (countdown === 0) dispatch({ type: 'idle', now: Date.now() });
  }, [countdown, dispatch]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const activity = () => setLastActivity(Date.now());
    document.addEventListener('keydown', activity);
    return () => document.removeEventListener('keydown', activity);
  }, []);

  const resume = () => { setLastActivity(Date.now()); if (DEMO) previewLock(null); };

  const { showLock, contentProps } = lockGateView(configureLockGate(gate, { enabled, delayMs }), DEMO && lockPreview === 'locked');
  const count = pending.length;
  const time = new Date(gate.lockedAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
  const lockScreen = showLock ? (
      <View style={{ flex: 1, backgroundColor: K.background }}>
        <StatusBarSpace strip={false} />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 22, paddingHorizontal: 32 }}>
          <LogoPill />
          <View style={{ alignItems: 'center', gap: 6 }}>
            <T s={24} w="700" ls={-0.02}>Relay está bloqueado</T>
            <T s={14} c={K.inkSecondary} lh={1.45} style={{ textAlign: 'center' }}>
              {count === 1 ? 'Hay 1 aprobación esperando. Desbloquea para verla.' : count > 1 ? `Hay ${count} aprobaciones esperando. Desbloquea para verlas.` : 'Desbloquea con tu huella para usar Relay.'}
            </T>
          </View>
          <Pressable role="button" onPress={unlock}
            style={({ pressed }) => ({ width: 96, height: 96, borderRadius: 48, backgroundColor: K.key, alignItems: 'center', justifyContent: 'center', transform: [{ translateY: pressed ? 1 : 0 }],
              boxShadow: `${pressed ? K.shadowKeyPressed : K.shadowKey}, 0px 4px 10px rgba(0,0,0,0.18), 0px 0px 0px 5px rgba(242,154,26,0.25), ${ledGlow(K.accent)}` })}>
            <FingerprintIcon size={40} />
          </Pressable>
          <M {...TYPE.label} ls={0.08} c={K.inkTertiary}>PON TU HUELLA PARA DESBLOQUEAR</M>
        </View>
        <View style={{ alignItems: 'center', gap: 6, paddingBottom: bottom }}>
          <Pressable onPress={unlock}><T s={14} w="600" c={K.accentText}>Usar el código del teléfono</T></Pressable>
          <M {...TYPE.label} ls={0.06} c={K.inkTertiary}>BLOQUEADO A LAS {time} · {gate.reason}</M>
        </View>
        <HomeIndicator />
      </View>
  ) : null;
  const seconds = DEMO && lockPreview === 'notice' ? DEMO_LOCK_NOTICE.seconds : countdown;
  return (
    <View style={{ flex: 1 }} onTouchStart={showLock ? undefined : resume}>
      <View {...contentProps}>
        <ChatVisibilityProvider value={active && !showLock && !authenticating}><RemoteAccessProvider locked={showLock}>{children}</RemoteAccessProvider></ChatVisibilityProvider>
      </View>
      {lockScreen}
      {!showLock && seconds != null && seconds > 0 ? (
        <View style={{ position: 'absolute', inset: 0 }}>
          <Pressable onPress={resume} accessibilityLabel="Seguir usando Relay" style={{ position: 'absolute', inset: 0, backgroundColor: K.sheetBackdrop }} />
          <RecessedScreen radius={22} rim style={{ position: 'absolute', top: 58, left: 12, right: 12, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <View style={{ width: 52, height: 52 }}>
              <Svg width={52} height={52} viewBox="0 0 52 52">
                <Circle cx={26} cy={26} r={22} fill="none" stroke={K.spinnerTrack} strokeWidth={4} />
                <Circle cx={26} cy={26} r={22} fill="none" stroke={K.accent} strokeWidth={4} strokeLinecap="round" strokeDasharray="138" strokeDashoffset={138 * (1 - seconds / 8)} rotation={-90} origin="26,26" />
              </Svg>
              <M s={15} c={K.onScreenBright} style={{ position: 'absolute', inset: 0, textAlign: 'center', lineHeight: 52 }}>{seconds}</M>
            </View>
            <View style={{ flex: 1, gap: 3 }}>
              <M s={10} w="600" ls={0.06} c={K.accent} glow={TEXT_GLOW.accent}>SE BLOQUEARÁ EN {seconds} S</M>
              <T s={12.5} c={K.onScreen} lh={1.35}>Sin actividad durante {DEMO && lockPreview ? DEMO_LOCK_NOTICE.minutes : delayMs / 60_000} min.</T>
            </View>
            <Keycap variant="screen" label="Seguir" onPress={resume} />
          </RecessedScreen>
        </View>
      ) : null}
    </View>
  );
}
