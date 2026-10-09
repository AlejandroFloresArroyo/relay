import type { ConnectionDiagnosis } from './connectionStatus.ts';

export interface PollConnection {
  id: string;
  url: string;
  key: string;
  deviceId?: string;
}

export type ConnectionPollState = ReadonlyMap<string, { connection: PollConnection; suspended: boolean }>;

const sameConnection = (a: PollConnection, b: PollConnection): boolean =>
  a.url === b.url && a.key === b.key && a.deviceId === b.deviceId;

/** Ordinary refreshes and intervals use the same plan; neither resumes a suspended server. */
export function planConnectionPolls<T extends PollConnection>(state: ConnectionPollState, servers: readonly T[]): {
  state: ConnectionPollState;
  connections: T[];
} {
  const next = new Map<string, { connection: PollConnection; suspended: boolean }>();
  const connections: T[] = [];
  for (const server of servers) {
    const old = state.get(server.id);
    const entry = old && sameConnection(old.connection, server) ? old : { connection: server, suspended: false };
    next.set(server.id, entry);
    if (!entry.suspended) connections.push(server);
  }
  return { state: next, connections };
}

export function recordConnectionPoll(state: ConnectionPollState, server: PollConnection, down: ConnectionDiagnosis | null): ConnectionPollState {
  const entry = state.get(server.id);
  if (!entry || !sameConnection(entry.connection, server)) return state;
  const next = new Map(state);
  next.set(server.id, { ...entry, suspended: down?.automaticRetry === false });
  return next;
}

/** This is called only by an explicit retry of this server, never by a general refresh. */
export function retryConnectionPoll(state: ConnectionPollState, serverId: string): ConnectionPollState {
  const entry = state.get(serverId);
  if (!entry) return state;
  const next = new Map(state);
  next.set(serverId, { ...entry, suspended: false });
  return next;
}
