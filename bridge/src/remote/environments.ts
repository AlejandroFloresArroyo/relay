// Environments per device on the Puente's side (ADR 0006 «Vida de un entorno» and «Revocación»).
// Ownership is the device that created it; a device only sees and controls its own, and a foreign ID
// answers like a missing one. Revocation never waits for any of this: devices.json is written first,
// every request of the device fails guardAuthorization from then on, and the reconciliation below ends
// what the revoked device left running.
import { randomBytes } from 'node:crypto';
import { REMOTE_LIMITS, REMOTE_REQUEST_ID_PATTERN } from '../../../protocol/protocol.ts';
import type { RemoteEnvironment, RemoteEnvironmentList, ToolAvailability } from '../../../protocol/protocol.ts';
import { validTerminalPath } from '../../../protocol/supervisor.ts';
import type { EnvironmentRecord, SupervisorErrorCode } from '../../../protocol/supervisor.ts';
import { exactObject } from '../changeLog.ts';
import type { ChangeRecord } from '../changeLog.ts';
import type { DeviceStore } from '../deviceStore.ts';
import type { HabitualSessions } from './habitualBrowser.ts';
import type { BrowserController, Supervisor } from './ports.ts';
import { RemoteError } from './routes.ts';
import { SupervisorRejected } from './supervisorClient.ts';

/** The `environments` contract this build serves. */
export const ENVIRONMENTS_CAPABILITY = { version: 1, minAppVersion: 1 } as const;

type Actor = ChangeRecord['actor'];
type Action = 'created' | 'terminate_requested' | 'terminated' | 'terminate_failed' | 'lost' | 'discarded';

const REJECTED: Record<SupervisorErrorCode, ConstructorParameters<typeof RemoteError>[0]> = {
  limit: 'remote_limit_reached', conflict: 'remote_conflict', alive: 'remote_conflict', not_found: 'remote_not_found',
  launch_failed: 'remote_unavailable', invalid: 'remote_invalid_request', unavailable: 'remote_unavailable',
  ended: 'remote_ended', permission: 'remote_permission_denied', unsupported: 'remote_unsupported', limited: 'remote_browser_limited',
};

/** Supervisor failures as fixed remote errors; a remote error of the Puente's own (the habitual browser) passes through. */
export function remote<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((error: unknown) => {
    if (error instanceof RemoteError) throw error;
    throw new RemoteError(error instanceof SupervisorRejected ? REJECTED[error.code] ?? 'remote_unavailable' : 'remote_unavailable');
  });
}

/** What a device sees of its own record. */
export function publicEnvironment(record: EnvironmentRecord): RemoteEnvironment {
  return {
    id: record.id, kind: record.kind, ownership: record.ownership, createdAt: record.createdAt, state: record.state,
    exitCode: record.exitCode, endedAt: record.endedAt,
    ...(record.state === 'terminating' && record.terminationError ? { terminationError: record.terminationError } : {}),
    ...(record.terminal ? { terminal: { shell: record.terminal.shell, cwd: record.terminal.cwd } } : {}),
  };
}

export interface Environments {
  availability(): Promise<ToolAvailability>;
  list(deviceId: string): Promise<RemoteEnvironmentList>;
  create(deviceId: string, actor: Actor, body: unknown, guard: () => void): Promise<RemoteEnvironment>;
  terminate(deviceId: string, actor: Actor, id: string, body: unknown, guard: () => void): Promise<RemoteEnvironment>;
  discard(deviceId: string, actor: Actor, id: string, guard: () => void): Promise<{ ok: true }>;
  /** Ends every live own environment whose device is revoked, and retries what could not be ended. */
  reconcile(): Promise<void>;
  close(): void;
}

