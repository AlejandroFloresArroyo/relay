import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { AppState, BackHandler, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import type { ApprovalChoice } from '../../../protocol/protocol';
import { approvalDeadline } from '@/core/approvalTime';
import { RelayError } from '@/core/client';
import { countdown, relTime } from '@/core/format';
import { useApp, useNow, type PendingApproval } from '@/state/app';
import { useChatVisible } from '@/state/chatVisibility';
import { confirmWithFingerprint } from '@/state/confirmWithFingerprint';
import { usePalette } from '@/theme/ThemeProvider';
import { RADIUS, TYPE, ledGlow, textGlow } from '@/theme/tokens';
import { useBottomInset, useSheetBounds } from '@/ui/chrome';
import { Keycap } from '@/ui/kit';
import { HoldKey, RecessedScreen, Screws, Sweep } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';
import { SHEET_CLOSE_DRAG, SHEET_MOTION, Toast } from '@/ui/sheet';

// Drawn the same in both themes: the safety's paddle and its unlit LED.
const FIXED_INK = '#1A1A19';
const LED_DARK = '#3A3936';

/**
 * La Aprobación (F-3), over whatever is on screen: the full screen on a phone, a sheet on tablet.
 * Approving takes the seguro off, a 1 s hold of «Aprobar» and the huella; expiry is checked when
 * sending, after the huella. The toast lives here so it outlasts the sheet. Android's back key, the
 * backdrop, the grip and «Cerrar» (once it is decided, expired or failed) close it without deciding,
 * except while the huella is asked or the decision is on its way.
 */
export function ApprovalSheet() {
  const { sheet } = useApp();
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  return <>
    {sheet ? <Sheet key={JSON.stringify([sheet.serverId, sheet.approval.id, sheet.approval.agentId, sheet.approval.runId])} sheet={sheet}
      onApproved={(text) => setToast({ id: Date.now(), text })} /> : null}
    {toast ? <Toast key={toast.id} message={toast.text} onHide={() => setToast(null)} /> : null}
  </>;
}

function Sheet({ sheet, onApproved }: { sheet: PendingApproval; onApproved: (toast: string) => void }) {
  const { K } = usePalette();
  const { closeApproval, decide, servers, snapshot } = useApp();
  const bottom = useBottomInset(16);
  const bounds = useSheetBounds();
  const [decision, setDecision] = useState<'ok' | 'no' | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [safetyOff, setSafetyOff] = useState(false);
  const now = useNow(1000);
  const active = useRef(true);
  const visible = useChatVisible();
  const visibility = useRef(visible);
  const generation = useRef(0);
  useLayoutEffect(() => {
    visibility.current = visible;
    if (!visible) generation.current += 1;
  }, [visible]);
  const reachable = useRef(snapshot(sheet.serverId).reachable);
  const inFlight = useRef(false);
  // While the huella is asked or the decision is on its way, closing would lose the result.
  const close = () => { if (!busy) closeApproval(); };
  const onBack = useEffectEvent(() => {
    if (!visibility.current) return false;
    close();
    return true;
  });
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => subscription.remove();
  }, []);
  const drop = useSharedValue(0);
  const grip = Gesture.Pan().withTestId('approval-grip')
    .onUpdate(event => { drop.set(Math.max(0, event.translationY)); })
    .onEnd(event => {
      drop.set(withTiming(0, SHEET_MOTION));
      if (event.translationY > SHEET_CLOSE_DRAG) scheduleOnRN(close);
    });
  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: drop.get() }] }));
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scope = servers.find((server) => server.id === sheet.serverId);
  const scopeKey = scope ? JSON.stringify([scope.id, scope.url, scope.deviceId, scope.key]) : null;
  const latestScope = useRef(scopeKey);
  useEffect(() => { latestScope.current = scopeKey; reachable.current = snapshot(sheet.serverId).reachable; }, [scopeKey, snapshot, sheet.serverId]);
  useEffect(() => {
    active.current = true;
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') generation.current += 1; });
    return () => { subscription.remove(); };
  }, []);
  useEffect(() => {
    return () => { active.current = false; clearTimeout(closeTimer.current ?? undefined); };
  }, []);

  const a = sheet.approval;
  const deadline = approvalDeadline(a.expiresAt, sheet.clockOffsetMs);
  // The countdown ticks each second; this flips at the deadline itself, so a hold in progress stops there.
  const [lapsed, setLapsed] = useState(false);
  useEffect(() => {
    if (deadline === null) return;
    const timer = setTimeout(() => setLapsed(true), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [deadline]);
  const expired = lapsed || (deadline !== null && deadline <= now);
  // Expiry puts the seguro back on for good.
  const safe = !safetyOff || expired;
  const offersSession = a.choices.includes('session');
  const hot = a.risk != null && a.risk.level >= 4;
  const who = a.agentName.toUpperCase();

  const resolve = async (choice: ApprovalChoice) => {
    if (inFlight.current || decision || uncertain) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const currentGeneration = generation.current;
    // Expiry is read here, when sending, after the huella; never when the gesture started.
    const valid = () => active.current && visibility.current && generation.current === currentGeneration && AppState.currentState === 'active' && scopeKey !== null && latestScope.current === scopeKey
      && reachable.current !== false && (deadline === null || deadline > Date.now()) && a.choices.includes(choice);
    try {
      if (!valid()) { if (active.current) setError('Esta Aprobación ya no está disponible.'); return; }
      if (choice !== 'deny' && !(await confirmWithFingerprint('Confirmar aprobación'))) {
        if (active.current) setError('Configura una huella en los ajustes del teléfono para aprobar.');
        return;
      }
      if (!valid()) { if (active.current) setError('Esta Aprobación ya no está disponible.'); return; }
      await decide(sheet, choice);
      if (!active.current) return;
      setDecision(choice === 'deny' ? 'no' : 'ok');
      if (choice !== 'deny') onApproved(`Aprobado. ${a.agentName} continúa.`);
      closeTimer.current = setTimeout(closeApproval, 1400);
    } catch (cause) {
      if (active.current && cause instanceof RelayError && cause.code === 'decision_uncertain') { setUncertain(true); setError('DECISIÓN SIN CONFIRMAR. Relay no enviará esta elección otra vez.'); return; }
      if (active.current) setError('NO SE PUDO ENVIAR LA DECISIÓN');
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  };
  const holdDisabled = safe || busy || uncertain;
  const approved = decision === 'ok';
  const fill = deadline === null || expired ? 0 : Math.min(1, Math.max(0, (deadline - now) / Math.max(1, deadline - (a.createdAt + (sheet.clockOffsetMs ?? 0)))));
  const phone = bounds.left === 0;

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable accessibilityRole="button" accessibilityLabel="Cerrar" onPress={close} style={[StyleSheet.absoluteFill, { backgroundColor: K.sheetBackdrop }]} />
      <Animated.View accessibilityViewIsModal pointerEvents="box-none" style={[StyleSheet.absoluteFill, slide]}><View style={{
        position: 'absolute', ...bounds, bottom: 0, height: phone ? bounds.maxHeight : undefined, backgroundColor: K.background,
        borderTopLeftRadius: 24, borderTopRightRadius: 24, boxShadow: K.shadowSheet, paddingHorizontal: 12, paddingBottom: bottom,
      }}>
        <GestureDetector gesture={grip}>
          <View style={{ paddingTop: 8, paddingBottom: 12 }}>
            <View style={{ alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: K.ledOff }} />
          </View>
        </GestureDetector>
        {/* The command block sits at the bottom of a phone's full screen, and scrolls with the rest when space runs out. */}
        <ScrollView accessibilityLabel="Contenido de la Aprobación" style={{ flexGrow: phone ? 1 : 0, flexShrink: 1 }} contentContainerStyle={{ flexGrow: 1, gap: 12 }}>
          <View style={{ gap: 12, paddingHorizontal: 4 }}>
            <M s={9.5} ls={0.08} c={K.inkTertiary}>{who} · {sheet.serverName.toUpperCase()} · {relTime(a.createdAt + (sheet.clockOffsetMs ?? 0), now)}</M>
            <T s={21} w="700" ls={-0.015} c={K.ink} accessibilityRole="header">{a.agentName} quiere ejecutar</T>
          </View>

          <RecessedScreen rim radius={18} style={{ paddingHorizontal: 16, paddingVertical: 16, gap: 12 }}>
            <M s={18} w="600" c={approved ? K.okTextOnScreen : K.accent} glow={textGlow(approved ? 'rgba(111,208,140,0.75)' : 'rgba(242,154,26,0.75)')}>$ {a.command}</M>
            {approved ? <View style={{ height: 6, borderRadius: 3, backgroundColor: K.okTextOnScreen, boxShadow: ledGlow(K.okTextOnScreen) }} />
              : decision || expired ? <View style={{ height: 6, borderRadius: 3, backgroundColor: K.sweepTrackDanger }} />
              : <Sweep tone="red" />}
            {a.cwd ? <M s={9.5} c={K.onScreenLabel}>cwd {a.cwd}</M> : null}
          </RecessedScreen>

          {a.risk ? (
            <View style={{ borderRadius: 16, backgroundColor: K.field, boxShadow: K.shadowField, paddingVertical: 12, paddingHorizontal: 14, gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <M {...TYPE.label} ls={0.06} c={hot ? K.dangerText : K.accentText}>RIESGO {a.risk.level}/5</M>
                <View style={{ flexDirection: 'row', gap: 4 }}>
                  {[1, 2, 3, 4, 5].map((n) => {
                    const lit = n <= a.risk!.level;
                    const tone = hot ? K.danger : K.accent;
                    return <View key={n} style={{ width: 20, height: 7, borderRadius: 2, backgroundColor: lit ? tone : K.ledOff, boxShadow: lit ? ledGlow(tone) : undefined }} />;
                  })}
                </View>
              </View>
              <T {...TYPE.secondary} lh={1.45} c={K.inkSecondary}>{a.risk.summary}</T>
            </View>
          ) : null}

          {a.reason || a.affects ? (
            <View style={{ gap: 8, paddingHorizontal: 4 }}>
              {([['MOTIVO', a.reason], ['AFECTA', a.affects]] as const).map(([label, text]) => text ? (
                <View key={label} style={{ flexDirection: 'row', gap: 10 }}>
                  <M s={9.5} ls={0.06} c={K.inkTertiary} style={{ width: 64, paddingTop: 3 }}>{label}</M>
                  <T {...TYPE.secondary} lh={1.4} c={K.inkSecondary} style={{ flex: 1 }}>{text}</T>
                </View>
              ) : null)}
            </View>
          ) : null}

          {deadline !== null ? (
            <View style={{ gap: 10, paddingHorizontal: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 24 }}>
                <M s={9.5} ls={0.08} c={K.inkTertiary}>VENCE EN</M>
                {expired
                  ? <ExpiredChip />
                  : <M {...TYPE.reading} c={K.accentText}>{countdown(deadline - now).padStart(5, '0')}</M>}
              </View>
              <View style={{ height: 5, borderRadius: 3, backgroundColor: K.field, boxShadow: K.shadowField, overflow: 'hidden' }}>
                <View style={{ alignSelf: 'flex-end', width: `${fill * 100}%`, height: 5, backgroundColor: K.accent, boxShadow: ledGlow(K.accent) }} />
              </View>
            </View>
          ) : null}

          <View style={{ marginTop: 'auto', borderRadius: RADIUS.block, backgroundColor: K.block, boxShadow: K.shadowBlock, padding: 16, gap: 12 }}>
            <Screws />
            {decision ? (
              <View style={{ minHeight: 64, alignItems: 'center', justifyContent: 'center' }}>
                <M {...TYPE.label} ls={0.06} c={approved ? K.okText : K.dangerText}>{approved ? `APROBADO · ${who} CONTINÚA` : `RECHAZADO · ${who} NOTIFICADO`}</M>
              </View>
            ) : <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <Pressable role="switch" accessibilityLabel="Seguro" aria-checked={safe} aria-disabled={expired} disabled={expired} onPress={() => setSafetyOff((off) => !off)}
                  style={{ width: 44, height: 72, borderRadius: 12, backgroundColor: K.field, boxShadow: K.shadowField, padding: 8, justifyContent: safe ? 'flex-end' : 'flex-start' }}>
                  <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: FIXED_INK, boxShadow: '0px 2px 3px rgba(0,0,0,0.25)', alignItems: 'center', justifyContent: 'center' }}>
                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: safe ? LED_DARK : K.accent, boxShadow: safe ? undefined : ledGlow(K.accent) }} />
                  </View>
                </Pressable>
                <View style={{ flex: 1, gap: 2 }}>
                  <M {...TYPE.label} ls={0.08} c={safe ? K.inkTertiary : K.accentText}>{safe ? 'SEGURO PUESTO' : 'SEGURO QUITADO'}</M>
                  <T {...TYPE.secondary} c={K.inkSecondary}>{expired ? 'Venció. Ya no se puede aprobar.' : safe ? 'Quítalo para que la tecla de aprobar responda.' : 'Ahora la tecla de aprobar responde.'}</T>
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Keycap variant="danger" label="Rechazar" onPress={() => { void resolve('deny'); }} disabled={busy || expired || uncertain} style={{ flex: 127, height: 64 }} />
                <HoldKey primary accessibilityLabel="Aprobar" onComplete={() => { void resolve('once'); }} disabled={holdDisabled} style={{ flex: 179, height: 64 }}>
                  <T s={15} w="700" c={K.onAccent}>Aprobar · mantén</T>
                </HoldKey>
              </View>
              {offersSession ? (
                <HoldKey accessibilityLabel="Para la sesión" onComplete={() => { void resolve('session'); }} disabled={holdDisabled} style={{ height: 64 }}>
                  <T s={15} w="700" c={K.ink}>Para la sesión · mantén</T>
                </HoldKey>
              ) : null}
            </>}
            {error ? <M {...TYPE.label} c={K.dangerText}>{error}</M> : null}
            {!busy && (decision || expired || error) ? <Keycap label="Cerrar" accessibilityLabel="Cerrar la Aprobación" onPress={close} /> : null}
          </View>
        </ScrollView>
      </View></Animated.View>
    </View>
  );
}

/** «VENCIDA»: the gray chip of an Aprobación past its deadline (F-3). */
export function ExpiredChip() {
  const { K } = usePalette();
  return <View style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: RADIUS.chip, backgroundColor: K.field }}>
    <M {...TYPE.label} c={K.inkTertiary}>VENCIDA</M>
  </View>;
}
