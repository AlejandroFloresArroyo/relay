export interface NotificationCacheIO { read(scope: string): Promise<string | null>; write(scope: string, value: string): Promise<void>; remove(scope: string): Promise<void> }
/** Serialize writes and retire a scope permanently before any pending storage operation resumes. */
export function createNotificationCache(io: NotificationCacheIO) {
  const retired = new Set<string>();
  const listeners = new Set<() => void>();
  let queue: Promise<void> = Promise.resolve();
  function enqueue(operation: () => Promise<void>) { const work = queue.then(operation); queue = work.catch(() => {}); return work; }
  return {
    retired: (scope: string) => retired.has(scope),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async read(scope: string): Promise<unknown> {
      await queue;
      if (retired.has(scope)) return null;
      const raw = await io.read(scope);
      if (retired.has(scope)) return null;
      try { return raw === null ? null : JSON.parse(raw); } catch { return null; }
    },
    write(scope: string, value: unknown) {
      const raw = JSON.stringify(value);
      return enqueue(async () => {
        if (retired.has(scope)) return;
        await io.write(scope, raw);
        if (retired.has(scope)) await io.remove(scope);
      });
    },
    revoke(scope: string) {
      if (!retired.has(scope)) {
        retired.add(scope);
        for (const listener of listeners) listener();
      }
      return enqueue(() => io.remove(scope));
    },
  };
}
export function notificationCacheScope(server: {id: string; url: string; deviceId?: string}, keyIdentity: string) {
  if (!/^[a-f0-9]{64}$/.test(keyIdentity)) throw new Error('Invalid notification cache identity');
  return JSON.stringify([server.id, server.url, server.deviceId ?? null, keyIdentity]);
}
/** Pre-key-identity metadata is removed on upgrade and is never read as an authorized cache. */
export const notificationLegacyCacheScope = (server: {id: string; url: string; deviceId?: string}) => JSON.stringify([server.id, server.url, server.deviceId ?? null]);
export const notificationCacheKey = (scope: string) => 'relay.notifications.' + scope.split('').map(char => char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
