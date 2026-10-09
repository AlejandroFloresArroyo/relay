import { useVpnState } from './useVpnState';
import type { VpnReading } from '@/native/vpnContract';
import { fetch as expoFetch } from 'expo/fetch';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { Approval, ApprovalChoice } from '../../../protocol/protocol';
import { createPairedBridgeClient } from '@/core/bridgeClient';
import type { RelayClient } from '@/core/client';
import { pollConnection, type ConnectionSnapshot } from '@/core/connection';
import { planConnectionPolls, recordConnectionPoll, retryConnectionPoll, type ConnectionPollState } from '@/core/connectionPolling';
import { DEMO_KEY, DEMO_SERVERS, createDemoClient, demoOffline } from '@/core/demo';
import { createPairedServerStore, migratePairedServers } from '@/core/pairedServers';
import { DEFAULT_SETTINGS, loadStoredState, updateSettings, type Settings } from '@/core/settings';
import { chooseServer, SELECTED_SERVER_KEY, selectedServer } from '@/core/selectedServer';
import { load, loadServers, save, saveServers } from './storage';

export const DEMO = process.env.EXPO_PUBLIC_RELAY_DEMO === '1';

export interface ServerEntry {
  id: string;
  name: string;
  url: string;
  key: string;
  deviceId?: string;
  isDefault: boolean;
}

export type { Settings } from '@/core/settings';

export type ServerSnapshot = ConnectionSnapshot;

const EMPTY: ServerSnapshot = { connectionUrl: '', reachable: null, latencyMs: null, agents: [], approvals: [], lastContactAt: null, down: null, protocol: null, protocolStale: false, serverControl: null, health: null, healthFailedAt: null };

export interface PendingApproval {
  serverId: string;
  serverName: string;
  approval: Approval;
  clockOffsetMs?: number;
}

interface AppValue {
  ready: boolean;
  vpnReading: VpnReading;
  servers: ServerEntry[];
  addServer: (s: Omit<ServerEntry, 'id' | 'isDefault'>) => Promise<ServerEntry>;
  replaceServer: (id: string, s: Omit<ServerEntry, 'id' | 'isDefault'>) => Promise<ServerEntry>;
  assertPairingTarget: (id?: string) => void;
  removeServer: (id: string) => Promise<void>;
  setDefaultServer: (id: string) => Promise<void>;
  serverStorageError: string | null;
  clientFor: (serverId: string) => RelayClient;
  snapshot: (serverId: string) => ServerSnapshot;
  snapshotClient: (serverId: string) => RelayClient | null;
  refresh: (retryServerId?: string) => void;
  /** Refreshes and resolves once that poll has settled, for pull to refresh. */
  refreshed: () => Promise<void>;
  /** Servidor elegido (ADR 0007): what Herram., Tablero, Trabajo and Tareas show; remembered on the phone. */
  selectedServer: string | null;
  selectServer: (serverId: string) => void;
  settings: Settings;
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  pending: PendingApproval[];
  sheet: PendingApproval | null;
  openApproval: (p: PendingApproval) => void;
  closeApproval: () => void;
  autoLockSheet: boolean;
  showAutoLockSheet: (show: boolean) => void;
  lockPreview: 'locked' | 'notice' | null;
  previewLock: (state: 'locked' | 'notice' | null) => void;
  decide: (p: PendingApproval, choice: ApprovalChoice) => Promise<void>;
}

const AppContext = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const v = useContext(AppContext);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

