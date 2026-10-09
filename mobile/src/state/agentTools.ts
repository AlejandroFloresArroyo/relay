import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useChatVisible } from './chatVisibility';
import type { AgentSkills, AgentTools } from '../../../protocol/agentTools';
import type { RelayClient } from '@/core/client';
import { classifyConnectionError, type ConnectionDiagnosis } from '@/core/connectionStatus';
import { DEMO, useApp } from './app';
import { load, save } from './storage';
import { isAgentSkills, isAgentTools } from '@/core/agentTools';
import { demoAgentSkills, demoAgentTools } from '@/core/demo';

interface Known { tools?: AgentTools; skills?: AgentSkills }
// Scope cached metadata to the paired client identity; re-pairing cannot inherit it.
const known = new WeakMap<RelayClient, Map<string, Known>>();
const cacheWrites = new Map<string, Promise<void>>();
function writeToolsCache(key: string, value: string): Promise<void> {
  // Revocation purges follow all writes to this scope, including those from retired readers.
  const pending = (cacheWrites.get(key) ?? Promise.resolve()).then(() => save(key, value));
  cacheWrites.set(key, pending);
  void pending.finally(() => { if (cacheWrites.get(key) === pending) cacheWrites.delete(key); }).catch(() => {});
  return pending;
}
export function useAgentTools(serverId: string, agentId: string, toolsEnabled = true) {
  const app = useApp();
  const visible = useChatVisible();
  const focused = useRef(false);
  const generation = useRef({ value: 0 });
  const shown = useRef(false);
  const server = app.servers.find((entry) => entry.id === serverId);
  const client = server ? app.clientFor(serverId) : null;
  const snapshot = app.snapshot(serverId);
  const scope = server?.deviceId ? JSON.stringify([server.id, server.url, server.deviceId, agentId]) : null;
  const storageKey = scope ? 'relay.agent-tools.' + Array.from(scope, (character) => character.codePointAt(0)!.toString(16)).join('-') : null;
  const persist = useCallback(async (value: Known) => { if (storageKey) await writeToolsCache(storageKey, JSON.stringify(value)); }, [storageKey]);
  const [reading, setReading] = useState<{ client: RelayClient | null; serverId: string; agentId: string; data: Known } | null>(null);
  const sameReading = reading?.client === client && reading.serverId === serverId && reading.agentId === agentId;
  const [readDiagnosis, setReadDiagnosis] = useState<ConnectionDiagnosis | null>(null);
  const diagnosis = readDiagnosis?.action === 'pair' ? readDiagnosis : snapshot.down?.kind === 'known' ? snapshot.down : readDiagnosis ?? (snapshot.reachable === false ? snapshot.down ?? classifyConnectionError(null) : null);
  const connectionRejected = snapshot.down?.action === 'pair';
  const rejected = diagnosis?.action === 'pair';
  const data = sameReading && !rejected ? reading.data : {};
  const setData = useCallback((value: Known) => setReading({ client, serverId, agentId, data: value }), [client, serverId, agentId]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const identity = useRef<{ client: RelayClient | null; serverId: string; agentId: string }>({ client, serverId, agentId });
  const [skillsFailed, setSkillsFailed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const active = useRef(false);
  const connected = snapshot.reachable === true;
  const readOnly = rejected || !connected || failed || loading || snapshot.protocol?.kind !== 'compatible';
  const writable = toolsEnabled && !readOnly;
  const writableRef = useRef(writable);
  useLayoutEffect(() => {
    const epoch = generation.current;
    writableRef.current = writable;
    shown.current = visible && focused.current && AppState.currentState === 'active';
    epoch.value++;
    return () => { shown.current = false; epoch.value++; };
  }, [client, serverId, agentId, writable, visible]);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    shown.current = visible && AppState.currentState === 'active';
    return () => { focused.current = false; shown.current = false; generation.current.value++; };
  }, [visible]));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', status => {
      if (status !== 'active') { shown.current = false; generation.current.value++; }
      else shown.current = visible && focused.current;
    });
    return () => subscription.remove();
  }, [visible]);
  useEffect(() => {
    active.current = true; identity.current = { client, serverId, agentId }; let cancelled = false;
    if (connectionRejected) {
      void Promise.resolve().then(() => {
        if (cancelled) return;
        setData({}); setLoading(false); setFailed(true);
      });
      if (client) known.get(client)?.delete(agentId);
      if (storageKey) void writeToolsCache(storageKey, '{}');
      return () => { cancelled = true; active.current = false; };
    }
    let previous = client ? known.get(client)?.get(agentId) : undefined;
    void (async () => {
      if (!previous && storageKey) {
        await cacheWrites.get(storageKey);
        const stored = await load(storageKey);
        try {
          const parsed: unknown = stored && stored.length <= 2_000_000 ? JSON.parse(stored) : null;
          if (parsed && typeof parsed === 'object') {
            const candidate = parsed as Known;
            previous = { ...(isAgentTools(candidate.tools) ? { tools: candidate.tools } : {}), ...(isAgentSkills(candidate.skills) ? { skills: candidate.skills } : {}) };
          }
        } catch { /* An invalid cache cannot enable writes. */ }
      }
      if (!previous && DEMO && serverId === 'homelab') {
        const at = Date.now() - 9 * 60 * 60 * 1000;
        previous = { tools: demoAgentTools(at), skills: demoAgentSkills(at) };
      }
      await Promise.resolve();
      if (cancelled) return;
      setData(previous ?? {}); setLoading(true); setFailed(false); setSkillsFailed(false); setError(null); setReadDiagnosis(null);
      if (!client) { setLoading(false); return; }
      const observe = async <T,>(request: Promise<T> | undefined) => {
        try { return await request; }
        catch (failure) {
          const cause = classifyConnectionError(failure);
          if (!cancelled && cause.action === 'pair') {
            setReadDiagnosis(cause); setData({}); setFailed(true); setLoading(false);
            known.get(client)?.delete(agentId); await persist({});
          }
          throw failure;
        }
      };
      const results = await Promise.allSettled([observe(toolsEnabled ? client.agentTools?.(agentId) : undefined), observe(client.agentSkills?.(agentId))]);
      if (cancelled) return;
      const diagnoses = results.flatMap(result => result.status === 'rejected' ? [classifyConnectionError(result.reason)] : []);
      const cause = diagnoses.find(value => value.action === 'pair') ?? diagnoses.find(value => value.kind === 'known') ?? (results[toolsEnabled ? 0 : 1].status === 'rejected' ? diagnoses[0] : null) ?? null;
      setReadDiagnosis(cause);
      if (cause?.action === 'pair') {
        known.get(client)?.delete(agentId); setData({}); setFailed(true); setSkillsFailed(true); setLoading(false);
        await persist({}); return;
      }
      const next = { ...previous };
      if (results[0].status === 'fulfilled' && isAgentTools(results[0].value)) next.tools = results[0].value;
      if (results[1].status === 'fulfilled' && isAgentSkills(results[1].value)) next.skills = results[1].value;
      let records = known.get(client); if (!records) { records = new Map(); known.set(client, records); }
      records.set(agentId, next); setData(next);
      setFailed(toolsEnabled ? results[0].status !== 'fulfilled' || !isAgentTools(results[0].value) : results[1].status !== 'fulfilled' || !isAgentSkills(results[1].value));
      setSkillsFailed(results[1].status !== 'fulfilled' || !isAgentSkills(results[1].value)); setLoading(false);
      await persist(next);
    })();
    return () => { cancelled = true; active.current = false; };
  }, [client, agentId, revision, storageKey, serverId, toolsEnabled, connectionRejected, persist, setData]);
  useEffect(() => {
    if (!rejected) return;
    if (client) known.get(client)?.delete(agentId);
    if (storageKey) void writeToolsCache(storageKey, '{}');
  }, [rejected, client, agentId, storageKey]);
  const canWrite = useCallback(() => active.current && shown.current && writableRef.current && identity.current.client === client && identity.current.serverId === serverId && identity.current.agentId === agentId, [client, serverId, agentId]);
  // An authorization cannot survive a hidden interval, even if the screen returns before the fingerprint resolves.
  const authorizeWrite = () => {
    const started = generation.current.value;
    return () => started === generation.current.value && canWrite();
  };
  const setToolset = async (name: string, enabled: boolean) => {
    if (!canWrite() || !client?.setToolset) return false;
    const authorized = authorizeWrite();
    try {
      const tools = await client.setToolset(agentId, name, enabled);
      if (!isAgentTools(tools)) throw new Error('Invalid toolset response');
      if (!authorized()) return false;
      const next = { ...data, tools }; known.get(client)?.set(agentId, next); setData(next); await persist(next); return true;
    } catch (failure) { if (authorized()) { setFailed(true); const cause = classifyConnectionError(failure); setReadDiagnosis(cause); setError(cause.kind === 'known' ? null : 'El cambio quedó sin confirmar.'); } return false; }
  };
  return { ...data, server, agent: snapshot.agents.find((agent) => agent.id === agentId), loading, failed, skillsFailed, error,
    diagnosis, protocol: snapshot.protocol, protocolStale: snapshot.protocolStale, readOnly, writable, canWrite, authorizeWrite, setToolset, refresh: () => { app.refresh(serverId); setRevision((value) => value + 1); } };
}
