import { usePalette } from '@/theme/ThemeProvider';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { fetch as expoFetch } from 'expo/fetch';
import { useFocusEffect } from 'expo-router';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, ScrollView, TextInput, View } from 'react-native';

import { RelayError } from '@/core/client';
import { DEMO_PAIRING_RESPONSE, DEMO_PAIRING_STATES, demoPairingFetch } from '@/core/demo';
import { DEMO_PAIRING_ADDRESS, DEMO_PAIRING_CODE, DEMO_PAIRING_QR } from '@/core/demoPairing';
import { createHttpPairingFlow, describePairingFailure, formatPairingCode, PairingError, parsePairingQr, type PairingFlowState } from '@/core/pairing';
import { DEMO, useApp } from '@/state/app';
import { goToTab, useReturn } from '@/state/navigation';
import { F, RADIUS, TEXT_GLOW, TYPE } from '@/theme/tokens';
import { StatusBarSpace } from '@/ui/chrome';
import { DetailHeader } from '@/ui/headers';
import { PaneTopContext } from '@/ui/layoutContext';
import { Keycap, Lamp } from '@/ui/kit';
import { RecessedScreen } from '@/ui/machinery';
import { M, T } from '@/ui/primitives';
import { PairingSuccess } from './PairingSuccess';

type Mode = 'intro' | 'scan' | 'manual';
type DemoState = typeof DEMO_PAIRING_STATES[number]['id'];

