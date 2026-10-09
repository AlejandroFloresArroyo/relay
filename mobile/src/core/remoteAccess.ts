// Who may control the remote tools of each Servidor right now (docs/relay-v3.md §2, ADR 0006).
// Entering needs the system verification (fingerprint or phone code) once per Servidor, and it lasts
// until Relay locks. Locking, hiding Relay or losing the connection suspend control: every open
// access is closed as `suspended`, which disconnects and never cancels or ends work on the Servidor.
// Revocation closes them as `revoked` and allows nothing new for that Servidor until every close has
// settled. The Pausa general is deliberately not an input: it never closes the tools of the person.
// The verification is local to the phone and is never presented to the Puente as proof.

import { RemoteFailure } from './remoteClient.ts';

/** What the system verification answered. */
export type EntryOutcome = 'verified' | 'unavailable' | 'cancelled';
/** `locked`: Relay locked during the verification; `refused`: the device lost access meanwhile. */
export type EntryResult = EntryOutcome | 'locked' | 'refused';
export type CloseReason = 'suspended' | 'revoked';
export type AccessView = 'closed' | 'verifying' | 'open' | 'suspended' | 'revoked';

/** What the app knows of one paired Servidor. `pairing` changes when the device pairs again. */
export interface AccessCondition { pairing: string; connected: boolean; revoked: boolean }
export interface AccessSnapshot { views: Readonly<Record<string, AccessView>> }

type Close = (reason: CloseReason) => unknown;
export interface PendingEntry { finish(outcome: EntryOutcome): EntryResult }

export interface RemoteAccess {
  setLocked(locked: boolean): void;
  setVisible(visible: boolean): void;
  /** Every paired Servidor; one that is missing was removed and counts as revoked. */
  setServers(conditions: Readonly<Record<string, AccessCondition>>): void;
  /** Starts one system verification; null while Relay is locked, the device has no access or one is running. */
  beginEntry(server: string): PendingEntry | null;
  /**
   * Registers an open access (a channel, a transfer, a control) while control is allowed; null
   * otherwise, and nothing is registered. The returned function releases it without closing.
   */
  admit(server: string, onClose: Close): (() => void) | null;
  snapshot(): AccessSnapshot;
  subscribe(listener: () => void): () => void;
  /** Resolves once every revocation in progress has cut what it had to cut. */
  settled(): Promise<void>;
}

