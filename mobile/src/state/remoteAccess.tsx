import { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

import { createRemoteAccess, type AccessCondition, type AccessView, type CloseReason, type EntryResult, type RemoteAccess } from '@/core/remoteAccess';
import { useApp } from './app';
import { useChatVisible } from './chatVisibility';
import { verifyRemoteEntry } from './verifyRemoteEntry';

const RemoteAccessContext = createContext<RemoteAccess | null>(null);

/**
 * Mounted by LockGate inside its visibility: it hears the lock, the hidden content and, through the
 * shared poll, a lost connection or a device that is no longer accepted (any «Empareja de nuevo»).
 */
export function RemoteAccessProvider({ locked, children }: { locked: boolean; children: ReactNode }) {
  const [access] = useState(createRemoteAccess);
  const visible = useChatVisible();
  const { servers, snapshot } = useApp();
  const conditions: Record<string, AccessCondition> = {};
  for (const server of servers) {
    const snap = snapshot(server.id);
    conditions[server.id] = { pairing: JSON.stringify([server.url, server.deviceId, server.key]), connected: snap.reachable === true, revoked: snap.down?.action === 'pair' };
  }
  const signature = JSON.stringify(conditions);
  // The lock goes first, so a lock that also hides Relay voids the verification.
  useLayoutEffect(() => { access.setLocked(locked); }, [access, locked]);
  useLayoutEffect(() => { access.setVisible(visible); }, [access, visible]);
  useLayoutEffect(() => { access.setServers(JSON.parse(signature)); }, [access, signature]);
  return <RemoteAccessContext.Provider value={access}>{children}</RemoteAccessContext.Provider>;
}

export interface ServerRemoteAccess {
  view: AccessView;
  /** null when no entry may start: Relay locked, no access, or one already verifying. */
  enter(prompt: string): Promise<EntryResult | null>;
  /** For each open channel, transfer or control; null when control is not allowed now. */
  admit(close: (reason: CloseReason) => unknown): (() => void) | null;
}

export function useRemoteAccess(serverId: string): ServerRemoteAccess {
  const access = useContext(RemoteAccessContext);
  if (!access) throw new Error('useRemoteAccess outside LockGate');
  const snapshot = useSyncExternalStore(access.subscribe, access.snapshot);
  return {
    view: snapshot.views[serverId] ?? 'closed',
    async enter(prompt) {
      const entry = access.beginEntry(serverId);
      return entry ? entry.finish(await verifyRemoteEntry(prompt)) : null;
    },
    admit: (close) => access.admit(serverId, close),
  };
}

/** Whether the tools of a Servidor are entered; false, without throwing, where no LockGate holds the entry (the tab bar's question). */
export function useToolsOpen(serverId: string | null): boolean {
  const access = useContext(RemoteAccessContext);
  return useSyncExternalStore(access?.subscribe ?? noSubscribe, () => access !== null && serverId !== null && access.snapshot().views[serverId] === 'open');
}
const noSubscribe = () => () => {};
