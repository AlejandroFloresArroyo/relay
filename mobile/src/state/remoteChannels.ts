/** An open channel of a remote tool: a terminal's or a browser's. */
export interface Channel<S> {
  /** null: not connected, because control was refused or suspended. */
  session: S | null;
  /** Gives the admission back (#82) without closing anything else. */
  release: (() => void) | null;
  serial: number;
}
export interface Channels<S> {
  subscribe(listener: () => void): () => void;
  get(id: string): Channel<S> | null;
  set(id: string, session: S | null, release: (() => void) | null): void;
}

/** The open channels of a tool, outside React state: effects open and close them. */
export function createChannels<S>(): Channels<S> {
  const entries = new Map<string, Channel<S>>();
  const listeners = new Set<() => void>();
  let serial = 0;
  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get: (id) => entries.get(id) ?? null,
    set(id, session, release) {
      entries.set(id, { session, release, serial: ++serial });
      for (const listener of [...listeners]) listener();
    },
  };
}
