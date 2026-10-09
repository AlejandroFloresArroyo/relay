import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { DraftStore } from '@/core/sharedDrafts';
import { shareReceiver } from '@/native/externalShare';
import { discardChatImage } from '@/screens/chat/chatImageNative';
import { useApp } from './app';
const Context = createContext<DraftStore | null>(null);
export function DraftProvider({ children }: { children: ReactNode }) {
  const { servers, clientFor, snapshot, snapshotClient } = useApp();
  const store = useMemo(() => new DraftStore((image) => { void discardChatImage(image).catch(() => {}); }), []);
  useLayoutEffect(() => {
    for (const server of servers) {
      const owner = snapshotClient(server.id);
      if (owner && snapshot(server.id).down?.action === 'pair') store.retire(owner);
    }
    store.retain((target) => servers.some((server) => server.id === target.serverId)
      && clientFor(target.serverId) === target.client && !store.isRetired(target.client));
  }, [servers, clientFor, snapshot, snapshotClient, store]);
  useLayoutEffect(() => () => store.retain(() => false), [store]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useDraftStore() {
  const value = useContext(Context); if (!value) throw new Error('DraftProvider is required');
  useSyncExternalStore(value.subscribe, value.retirementSnapshot, value.retirementSnapshot);
  return value;
}
/**
 * For LockGate, which also runs without DraftProvider. Locking purges the drafts in memory with
 * their images, and the native private copies (`cacheDir/relay-share`) of the given share tokens.
 * Unlocking lets a send that was in flight at the lock keep its refused draft.
 */
export function useSharedDraftLock() {
  const store = useContext(Context);
  return useCallback(async (locked: boolean, tokens: Promise<string[]> = Promise.resolve([])) => {
    if (!locked) { store?.unlock(); return; }
    store?.purge();
    for (const token of await tokens.catch(() => [])) await shareReceiver.discard(token).catch(() => {});
  }, [store]);
}