export function createRemoteAccess(): RemoteAccess {
  let locked = false;
  let visible = false;
  /** Bumped by every lock: an entry that started before it cannot open anything. */
  let epoch = 0;
  const conditions = new Map<string, AccessCondition>();
  /** Bumped by every revocation of a Servidor, for the same reason. */
  const generations = new Map<string, number>();
  const verified = new Set<string>();
  const verifying = new Set<string>();
  const open = new Map<string, Set<Close>>();
  const cutting = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  let current: AccessSnapshot = { views: {} };

  function view(server: string, condition: AccessCondition): AccessView {
    if (condition.revoked || cutting.has(server)) return 'revoked';
    if (verifying.has(server)) return 'verifying';
    if (!verified.has(server)) return 'closed';
    return condition.connected ? 'open' : 'suspended';
  }
  function changed(): void {
    current = { views: Object.fromEntries([...conditions].map(([server, condition]) => [server, view(server, condition)])) };
    for (const listener of listeners) listener();
  }
  function allowed(server: string): boolean {
    const condition = conditions.get(server);
    return !!condition && !locked && visible && view(server, condition) === 'open';
  }
  /** Closes now; whatever a close throws or rejects with, that access is gone. */
  function close(servers: Iterable<string>, reason: CloseReason): Promise<unknown>[] {
    const settling: Promise<unknown>[] = [];
    for (const server of [...servers]) {
      const accesses = open.get(server);
      if (!accesses) continue;
      open.delete(server);
      for (const each of accesses) {
        try { settling.push(Promise.resolve(each(reason)).catch(() => {})); } catch { /* already cut */ }
      }
    }
    return settling;
  }
  function revoke(server: string): void {
    verified.delete(server);
    generations.set(server, (generations.get(server) ?? 0) + 1);
    const settling = close([server], 'revoked');
    const previous = cutting.get(server);
    const done: Promise<void> = Promise.all([previous, ...settling]).then(() => {
      if (cutting.get(server) !== done) return;
      cutting.delete(server);
      changed();
    });
    cutting.set(server, done);
  }

  return {
    setLocked(next: boolean): void {
      if (next === locked) return;
      locked = next;
      if (locked) {
        epoch++;
        verified.clear();
        close(open.keys(), 'suspended');
      }
      changed();
    },

    setVisible(next: boolean): void {
      if (next === visible) return;
      visible = next;
      if (!visible) close(open.keys(), 'suspended');
      changed();
    },

    setServers(next: Readonly<Record<string, AccessCondition>>): void {
      for (const [server, before] of conditions) {
        const after = next[server];
        if (!after || after.pairing !== before.pairing || (after.revoked && !before.revoked)) revoke(server);
      }
      for (const [server, after] of Object.entries(next)) {
        if (!conditions.has(server) && after.revoked) revoke(server);
      }
      conditions.clear();
      for (const [server, condition] of Object.entries(next)) conditions.set(server, condition);
      for (const server of [...open.keys()]) if (!allowed(server)) close([server], 'suspended');
      changed();
    },

    beginEntry(server: string): { finish(outcome: EntryOutcome): EntryResult } | null {
      const condition = conditions.get(server);
      if (locked || !condition || verifying.has(server) || view(server, condition) === 'revoked') return null;
      const started = { epoch, generation: generations.get(server) ?? 0 };
      verifying.add(server);
      changed();
      let finished = false;
      return {
        finish(outcome) {
          if (finished) return 'refused';
          finished = true;
          verifying.delete(server);
          const now = conditions.get(server);
          const result: EntryResult = outcome !== 'verified' ? outcome
            : started.generation !== (generations.get(server) ?? 0) || !now || view(server, now) === 'revoked' ? 'refused'
              : started.epoch !== epoch ? 'locked' : 'verified';
          if (result === 'verified') verified.add(server);
          changed();
          return result;
        },
      };
    },

    admit(server: string, onClose: Close): (() => void) | null {
      if (!allowed(server)) return null;
      const accesses = open.get(server) ?? new Set<Close>();
      open.set(server, accesses);
      accesses.add(onClose);
      return () => { accesses.delete(onClose); };
    },

    snapshot: (): AccessSnapshot => current,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    settled: async (): Promise<void> => { while (cutting.size) await Promise.all(cutting.values()); },
  };
}

export type Admitted<T> = { state: 'done'; value: T } | { state: 'refused' } | { state: 'suspended' } | { state: 'revoked' };

/**
 * One control, transfer or search as one admitted access (#82). Nothing runs unless control is
 * allowed now. Once the access closes (lock, hidden Relay, lost connection, revocation) `signal`
 * aborts, `client` sends nothing more and the work's answer or error is dropped: a late result never
 * reopens a view. The access is released when the work ends.
 */
export async function runAdmitted<C, T>(admit: (close: (reason: CloseReason) => unknown) => (() => void) | null, base: () => C,
  work: (client: () => C, signal: AbortSignal) => Promise<T>): Promise<Admitted<T>> {
  const controller = new AbortController();
  let closed: CloseReason | null = null;
  const release = admit((reason) => { closed = reason; controller.abort(); });
  if (!release) return { state: 'refused' };
  const client = () => {
    if (closed) throw new RemoteFailure('not_offered');
    return base();
  };
  try {
    const value = await work(client, controller.signal);
    return closed ? { state: closed } : { state: 'done', value };
  } catch (error) {
    if (closed) return { state: closed };
    throw error;
  } finally {
    release();
  }
}


