import { PairingError, validateServerAddress } from './pairing.ts';

export interface PairedServer {
  id: string;
  name: string;
  url: string;
  key: string;
  deviceId?: string;
  isDefault: boolean;
}
export type ServerCredential = Omit<PairedServer, 'id' | 'isDefault'>;

export function migratePairedServers(raw: string | null): { servers: PairedServer[]; changed: boolean; invalidCount: number } {
  const parsed: unknown = raw === null ? [] : JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Invalid server storage');
  const servers: PairedServer[] = [];
  let invalidCount = 0;
  const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  for (const entry of parsed) {
    if (!entry || !text(entry.id) || !text(entry.name) || !text(entry.url) || typeof entry.isDefault !== 'boolean' || servers.some((s) => s.id === entry.id)) {
      invalidCount++;
      continue;
    }
    const deviceId = text(entry.deviceId) ? entry.deviceId : undefined;
    let url = entry.url;
    if (deviceId) {
      try { url = validateServerAddress(url); } catch { /* Keep invalid metadata for re-pairing; the client rejects its origin locally. */ }
    }
    servers.push({ id: entry.id, name: entry.name, url, isDefault: entry.isDefault, key: deviceId && typeof entry.key === 'string' ? entry.key : '', ...(deviceId ? { deviceId } : {}) });
  }
  return { servers, changed: raw !== null && JSON.stringify(parsed) !== JSON.stringify(servers), invalidCount };
}

/** Serialize the single SecureStore value and publish only confirmed writes. */
export function createPairedServerStore({ initial, write, newId, onChange, onRemove }: { initial: PairedServer[]; write: (raw: string) => Promise<void>; newId: () => string; onChange?: (entries: PairedServer[]) => void; onRemove?: (id: string) => void }) {
  let current = initial.map((s) => ({ ...s }));
  let queue: Promise<unknown> = Promise.resolve();
  function mutate<T>(change: (entries: PairedServer[]) => { next: PairedServer[]; value: T }): Promise<T> {
    const operation = queue.then(async () => {
      const { next, value } = change(current);
      await write(JSON.stringify(next));
      current = next;
      onChange?.(next.map((s) => ({ ...s })));
      return value;
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return {
    entries: () => current.map((s) => ({ ...s })),
    assertPairingTarget: (id?: string) => {
      if (id !== undefined && !current.some((s) => s.id === id)) throw new PairingError('server_missing');
    },
    add: (input: ServerCredential) => mutate((entries) => {
      const entry = { ...input, url: validateServerAddress(input.url), id: newId(), isDefault: entries.length === 0 };
      return { next: [...entries, entry], value: entry };
    }),
    replace: (id: string, input: ServerCredential) => mutate((entries) => {
      const old = entries.find((s) => s.id === id);
      if (!old) throw new Error('Server no longer exists');
      const entry = { ...old, url: validateServerAddress(input.url), key: input.key, deviceId: input.deviceId };
      return { next: entries.map((s) => s.id === id ? entry : s), value: entry };
    }),
    remove: (id: string) => mutate((entries) => {
      const remaining = entries.filter((s) => s.id !== id);
      const next = remaining.some((s) => s.isDefault) ? remaining : remaining.map((s, i) => ({ ...s, isDefault: i === 0 }));
      return { next, value: undefined };
    }).then(() => { onRemove?.(id); }),
    setDefault: (id: string) => mutate((entries) => {
      if (!entries.some((s) => s.id === id)) throw new Error('Server no longer exists');
      return { next: entries.map((s) => ({ ...s, isDefault: s.id === id })), value: undefined };
    }),
  };
}