export function ConnectScreen({ serverId, discoveredUrl }: { serverId?: string; discoveredUrl?: string }) {
  const { K } = usePalette();
  const { servers, addServer, replaceServer, assertPairingTarget, clientFor, ready } = useApp();
  const paneTop = useContext(PaneTopContext);
  const existing = servers.find((s) => s.id === serverId);
  const [mode, setMode] = useState<Mode>(discoveredUrl ? 'manual' : 'intro');
  const [url, setUrl] = useState(existing?.url ?? discoveredUrl ?? (DEMO ? DEMO_PAIRING_ADDRESS : ''));
  const [code, setCode] = useState(DEMO ? DEMO_PAIRING_CODE : '');
  const [flowState, setFlowState] = useState<PairingFlowState>({ kind: 'idle' });
  const [localError, setLocalError] = useState<ReturnType<typeof describePairingFailure> | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraFailed, setCameraFailed] = useState(false);
  const [demoState, setDemoState] = useState<DemoState | null>(null);
  const [tailscaleFallback, setTailscaleFallback] = useState(false);
  const flow = useRef<ReturnType<typeof createHttpPairingFlow> | null>(null);
  useFocusEffect(useCallback(() => { setCameraActive(true); return () => { setCameraActive(false); }; }, []));
  const back = useReturn();
  useEffect(() => {
    let active = true;
    flow.current = createHttpPairingFlow({
      beforeExchange: () => assertPairingTarget(serverId),
      fetch: DEMO ? demoPairingFetch : expoFetch as unknown as typeof fetch,
      persist: (response, baseUrl) => {
        const input = { name: response.server.name, url: baseUrl, key: response.deviceKey, deviceId: response.device.id };
        return serverId ? replaceServer(serverId, input) : addServer(input);
      },
      onState: (state) => { if (active) setFlowState(state); },
    });
    return () => { active = false; };
  }, [addServer, replaceServer, assertPairingTarget, serverId]);
  useEffect(() => {
    if (!serverId || !ready || !existing?.deviceId || !existing.key || DEMO) return;
    let active = true;
    clientFor(serverId).server().catch((error) => {
      if (active && error instanceof RelayError && ['device_revoked', 'key_unknown', 'unauthorized'].includes(error.code)) {
        setLocalError(describePairingFailure(new PairingError(error.code === 'device_revoked' ? 'device_revoked' : 'key_unknown')));
      }
    });
    return () => { active = false; };
  }, [serverId, ready, existing?.deviceId, existing?.key, clientFor]);

  const busy = flowState.kind === 'exchanging' || flowState.kind === 'saving';
  const success = demoState === 'success' ? DEMO_PAIRING_RESPONSE : flowState.kind === 'success' ? flowState.response : null;
  const storage = demoState === 'storage' || flowState.kind === 'storage';
  const demoFailure = demoState && !['intro', 'scan', 'manual', 'success', 'permission', 'exchanging', 'saving', 'legacy'].includes(demoState)
    ? describePairingFailure(new PairingError(demoState as PairingError['code'], demoState === 'rate_limited' ? 300 : null)) : null;
  const failure = storage ? describePairingFailure(new PairingError('storage')) : demoFailure ?? localError ?? (flowState.kind === 'error' ? flowState.error : null);
  const legacy = demoState === 'legacy' || (!!existing && (!existing.deviceId || !existing.key) && !success && !failure && mode === 'intro');
  const visibleMode = demoState === 'scan' || demoState === 'permission' ? 'scan' : demoState === 'manual' ? 'manual' : demoState === 'intro' ? 'intro' : mode;
  const denied = demoState === 'permission' || cameraFailed || (!DEMO && permission?.granted !== true);
  const statusBusy = demoState === 'exchanging' || demoState === 'saving' || busy;
  const title = success ? 'Agregar Servidor' : failure ? (failure.kind === 'device_revoked' ? existing?.name ?? (DEMO ? 'atlas' : 'Servidor') : 'Emparejamiento fallido') : visibleMode === 'manual' ? 'Escribir a mano' : visibleMode === 'scan' ? 'Escanear código' : 'Agregar Servidor';
  const choose = (next: Mode) => { flow.current?.reset(); setDemoState(null); setLocalError(null); setMode(next); };
  const scan = async () => {
    choose('scan');
    setCameraFailed(false);
    if (!DEMO && !permission?.granted && permission?.canAskAgain !== false) {
      try { await requestPermission(); } catch { setCameraFailed(true); }
    }
  };
  const submit = async (address = url, value = code) => {
    setDemoState(null);
    setLocalError(null);
    await flow.current?.submit({ baseUrl: address, code: value });
  };
  const scanned = (text: string) => {
    if (busy || !['idle', 'error'].includes((flow.current?.state().kind ?? 'exchanging'))) return;
    try {
      const payload = parsePairingQr(text);
      setUrl(payload.url);
      setCode(formatPairingCode(payload.code));
      setMode('manual');
      void submit(payload.url, payload.code);
    } catch (error) { setLocalError(describePairingFailure(error)); }
  };
  const openTailscale = async () => {
    try { await Linking.openURL('tailscale://'); } catch { setTailscaleFallback(true); }
  };
  const retry = () => {
    if (storage) {
      if (demoState === 'storage') { setDemoState('success'); return; }
      void flow.current?.retrySave();
    } else void submit();
  };
  const retryNew = () => {
    if (failure?.kind === 'invalid_input') choose('manual');
    else if (failure?.kind === 'device_revoked' || failure?.kind === 'key_unknown' || failure?.kind === 'update_bridge') choose('intro');
    else { setCode(''); void scan(); }
  };
  const calm = failure?.kind === 'unreachable' || failure?.kind === 'storage';
  const shownFailure = failure ? <RecessedScreen radius={20} rim={failure.kind === 'pairing_invalid' || failure.kind === 'device_revoked'} style={{ padding: 20, gap: 12 }}>
    <View style={{ flexDirection: 'row', gap: 6 }}>{[0, 1, 2].map((i) => <Lamp key={i} size={9} onScreen tone={i === 2 && failure.kind !== 'unreachable' ? 'red' : 'off'} />)}</View>
    <M s={13} w="600" ls={0.08} c={calm ? K.onScreenBright : K.dangerTextOnScreen} glow={calm ? undefined : TEXT_GLOW.danger} accessibilityRole="header">{failure.title}</M>
    <T s={15} lh={1.45} c={K.onScreen}>{failure.kind === 'device_revoked' && existing ? `La llave de ${existing.name} ya no vale. Empareja de nuevo.` : failure.hint}</T>
    {['unreachable', 'tailnet_required', 'unavailable', 'rate_limited', 'storage'].includes(failure.kind) ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {['unreachable', 'tailnet_required'].includes(failure.kind) ? <Keycap variant="primary" label={tailscaleFallback ? 'Volver a detectar' : 'Abrir Tailscale'} onPress={tailscaleFallback ? () => { void submit(); } : () => { void openTailscale(); }} /> : null}
      <Keycap variant="screen" label="Reintentar" onPress={retry} />
    </View> : null}
  </RecessedScreen> : null;
  const field = { borderRadius: RADIUS.field, backgroundColor: K.field, boxShadow: K.shadowField, paddingHorizontal: 12, color: K.ink } as const;

  return <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={paneTop} style={{ flex: 1, backgroundColor: K.background }}>
    <StatusBarSpace />
    <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ flexGrow: 1, paddingBottom: 12, gap: 16 }}>
      {back ? <DetailHeader back={back.label} onBack={back.go} title={title} /> : <T {...TYPE.title} c={K.ink} accessibilityRole="header" style={{ paddingHorizontal: 16, paddingTop: 12 }}>{title}</T>}
      <View style={{ marginHorizontal: 12, gap: 16 }}>
        {statusBusy ? <RecessedScreen radius={20} rim style={{ padding: 20, flexDirection: 'row', alignItems: 'center', gap: 12 }}><Lamp tone="orange" size={9} onScreen /><M s={13} w="600" ls={0.08} c={K.onScreenBright}>{flowState.kind === 'saving' || demoState === 'saving' ? 'GUARDANDO LLAVE…' : 'EMPAREJANDO…'}</M></RecessedScreen>
        : success ? <PairingSuccess response={success} url={flowState.kind === 'success' ? flowState.url : DEMO_PAIRING_ADDRESS} name={existing?.name} />
        : failure ? shownFailure
        : legacy ? <RecessedScreen radius={20} rim style={{ padding: 20, gap: 12 }}><M s={13} w="600" ls={0.08} c={K.accent} glow={TEXT_GLOW.accent}>EMPAREJA ESTE TELÉFONO</M><T s={15} lh={1.45} c={K.onScreen}>{existing?.name ?? 'El Servidor'} conserva su nombre. Su llave antigua ya no se usa; genera un código nuevo con relayd pair.</T></RecessedScreen>
        : visibleMode === 'intro' ? <>
          {/* D-05: what to run on the Servidor, then what happens on this phone. */}
          <RecessedScreen radius={20} rim style={{ padding: 16, gap: 12 }}>
            <M s={9.5} ls={0.08} c={K.onScreenLabel}>PASO 1 · EN EL SERVIDOR</M>
            <T s={15} lh={1.45} c={K.onScreen}>Ejecuta <M s={13} c={K.accent} glow={TEXT_GLOW.accent}>relayd pair</M> y escanea el código que aparece.</T>
            {/* Fixed near-black in both themes: a terminal line sunk inside the recessed screen. */}
            <View style={{ minHeight: 40, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 12, backgroundColor: '#070707' }}><M s={13} c={K.onScreenBright}>$ relayd pair</M></View>
          </RecessedScreen>
          <View style={{ gap: 8, paddingHorizontal: 4 }}>
            <M {...TYPE.label} ls={0.08} c={K.inkTertiary}>PASO 2 · EN ESTE TELÉFONO</M>
            <T s={15} lh={1.45} c={K.inkSecondary}>Cada teléfono se empareja con un código de un solo uso y recibe su propia llave. No hay nada que copiar.</T>
          </View>
        </>
        : visibleMode === 'manual' ? <View style={{ gap: 16, paddingHorizontal: 4 }}>
          <View style={{ gap: 6 }}><M {...TYPE.label} c={K.inkTertiary}>DIRECCIÓN</M><TextInput accessibilityLabel="Dirección del Servidor" value={url} onChangeText={setUrl} placeholder="http://servidor.tailnet.ts.net:8650" placeholderTextColor={K.inkTertiary} autoCapitalize="none" autoCorrect={false} keyboardType="url" selectionColor={K.accent} style={[field, { height: 48, fontFamily: F.mono['400'], fontSize: 11 }]} /></View>
          <View style={{ gap: 6 }}><M {...TYPE.label} c={K.inkTertiary}>CÓDIGO</M><TextInput accessibilityLabel="Código de emparejamiento de diez caracteres" value={code} onChangeText={(value) => { try { setCode(formatPairingCode(value)); } catch { setCode(value); } }} placeholder="XXXXX-XXXXX" placeholderTextColor={K.inkTertiary} autoCapitalize="characters" autoCorrect={false} selectionColor={K.accent} style={[field, { height: 56, fontFamily: F.mono['500'], fontSize: 22, letterSpacing: 3 }]} /></View>
          <T {...TYPE.secondary} c={K.inkSecondary}>El código caduca en 5 minutos y sirve una sola vez.</T>
        </View>
        : <>
          <RecessedScreen radius={20} rim style={{ flex: 1, minHeight: 380, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
            {!DEMO && !denied && cameraActive ? <CameraView facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => scanned(data)} onMountError={() => setCameraFailed(true)} style={{ position: 'absolute', inset: 0 }} /> : null}
            {denied ? <View style={{ padding: 20, gap: 12 }}><M s={13} w="600" ls={0.08} c={K.onScreenBright}>SIN PERMISO DE CÁMARA</M><T s={15} lh={1.45} c={K.onScreen}>No se puede usar la cámara. Puedes escribir la dirección y el código a mano.</T>{permission?.canAskAgain && !DEMO ? <Keycap variant="screen" label="Permitir cámara" onPress={() => { void requestPermission().catch(() => setCameraFailed(true)); }} /> : null}<Keycap variant="screen" label="Escribir el código a mano" onPress={() => choose('manual')} /></View>
            : <><View pointerEvents="none" style={{ width: 208, height: 208 }}>{[0, 1, 2, 3].map((i) => <View key={i} style={{ position: 'absolute', width: 36, height: 36, borderColor: K.accent, boxShadow: `0px 0px 8px ${K.accent}`, ...(i < 2 ? { top: 0, borderTopWidth: 3 } : { bottom: 0, borderBottomWidth: 3 }), ...(i % 2 === 0 ? { left: 0, borderLeftWidth: 3 } : { right: 0, borderRightWidth: 3 }) }} />)}<View style={{ position: 'absolute', top: 103, left: 12, right: 12, height: 2, backgroundColor: K.accent }} /></View><M s={9.5} c={K.onScreenBright} ls={0.06} style={{ position: 'absolute', bottom: 20 }}>APUNTA AL CÓDIGO DEL SERVIDOR</M></>}
          </RecessedScreen>
          {DEMO && !denied ? <Keycap label="Simular lectura del QR" onPress={() => scanned(DEMO_PAIRING_QR)} /> : null}
        </>}
      </View>
      <View style={{ marginTop: 'auto', marginHorizontal: 12, gap: 16, paddingTop: 12 }}>
        {statusBusy ? null : success ? <Keycap variant="primary" label="Listo" onPress={() => goToTab('servers')} />
        : failure?.kind === 'server_missing' ? <Keycap variant="primary" label="Ir a Servidores" onPress={() => goToTab('servers')} />
        : failure && ['pairing_invalid', 'invalid_qr', 'bad_request', 'update_bridge', 'key_unknown', 'device_revoked', 'invalid_input'].includes(failure.kind) ? <Keycap variant="primary" onPress={retryNew}
          label={failure.kind === 'device_revoked' || failure.kind === 'key_unknown' ? 'Emparejar de nuevo' : failure.kind === 'invalid_input' ? 'Corregir datos' : 'Escanear código'} />
        : failure ? null
        : visibleMode === 'intro' || legacy ? <>
          <Keycap variant="primary" label={legacy ? 'Emparejar de nuevo' : 'Escanear código'} onPress={() => { void scan(); }} />
          <Keycap label="Escribir el código a mano" onPress={() => choose('manual')} />
        </>
        : visibleMode === 'manual' ? <Keycap variant="primary" label="Emparejar" onPress={() => { void submit(); }} disabled={!ready || !url.trim() || !code.trim()} />
        : <Keycap label="Cancelar" onPress={() => choose('intro')} />}
      </View>
      {DEMO ? <View style={{ gap: 6, paddingHorizontal: 16 }}><M {...TYPE.label} c={K.inkTertiary}>ESTADOS DE DEMOSTRACIÓN</M><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ columnGap: 12 }}>{DEMO_PAIRING_STATES.map((item) => <Keycap key={item.id} variant="link" label={item.label} onPress={() => { flow.current?.reset(); setDemoState(item.id); setLocalError(null); }} />)}</ScrollView></View> : null}
    </ScrollView>
  </KeyboardAvoidingView>;
}
