import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { AgentMemory, AgentSoul } from '../../../protocol/agentMemory';
import { AGENT_MEMORY_MESSAGES } from '../../../protocol/agentMemory';
import { agentMemoryCacheKey, isAgentMemory, isAgentSoul } from '@/core/agentMemory';
import { RelayError, type RelayClient } from '@/core/client';
import { DEMO, useApp } from './app';
import { demoAgentDocuments, demoMemoryScenario } from '@/core/demoMemory';
import { useChatVisible } from './chatVisibility';
import { addWindowFocusListener } from './windowFocus';
import { load, save } from './storage';

type Document = AgentMemory | AgentSoul;
export function useAgentDocument<T extends Document>(serverId: string, agentId: string, kind: 'memory' | 'soul') {
  const { ready, servers, clientFor, snapshot } = useApp();
  const visible = useChatVisible();
  const server = servers.find(s => s.id === serverId);
  const serverExists = !!server;
  const connection = snapshot(serverId);
  const [demoScenario, setDemoScenario] = useState(() => demoMemoryScenario());
  const scope = JSON.stringify([serverId, server?.url, server?.deviceId, agentId, DEMO ? demoScenario : null]);
  const credential = server?.key;
  const cacheKey = agentMemoryCacheKey(scope, kind);
  const [stored, setStored] = useState<{ scope: string; data: T; cached: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [revokedIdentity, setRevokedIdentity] = useState<string | null>(null);
  const identity = JSON.stringify([scope, credential]);
  const revoked = revokedIdentity === identity || connection.down?.action === 'pair';
  const epoch = useRef({ value: 0 });
  const mounted = useRef(false);
  const focused = useRef(false);
  const active = useRef(AppState.currentState === 'active');
  const [presentationFocused, setPresentationFocused] = useState(false);
  const [presentationActive, setPresentationActive] = useState(AppState.currentState === 'active');
  const [windowFocused, setWindowFocused] = useState(true);
  const pending = useRef(false);
  const allowed = useRef(false);
  const protocolBlocked = !!connection.protocol && connection.protocol.kind !== 'compatible';
  const offline = connection.reachable === false;
  const available = ready && !!server?.deviceId && !!credential && !revoked && !offline && !protocolBlocked && visible;
  const data = stored?.scope === scope && !revoked && !!server ? stored.data : null;
  const cached = stored?.scope === scope && stored.cached;
  const readOnly = !available || !data || !!cached || loading;

  useLayoutEffect(() => {
    mounted.current = true;
    const generation = epoch.current;
    return () => { mounted.current = false; generation.value++; allowed.current = false; };
  }, []);
  useLayoutEffect(() => {
    epoch.current.value++;
    allowed.current = available;
  }, [available, scope, credential]);
  useFocusEffect(useCallback(() => {
    focused.current = true; setPresentationFocused(true);
    return () => { focused.current = false; setPresentationFocused(false); epoch.current.value++; };
  }, []));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      active.current = state === 'active'; setPresentationActive(active.current);
      if (!active.current) epoch.current.value++;
    });
    const blur = addWindowFocusListener('blur', () => { epoch.current.value++; setWindowFocused(false); });
    const focus = addWindowFocusListener('focus', () => { setWindowFocused(true); });
    return () => { subscription.remove(); blur.remove(); focus.remove(); };
  }, []);
  const valid = useCallback((generation: number) => mounted.current && focused.current && active.current && allowed.current && epoch.current.value === generation, []);
  const validate = useCallback((value: unknown): value is T => kind === 'memory' ? isAgentMemory(value, agentId) : isAgentSoul(value, agentId), [kind, agentId]);
  const keep = useCallback(async (value: T, generation: number) => {
    if (!valid(generation)) return;
    setStored({ scope, data: value, cached: false });
    await save(cacheKey, JSON.stringify(value));
  }, [valid, scope, cacheKey, setStored]);

  useEffect(() => {
    if (!ready || !serverExists) return;
    let alive = true;
    const generation = epoch.current.value;
    void (async () => {
      await Promise.resolve();
      if (!alive) return;
      setLoading(true);
      if (available) setError(null);
      const demoCache = DEMO && demoScenario === 'offline_cached' ? demoAgentDocuments(serverId, agentId, Date.now())[kind] : null;
      const raw = demoCache ? JSON.stringify(demoCache) : await load(cacheKey);
      if (!alive) return;
      if (raw) {
        try {
          const value: unknown = JSON.parse(raw);
          if (validate(value)) setStored(previous => previous?.scope === scope && !previous.cached ? previous : { scope, data: value, cached: true });
        } catch { /* A damaged cache never becomes an editable snapshot. */ }
      }
      if (!available) { setLoading(false); return; }
      try {
        const client = clientFor(serverId);
        const value = kind === 'memory' ? await client.agentMemory(agentId) : await client.agentSoul(agentId);
        if (alive && valid(generation) && validate(value)) await keep(value, generation);
      } catch (failure) {
        if (!alive || !valid(generation)) return;
        if (failure instanceof RelayError && ['device_revoked', 'unauthorized', 'key_unknown', 'pairing_required'].includes(failure.code)) {
          setRevokedIdentity(identity); setStored(null); allowed.current = false; epoch.current.value++;
        }
        setError(failure instanceof RelayError ? failure.message : AGENT_MEMORY_MESSAGES.agent_memory_unavailable);
        setStored(previous => previous?.scope === scope ? { ...previous, cached: true } : previous);
      } finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [ready, serverExists, available, scope, cacheKey, retry, kind, agentId, serverId, identity, demoScenario, clientFor, validate, valid, keep]);

  async function write(operation: (client: RelayClient, current: T, guard: () => boolean) => Promise<T | null>): Promise<boolean> {
    if (pending.current || readOnly || !data) return false;
    pending.current = true; setBusy(true); setError(null);
    const generation = epoch.current.value;
    try {
      if (!valid(generation)) return false;
      const result = await operation(clientFor(serverId), data, () => valid(generation));
      if (!result || !valid(generation)) return false;
      if (!validate(result)) throw new RelayError('agent_memory_unavailable', AGENT_MEMORY_MESSAGES.agent_memory_unavailable);
      await keep(result, generation);
      return valid(generation);
    } catch (failure) {
      if (valid(generation)) {
        if (failure instanceof RelayError && ['device_revoked', 'unauthorized', 'key_unknown', 'pairing_required'].includes(failure.code)) {
          setRevokedIdentity(identity); setStored(null); allowed.current = false; epoch.current.value++;
        }
        setError(failure instanceof RelayError ? failure.message : AGENT_MEMORY_MESSAGES.agent_memory_uncertain);
        // A failed write needs a fresh server snapshot before the next attempt.
        setStored(previous => previous ? { ...previous, cached: true } : previous);
      }
      return false;
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return { visible: visible && presentationFocused && presentationActive && windowFocused, scope, data, server, connection, loading: serverExists && loading, busy, error: !serverExists ? 'Este Servidor ya no está disponible.' : error, readOnly, cached, offline: offline || error === 'Sin respuesta del Servidor.', revoked, write,
    reload: () => { if (!pending.current) { setError(null); if (DEMO) setDemoScenario(demoMemoryScenario()); setRetry(n => n + 1); } } };
}
