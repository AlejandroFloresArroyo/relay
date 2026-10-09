import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { AppUpdateManifest } from '../../../protocol/appUpdate';
import { AppUpdateDownload, appUpdateCompatibility, type InstalledApp } from '@/core/appUpdateSession';
import { APP_UPDATE_MESSAGES } from '@/core/appUpdate';
import { RelayError, type RelayClient } from '@/core/client';
import { classifyConnectionError, type ConnectionDiagnosis } from '@/core/connectionStatus';
import { apkNative } from '@/native/appUpdate';
import { DEMO, useApp } from './app';
import { demoAppUpdateNative } from '@/core/demoAppUpdate';
import { useChatVisible } from './chatVisibility';
import { addWindowFocusListener } from './windowFocus';
const denied = new WeakMap<RelayClient, ConnectionDiagnosis>();
type Phase = 'loading' | 'ready' | 'downloading' | 'verifying' | 'verified' | 'installing' | 'handoff' | 'error';
interface Reading { client: RelayClient; stamp: string; manifest: AppUpdateManifest | null; installed: InstalledApp | null; phase: Phase; reviewed: boolean; received: number; notice: string | null }
export function useAppUpdate(serverId: string) {
  const native = useMemo(() => DEMO ? demoAppUpdateNative(serverId) : apkNative, [serverId]);
  const app = useApp(); const visible = useChatVisible(); const server = app.servers.find(entry => entry.id === serverId);
  const client = server ? app.clientFor(serverId) : null; const snap = app.snapshot(serverId);
  const [focused, setFocused] = useState(false); const [foreground, setForeground] = useState(() => AppState.currentState === 'active');
  const [windowFocused, setWindowFocused] = useState(true);
  const [revision, setRevision] = useState(0); const [reading, setReading] = useState<Reading | null>(null);
  const blocked = !!client && (denied.has(client) || snap.down?.action === 'pair');
  const presenting = visible && focused && foreground && windowFocused;
  const active = presenting && !!client && snap.reachable === true && snap.protocol?.kind === 'compatible' && !blocked;
  const [lifecycle, setLifecycle] = useState({ client, presenting, active, generation: 0 });
  if (lifecycle.client !== client || lifecycle.presenting !== presenting || lifecycle.active !== active) setLifecycle({ client, presenting, active, generation: lifecycle.generation + 1 });
  const stamp = JSON.stringify([lifecycle.generation, revision]);
  const identity = useRef<{ client: RelayClient | null; active: boolean; epoch: number }>({ client: null, active: false, epoch: 0 });
  const transfer = useRef<AppUpdateDownload | null>(null); const permission = useRef<string | null>(null);
  const request = useRef<AbortController | null>(null); const busy = useRef(false);
  const retire = useCallback(() => {
    identity.current.epoch++; identity.current.active = false;
    request.current?.abort(); request.current = null;
    transfer.current?.cancel(); transfer.current = null;
    if (permission.current) native.retire(permission.current); permission.current = null; busy.current = false;
  }, [native]);
  useLayoutEffect(() => {
    retire(); identity.current = { client, active, epoch: identity.current.epoch };
    return () => { retire(); identity.current.client = null; };
  }, [client, active, stamp, retire]);
  useFocusEffect(useCallback(() => { setFocused(true); return () => { retire(); setFocused(false); }; }, [retire, setFocused]));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') { retire(); setRevision(n => n + 1); }
      setForeground(state === 'active');
    });
    // Window blur can leave AppState active; revision survives a batched blur/focus.
    const blur = addWindowFocusListener('blur', () => {
      retire(); setRevision(n => n + 1); setWindowFocused(false);
    });
    const focus = addWindowFocusListener('focus', () => setWindowFocused(true));
    return () => { subscription.remove(); blur.remove(); focus.remove(); };
  }, [retire]);
  const capture = () => { const epoch = identity.current.epoch; return () => identity.current.epoch === epoch && identity.current.client === client && identity.current.active && !!client && !denied.has(client); };
  const denial = (error: unknown) => {
    if (!client || !(error instanceof RelayError)) return;
    const diagnosis = error.code === 'protocol_upgrade_required' ? { kind: 'known' as const, label: 'Actualiza Relay para consultar el APK.', hint: 'El Puente requiere otra versión del protocolo.', action: 'retry' as const, automaticRetry: false } : classifyConnectionError(error);
    if (diagnosis.action !== 'pair' && error.code !== 'protocol_upgrade_required') return;
    denied.set(client, diagnosis);
    if (identity.current.client === client) { retire(); setRevision(n => n + 1); }
  };
  const message = (error: unknown) => error instanceof RelayError && error.code in APP_UPDATE_MESSAGES ? APP_UPDATE_MESSAGES[error.code as keyof typeof APP_UPDATE_MESSAGES]
    : error instanceof RelayError && ['unreachable', 'timeout'].includes(error.code) ? 'Sin conexión o sin respuesta. Reintenta cuando el Puente responda.' : error instanceof RelayError && error.code === 'cancelled' ? 'Descarga cancelada. Revisa de nuevo.' : 'No se pudo preparar la actualización. Reintenta.';
  useEffect(() => {
    if (!client || !active) return;
    const current = capture(); const controller = new AbortController(); request.current = controller;
    void Promise.all([client.appUpdate(controller.signal, denial), native.info()]).then(([manifest, installed]) => {
      if (current()) setReading({ client, stamp, manifest, installed, phase: 'ready', reviewed: false, received: 0, notice: null });
    }).catch(error => { denial(error); if (current()) setReading({ client, stamp, manifest: null, installed: null, phase: 'error', reviewed: false, received: 0, notice: message(error) }); });
    return () => controller.abort();
    // Client, generation and protocol visibility define this one manual reading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, active, stamp]);
  const currentReading = active && reading?.client === client && reading.stamp === stamp ? reading : null;
  const refresh = () => { retire(); setRevision(n => n + 1); };
  const review = () => { if (capture()() && currentReading?.phase === 'ready') setReading({ ...currentReading, reviewed: true }); };
  const download = async () => {
    if (busy.current || !currentReading?.reviewed || currentReading.phase !== 'ready' || currentReading.manifest?.state !== 'published' || !client) return;
    const current = capture(); if (!current()) return; busy.current = true;
    try {
      const session = new AppUpdateDownload(native, current, denial); transfer.current = session;
      setReading({ ...currentReading, phase: 'downloading', received: 0, notice: null });
      await session.download(client, currentReading.manifest, received => { if (current()) setReading(previous => previous && { ...previous, received }); },
        () => { if (current()) setReading(previous => previous && { ...previous, phase: 'verifying' }); });
      if (current()) setReading(previous => previous && { ...previous, phase: 'verified' });
    } catch (error) { denial(error); if (current()) setReading({ ...currentReading, reviewed: false, phase: 'error', notice: message(error) }); }
    finally { if (current()) busy.current = false; }
  };
  const install = async () => {
    if (busy.current || currentReading?.phase !== 'verified' || !transfer.current) return;
    const current = capture(); if (!current()) return; busy.current = true;
    const session = transfer.current; setReading({ ...currentReading, phase: 'installing' });
    try { await session.install(); if (current()) setReading({ ...currentReading, phase: 'handoff', reviewed: false }); }
    catch (error) { denial(error); if (current()) setReading({ ...currentReading, phase: 'error', reviewed: false, notice: message(error) }); }
    finally { if (current()) busy.current = false; }
  };
  const cancel = () => { const current = capture(); if (!current()) return; transfer.current?.cancel(); transfer.current = null; busy.current = false; if (currentReading) setReading({ ...currentReading, reviewed: false, phase: 'error', notice: 'Descarga cancelada. Revisa de nuevo.' }); };
  const permit = async () => {
    if (busy.current || !currentReading?.installed?.supported) return;
    const current = capture(); if (!current()) return; busy.current = true;
    try { const token = native.claim(); permission.current = token; await native.requestInstallPermission(token); if (current()) refresh(); }
    catch (error) { if (current()) setReading({ ...currentReading, phase: 'error', notice: message(error) }); }
    finally { if (current()) { if (permission.current) native.retire(permission.current); permission.current = null; busy.current = false; } }
  };
  const compatibility = currentReading?.manifest?.state === 'published' && currentReading.installed ? appUpdateCompatibility(currentReading.manifest.artifact, currentReading.installed) : null;
  return { server, presenting, active, blocked, diagnosis: client && denied.get(client) || snap.down, reading: currentReading, compatibility, refresh, review, download, install, cancel, permit };
}
