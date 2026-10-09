import type { ActivityPage, ActivityQuery } from '../../../protocol/activity';
import type { RelayClient } from '@/core/client';
interface Pending { run: () => Promise<void>; retire: () => void; deny: (error: unknown) => boolean }
interface Queue { running: boolean; blocked: boolean; next: Pending | null }
const queues = new WeakMap<RelayClient, Queue>();
/** One read and one replaceable pending query per paired client; retired queries never start. */
export function readActivity(client: RelayClient, query: ActivityQuery, current: () => boolean, onDenial: (error: unknown) => boolean): Promise<ActivityPage | undefined> {
  let queue = queues.get(client); if (!queue) { queue = { running: false, blocked: false, next: null }; queues.set(client, queue); }
  const owned = queue;
  const execute = async (task: Pending) => {
    try { await task.run(); }
    finally { const next = owned.next; owned.next = null; if (next) void execute(next); else owned.running = false; }
  };
  return new Promise((resolve, reject) => {
    const task: Pending = { retire: () => resolve(undefined), deny: onDenial, run: async () => {
      if (owned.blocked || !current()) { resolve(undefined); return; }
      try { resolve(await client.activity(query)); } catch (error) {
        // A terminal denial belongs to the client, even when its view epoch retired.
        // Retire the pending consumer before execute can drain the queue.
        if (task.deny(error)) {
          owned.blocked = true;
          const next = owned.next; owned.next = null;
          if (next) { next.deny(error); next.retire(); }
        }
        reject(error);
      }
    } };
    if (owned.running) { owned.next?.retire(); owned.next = task; }
    else { owned.running = true; void execute(task); }
  });
}
