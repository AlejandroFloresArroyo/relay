import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { BoardCard } from '../../../protocol/board';
import { canonicalBoardWebManifest } from '../../../protocol/boardWebValidation';
import { boardWebBase64 } from '@/core/boardWeb';
import { RelayError, type RelayClient } from '@/core/client';
import { boardWebNative } from '@/native/boardWeb';
import { useChatVisible } from './chatVisibility';
import { addWindowFocusListener } from './windowFocus';
import { useApp } from './app';
type Phase = 'loading' | 'ready' | 'unverified' | 'unsupported' | 'error' | 'offline' | 'retired';
export function useBoardWeb(serverId: string, client: RelayClient, card: BoardCard, available: boolean, transportOffline = false) {
  const app = useApp(), visible = useChatVisible();
  const server = app.servers.find(s => s.id === serverId), connection = app.snapshot(serverId);
  const bundleRef = card.content.type === 'web' ? card.content.bundleRef : null, revision = card.content.type === 'web' ? card.content.revision : null;
  const content = useMemo(() => bundleRef && revision ? { type: 'web' as const, bundleRef, revision } : null, [bundleRef, revision]);
  const scope = JSON.stringify([serverId, server?.url, server?.deviceId, card.agentId, card.id, content?.bundleRef, content?.revision]);
  const [focused, setFocused] = useState(false), [active, setActive] = useState(AppState.currentState === 'active'), [windowFocused, setWindowFocused] = useState(true);
  const [attempt, setAttempt] = useState(0), [retirement, setRetirement] = useState(0);
  const [result, setResult] = useState<{ scope: string; presentation: object; phase: Phase; id?: string; generation?: string; epoch?: number; message?: string } | null>(null);
  const lease = useRef<{ generation: string; controller: AbortController } | null>(null);
  const epoch = useRef(0);
  const allowed = useRef(false);
  const invalidate = useCallback(() => {
    epoch.current++;
    const old = lease.current; lease.current = null;
    if (old) { boardWebNative.retireGeneration(old.generation); old.controller.abort(); }
  }, []);
  // A monotonic render dependency survives batched blur/focus or background/active events.
  const retireForLifecycle = useCallback(() => { invalidate(); setRetirement(value => value + 1); }, [invalidate]);
  const offline = transportOffline || connection.reachable === false;
  const enabled = app.ready && !!server?.key && !!server?.deviceId && !!content && card.status !== 'error' && available && !offline && connection.down?.action !== 'pair' && (!connection.protocol || connection.protocol.kind === 'compatible') && visible && focused && active && windowFocused;
  // Results belong to this presentation only; hidden or replaced scopes cannot lend a ready view to its first commit.
  const presentation = useMemo(() => ({ scope, key: server?.key, client, enabled, attempt, retirement }), [scope, server?.key, client, enabled, attempt, retirement]);
  useLayoutEffect(() => { invalidate(); allowed.current = enabled; return invalidate; }, [presentation, enabled, invalidate]);
  useFocusEffect(useCallback(() => { setFocused(true); return () => { retireForLifecycle(); setFocused(false); }; }, [retireForLifecycle]));
  useEffect(() => {
    const change = AppState.addEventListener('change', state => { if (state !== 'active') retireForLifecycle(); setActive(state === 'active'); });
    const blur = addWindowFocusListener('blur', () => { retireForLifecycle(); setWindowFocused(false); });
    const focus = addWindowFocusListener('focus', () => setWindowFocused(true));
    return () => { change.remove(); blur.remove(); focus.remove(); invalidate(); };
  }, [invalidate, retireForLifecycle]);
  useEffect(() => {
    if (!enabled || !content) return;
    const version = epoch.current; let alive = true;
    const current = () => alive && allowed.current && epoch.current === version;
    void (async () => {
      setResult({ scope, presentation, phase: 'loading' });
      const capability = boardWebNative.capability();
      if (!current()) return;
      if (capability.state !== 'verified') {
        setResult({ scope, presentation, phase: capability.state, message: capability.state === 'unverified' ? 'Este proveedor WebView todavía no tiene aislamiento verificado.' : capability.cause === 'native_missing' ? 'Esta versión de Relay no incluye contenido web aislado para Android.' : 'No se pudo verificar el proveedor WebView de Android. Reintenta.' }); return;
      }
      if (!client.boardWeb) { setResult({ scope, presentation, phase: 'unsupported', message: 'Actualiza el Puente para ver contenido web.' }); return; }
      const generation = boardWebNative.beginGeneration(), controller = new AbortController(); lease.current = { generation, controller };
      try {
        const bundle = await client.boardWeb.bundle(card.agentId, content, controller.signal); if (!current()) return;
        const id = await boardWebNative.createSnapshot(generation, bundle.revision, canonicalBoardWebManifest(bundle.manifest)); if (!current()) return;
        for (const asset of bundle.assets) { await boardWebNative.putAsset(generation, id, asset.name, boardWebBase64(asset.bytes)); if (!current()) return; }
        const sealed = await boardWebNative.sealSnapshot(generation, id); if (!current()) return;
        setResult({ scope, presentation, phase: 'ready', id: sealed, generation, epoch: version });
      } catch (error) {
        if (!current()) return;
        invalidate(); setResult({ scope, presentation, phase: 'error', message: error instanceof RelayError && ['device_revoked', 'key_unknown', 'pairing_required', 'unauthorized'].includes(error.code) ? 'Empareja de nuevo este teléfono para leer contenido web.' : error instanceof RelayError && error.code === 'protocol_upgrade_required' ? 'Actualiza Relay y el Puente para ver contenido web.' : 'No se pudo verificar o copiar el contenido web. Reintenta.' });
      }
    })().catch(() => { if (current()) { invalidate(); setResult({ scope, presentation, phase: 'error', message: 'No se pudo preparar el contenido web aislado. Reintenta.' }); } });
    return () => { alive = false; invalidate(); };
  }, [scope, presentation, enabled, client, content, card.agentId, invalidate]);
  const displayed = result?.presentation === presentation && enabled ? result : { scope, phase: offline ? 'offline' as const : !available ? 'error' as const : 'retired' as const, message: !available ? 'Contenido web retirado porque no se pudo confirmar el Tablero actual.' : undefined };
  return { ...displayed, fail: () => { if (displayed.phase === 'ready' && result?.epoch === epoch.current && result.generation === lease.current?.generation) { invalidate(); setResult({ scope, presentation, phase: 'error', message: 'El motor Android no pudo mostrar contenido web aislado. Reintenta.' }); } }, retry: () => setAttempt(n => n + 1) };
}