const SERVERS_KEY = 'relay.servers.v1';
const SETTINGS_KEY = 'relay.settings.v1';
const POLL_MS = 5000;
let serverSequence = 0;

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(DEMO);
  const [servers, setServers] = useState<ServerEntry[]>(DEMO ? DEMO_SERVERS.map((s) => ({ ...s, key: DEMO_KEY })) : []);
  const [serverStorageError, setServerStorageError] = useState<string | null>(null);
  const serverStore = useRef<ReturnType<typeof createPairedServerStore> | null>(null);
  const makeServerStore = useCallback((initial: ServerEntry[]) => createPairedServerStore({
    initial, write: (raw) => DEMO ? Promise.resolve() : saveServers(SERVERS_KEY, raw),
    newId: () => `srv-${Date.now().toString(36)}-${++serverSequence}`,
    onChange: (entries) => { setServers(entries); setServerStorageError(null); },
    onRemove: (id) => { clients.current.delete(id); },
  }), []);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [snaps, setSnaps] = useState<Record<string, ServerSnapshot>>({});
  const snapshots = useRef(snaps);
  // Snapshot ownership is local state, never part of the wire contract.
  const snapshotClients = useRef(new WeakMap<ServerSnapshot, RelayClient>());
  const pollState = useRef<ConnectionPollState>(new Map());
  useEffect(() => { snapshots.current = snaps; }, [snaps]);
  const [sheet, setSheet] = useState<PendingApproval | null>(null);
  const [autoLockSheet, showAutoLockSheet] = useState(false);
  const [lockPreview, previewLock] = useState<'locked' | 'notice' | null>(null);
  const [tick, setTick] = useState(0);
  // Callers of `refresh` waiting for the next poll to settle.
  const refreshWaiters = useRef<(() => void)[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const savedSelection = useRef<string | null>(null);

  const vpnScope = useMemo(() => ({ servers, selected, tick }), [servers, selected, tick]);
  const vpnReading = useVpnState(vpnScope, ready && !DEMO);

  useEffect(() => {
    if (DEMO) {
      serverStore.current = makeServerStore(DEMO_SERVERS.map((s) => ({ ...s, key: DEMO_KEY })));
      return;
    }
    let alive = true;
    (async () => {
      const [serverResult, rawSettings, storedSelection] = await Promise.all([loadServers(SERVERS_KEY).then((raw) => ({ raw }), () => ({ error: true })), load(SETTINGS_KEY), load(SELECTED_SERVER_KEY)]);
      if (!alive) return;
      const rawServers = 'raw' in serverResult ? serverResult.raw : null;
      const loaded = loadStoredState<ServerEntry>(rawServers, rawSettings);
      setSettings(loaded.settings);
      setSelected(storedSelection);
      savedSelection.current = storedSelection;
      try {
        if ('error' in serverResult) throw new Error('Server storage unavailable');
        const migrated = migratePairedServers(JSON.stringify(loaded.servers));
        serverStore.current = makeServerStore(migrated.servers);
        setServers(migrated.servers);
        if (migrated.invalidCount) setServerStorageError('Se conservaron los Servidores válidos; hay entradas dañadas en el almacenamiento.');
        if (migrated.changed) await saveServers(SERVERS_KEY, JSON.stringify(migrated.servers));
      } catch {
        if (alive) setServerStorageError('El llavero de Servidores no se pudo leer ni actualizar. Vuelve a abrir Relay para reintentar.');
      }
      if (!alive) return;
      setReady(true);
    })();
    return () => { alive = false; };
  }, [makeServerStore]);

  const clients = useRef(new Map<string, { sig: string; client: RelayClient }>());
  const clientFor = useCallback(
    (serverId: string): RelayClient => {
      const s = servers.find((x) => x.id === serverId);
      const sig = s ? JSON.stringify([s.url, s.deviceId, s.key]) : 'missing';
      const cached = clients.current.get(serverId);
      if (cached && cached.sig === sig) return cached.client;
      const client = DEMO
        ? createDemoClient(serverId)
        : createPairedBridgeClient({ baseUrl: s?.url ?? '', key: s?.key ?? '', deviceId: s?.deviceId, fetch: expoFetch as unknown as typeof fetch });
      clients.current.set(serverId, { sig, client });
      return client;
    },
    [servers],
  );

  // One poll loop for everything the tab screens share: agents and the approvals inbox.
  useEffect(() => {
    if (!ready || servers.length === 0) { for (const done of refreshWaiters.current.splice(0)) done(); return; }
    let alive = true;
    const inFlight = new Set<string>();
    const pollOne = async (s: ServerEntry) => {
      if (inFlight.has(s.id)) return;
      inFlight.add(s.id);
      const client = clientFor(s.id);
      const next = await pollConnection(client, s.url, snapshots.current[s.id]);
      inFlight.delete(s.id);
      if (!alive) return;
      pollState.current = recordConnectionPoll(pollState.current, s, next.down);
      const cached = DEMO && next.reachable === false ? demoOffline(s.id, Date.now()) : null;
      if (!next.agents.length && cached) {
        next.agents = cached.agents;
        next.lastContactAt ??= cached.lastContactAt;
      }
      if (DEMO && next.reachable) next.latencyMs = 42;
      snapshotClients.current.set(next, client);
      snapshots.current = { ...snapshots.current, [s.id]: next };
      setSnaps((prev) => ({ ...prev, [s.id]: next }));
    };
    const pollAll = () => {
      const waiters = refreshWaiters.current.splice(0);
      const plan = planConnectionPolls(pollState.current, servers);
      pollState.current = plan.state;
      void Promise.allSettled(plan.connections.map(pollOne)).then(() => { for (const done of waiters) done(); });
    };
    pollAll();
    const timer = setInterval(pollAll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [ready, servers, clientFor, tick]);

  const refresh = useCallback((retryServerId?: string) => {
    if (retryServerId) pollState.current = retryConnectionPoll(pollState.current, retryServerId);
    setTick((t) => t + 1);
  }, []);
  const refreshed = useCallback(() => new Promise<void>((done) => { refreshWaiters.current.push(done); refresh(); }), [refresh]);

  const requireServerStore = useCallback(() => {
    if (!serverStore.current) throw new Error('Server storage unavailable');
    return serverStore.current;
  }, []);
  const addServer = useCallback((input: Omit<ServerEntry, 'id' | 'isDefault'>) => requireServerStore().add(input), [requireServerStore]);
  const replaceServer = useCallback((id: string, input: Omit<ServerEntry, 'id' | 'isDefault'>) => requireServerStore().replace(id, input), [requireServerStore]);
  const assertPairingTarget = useCallback((id?: string) => requireServerStore().assertPairingTarget(id), [requireServerStore]);
  const removeServer = useCallback((id: string) => requireServerStore().remove(id), [requireServerStore]);
  const setDefaultServer = useCallback((id: string) => requireServerStore().setDefault(id), [requireServerStore]);

  const setSetting = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => updateSettings(prev, key, value, DEMO ? undefined : save));
  }, []);

  const selectServer = useCallback((id: string) => {
    const next = chooseServer(servers, selected, id);
    if (next !== null) setSelected(next);
  }, [servers, selected]);
  // The effective selection (the default the first time, or the fallback for a removed one) becomes
  // the stored one, so a later change of default never moves it.
  const effectiveSelection = selectedServer(servers, selected);
  if (ready && effectiveSelection !== null && effectiveSelection !== selected) setSelected(effectiveSelection);
  useEffect(() => {
    if (!ready || DEMO || selected === null || selected !== effectiveSelection || selected === savedSelection.current) return;
    savedSelection.current = selected;
    void save(SELECTED_SERVER_KEY, selected);
  }, [ready, selected, effectiveSelection]);

  const pending = useMemo<PendingApproval[]>(
    () => servers.flatMap((s) => (snaps[s.id]?.approvals ?? []).map((approval) => ({ serverId: s.id, serverName: s.name, approval, clockOffsetMs: snaps[s.id]?.approvalClockOffsetMs ?? 0 }))),
    [servers, snaps],
  );

  const decide = useCallback(
    async (p: PendingApproval, choice: ApprovalChoice) => {
      await clientFor(p.serverId).decide(p.approval.id, choice);
      refresh();
    },
    [clientFor, refresh],
  );

  const value = useMemo<AppValue>(
    () => ({
      ready,
      vpnReading,
      servers,
      addServer,
      replaceServer,
      assertPairingTarget,
      removeServer,
      setDefaultServer,
      serverStorageError,
      clientFor,
      snapshot: (id) => snaps[id] && snaps[id].connectionUrl === servers.find((s) => s.id === id)?.url ? snaps[id] : EMPTY,
      snapshotClient: (id) => snapshotClients.current.get(snaps[id]) ?? null,
      refresh,
      refreshed,
      selectedServer: effectiveSelection,
      selectServer,
      settings,
      setSetting,
      pending,
      sheet,
      openApproval: (p) => setSheet({ ...p, clockOffsetMs: p.clockOffsetMs ?? snaps[p.serverId]?.approvalClockOffsetMs ?? 0 }),
      closeApproval: () => setSheet(null),
      decide,
      autoLockSheet,
      showAutoLockSheet,
      lockPreview,
      previewLock,
    }),
    [ready, vpnReading, servers, addServer, replaceServer, assertPairingTarget, removeServer, setDefaultServer, serverStorageError, clientFor, snaps, refresh, refreshed, effectiveSelection, selectServer, settings, setSetting, pending, sheet, decide, lockPreview, autoLockSheet],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/** Polls `fn` while mounted. `data` keeps the last good value across errors. */
export function usePoll<T>(fn: () => Promise<T>, deps: unknown[], intervalMs: number | null = null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  const waiting = useRef<(() => void)[]>([]);
  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    let alive = true;
    const run = () =>
      fnRef.current().then(
        (d) => {
          if (alive) {
            setData(d);
            setError(null);
          }
        },
        (e) => {
          if (alive) setError(e);
        },
      ).finally(() => {
        if (alive) for (const done of waiting.current.splice(0)) done();
      });
    void run();
    const timer = intervalMs ? setInterval(run, intervalMs) : null;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  /** Reloads and resolves once that load has settled, for pull to refresh. */
  const reloaded = useCallback(() => new Promise<void>((done) => { waiting.current.push(done); reload(); }), [reload]);
  return { data, error, reload, reloaded, setData };
}

/**
 * The current time as state. Reading Date.now() during render is not an option here: the React
 * Compiler memoizes it like any other pure expression and the label would never move.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