export function createEnvironments(options: {
  supervisor: Supervisor; store: DeviceStore; now: () => number; log?: (line: string) => void; retryMs?: number;
  /** The dedicated browser, wired when this build serves the `browser` capability. */
  browser?: BrowserController | null;
  /** The habitual browser's shared connections (habitualBrowser.ts), when its extension is wired. */
  habitual?: HabitualSessions | null;
}): Environments {
  const { supervisor, store, now } = options;
  const habitual = options.habitual ?? null;
  const retryMs = options.retryMs ?? REMOTE_LIMITS.terminateRetryMs;
  /** Creations between their durable record and their last guard: those check revocation themselves. */
  const creating = new Set<string>();
  /** Terminations a device asked for that the supervisor has not confirmed. */
  const requested = new Set<string>();
  let running: Promise<void> | null = null;
  let again = false;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  async function record(actor: Actor, action: Action, id: string): Promise<void> {
    await store.changeLog.appendChange({ actor, action: `remote.environment.${action}`, target: { kind: 'environment', id } });
  }
  /** Facts the Puente only observes: their record never blocks ending anything. */
  function observe(action: Action, id: string): void {
    record({ kind: 'server' }, action, id).catch(() => options.log?.('Environment change could not be recorded.'));
  }

  async function own(deviceId: string, id: string): Promise<EnvironmentRecord> {
    const found = (await remote(supervisor.list())).find((candidate) => candidate.id === id && candidate.deviceId === deviceId);
    if (!found) throw new RemoteError('remote_not_found');
    return found;
  }

  function schedule(): void {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = undefined; void reconcile(); }, retryMs);
    timer.unref();
  }

  async function pass(): Promise<void> {
    let records: EnvironmentRecord[];
    let active: Set<string>;
    try {
      records = await supervisor.list();
      active = new Set(store.snapshot().devices.filter((device) => device.revokedAt === null).map((device) => device.id));
    } catch {
      // Unread list: the supervisor may hold environments of a revoked device.
      schedule();
      return;
    }
    const live = new Set(records.filter((candidate) => candidate.endedAt === null).map((candidate) => candidate.id));
    for (const id of requested) if (!live.has(id)) requested.delete(id);
    const ending: Promise<unknown>[] = [];
    let pending = false;
    for (const candidate of records) {
      // Shared work is only disconnected, never ended.
      if (candidate.endedAt !== null || candidate.ownership !== 'own') continue;
      if (active.has(candidate.deviceId) && !requested.has(candidate.id)) continue;
      pending = true;
      // A creation in flight checks its own owner after launching. A terminating one is asked again:
      // terminate is idempotent and serialized, and its state alone does not prove a retry exists.
      if (creating.has(candidate.id)) continue;
      if (candidate.state !== 'terminating') observe('terminate_requested', candidate.id);
      ending.push(supervisor.terminate(candidate.id).catch(() => {}));
    }
    await Promise.all(ending);
    if (pending) schedule();
  }

  function reconcile(): Promise<void> {
    if (closed) return Promise.resolve();
    if (running) { again = true; return running; }
    clearTimeout(timer);
    timer = undefined;
    running = (async () => {
      do { again = false; await pass(); } while (again && !closed);
    })().finally(() => { running = null; });
    return running;
  }

  supervisor.onConnected(() => { void reconcile(); });
  supervisor.onEvent((event) => observe(event.action, event.environmentId));
  // Every authenticated request commits through the store; only a change of the active devices
  // (a revocation, a removal) needs a reconciliation.
  const activeDevices = () => store.snapshot().devices.filter((device) => device.revokedAt === null).map((device) => device.id).sort().join();
  let active = activeDevices();
  const unsubscribe = store.subscribe(() => {
    let next: string;
    try { next = activeDevices(); } catch { next = ''; }
    if (next === active) return;
    active = next;
    void reconcile();
  });
  void reconcile();

  return {
    availability: () => supervisor.availability(),

    async list(deviceId) {
      const records = (await remote(supervisor.list())).filter((candidate) => candidate.deviceId === deviceId).map(publicEnvironment);
      return { environments: [...records, ...habitual?.list(deviceId) ?? []].sort((a, b) => a.createdAt - b.createdAt) };
    },

    async create(deviceId, actor, body, guard) {
      const kinds = ['terminal', 'browser_dedicated', 'browser_habitual'];
      const valid = typeof body === 'object' && body !== null && kinds.includes((body as Record<string, unknown>).kind as string)
        && exactObject(body, (body as Record<string, unknown>).kind === 'terminal' ? ['requestId', 'kind', 'shell', 'cwd'] : ['requestId', 'kind'])
        && typeof body.requestId === 'string' && new RegExp(REMOTE_REQUEST_ID_PATTERN).test(body.requestId);
      if (!valid) throw new RemoteError('remote_invalid_request');
      // The habitual browser is a shared connection the Puente keeps itself. A dedicated one needs a
      // browser here and a supervisor that knows browsers: an older one is never sent a kind it cannot launch.
      if (body.kind === 'browser_habitual') {
        if (!habitual) throw new RemoteError('remote_unavailable');
        return habitual.create(deviceId, actor, body.requestId as string, guard);
      }
      if (body.kind === 'browser_dedicated' && (await options.browser?.availability().catch(() => null))?.state !== 'available') {
        throw new RemoteError('remote_unavailable');
      }
      // The supervisor checks the shell is installed and the folder exists and can be entered.
      if (body.kind === 'terminal' && (!validTerminalPath(body.shell) || !validTerminalPath(body.cwd))) throw new RemoteError('remote_invalid_request');
      const id = `env_${randomBytes(16).toString('base64url')}`;
      const terminal = body.kind === 'terminal' ? { terminal: { shell: body.shell as string, cwd: body.cwd as string } } : {};
      const { environment, created } = await remote(supervisor.register({ id, deviceId, kind: body.kind as 'terminal' | 'browser_dedicated', requestId: body.requestId as string, createdAt: now(), ...terminal }));
      creating.add(environment.id);
      try {
        if (created) await record(actor, 'created', environment.id);
        // After the durable record and before launching, then again once launched: a device revoked
        // meanwhile gets its environment ended, never left running.
        const recheck = async () => {
          try { guard(); } catch (error) { await supervisor.terminate(environment.id).catch(() => {}); throw error; }
        };
        await recheck();
        const launched = environment.state === 'starting' ? await remote(supervisor.launch(environment.id)) : environment;
        await recheck();
        return publicEnvironment(launched);
      } finally {
        creating.delete(environment.id);
      }
    },

    async terminate(deviceId, actor, id, body, guard) {
      if (!exactObject(body, ['confirm']) || body.confirm !== true) throw new RemoteError('remote_confirmation_required');
      // Disconnects and keeps the habitual browser and every tab.
      if (habitual?.has(id)) return habitual.terminate(deviceId, actor, id, guard);
      const found = await own(deviceId, id);
      // Idempotent: what really happened.
      if (found.endedAt !== null) return publicEnvironment(found);
      if (found.state !== 'terminating') await record(actor, 'terminate_requested', id);
      guard();
      requested.add(id);
      try {
        const ended = await supervisor.terminate(id);
        if (ended.endedAt !== null) requested.delete(id);
        return publicEnvironment(ended);
      } catch (error) {
        if (error instanceof SupervisorRejected) throw new RemoteError(REJECTED[error.code] ?? 'remote_unavailable');
        // No answer: still terminating, retried until the supervisor confirms.
        observe('terminate_failed', id);
        schedule();
        return { ...publicEnvironment(found), state: 'terminating', endedAt: null, terminationError: 'supervisor_unreachable' };
      }
    },

    async discard(deviceId, actor, id, guard) {
      if (habitual?.has(id)) return habitual.discard(deviceId, actor, id, guard);
      const found = await own(deviceId, id);
      if (found.endedAt === null) throw new RemoteError('remote_conflict');
      guard();
      await remote(supervisor.discard(id));
      await record(actor, 'discarded', id);
      return { ok: true };
    },

    reconcile,

    close() {
      closed = true;
      clearTimeout(timer);
      unsubscribe();
      habitual?.close();
    },
  };
}
