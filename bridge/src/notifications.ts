import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_NOTIFICATION_PREFERENCES, NOTIFICATION_REGISTRATION_TTL_MS,
  type NotificationKind, type NotificationPreferences, type NotificationStatus,
} from '../../protocol/notifications.ts';
import { WIDGET_SIGNAL_INTERVAL_MS, type WidgetSignal } from '../../protocol/widget.ts';
import { AuthorizationError } from './auth.ts';
import { exactObject, isTimestamp, isUuid, openPrivateFile, syncStateDirectory, StateError } from './changeLog.ts';
import type { ChangeInput, StateIO } from './changeLog.ts';
import type { DeviceStore } from './deviceStore.ts';
import { HermesError } from './hermes.ts';
import type { RunManager } from './runs.ts';

export type NotificationPublisher = (endpoint: string, body: string, signal: AbortSignal) => Promise<void>;
export interface NotificationOptions {
  store: DeviceStore; runs: RunManager; origin: string | null; now: () => number;
  publish?: NotificationPublisher; io?: StateIO; observedKinds?: readonly Exclude<NotificationKind, 'approval'>[];
  /** Coalescing timer for the widget signal; an unref'd setTimeout unless a test drives the clock. */
  timer?: (ms: number, run: () => void) => () => void;
}
interface Entry {
  deviceId: string; deviceHash: string; revision: number; registrationId: string | null;
  expiresAt: number; endpoint: string | null; preferences: NotificationPreferences;
}
function invalid(): never { throw new HermesError('bad_request', 'La inscripción de Avisos no es válida.'); }
export function notificationPreferences(value: unknown): NotificationPreferences {
  if (!exactObject(value,['enabled','types','preview']) || typeof value.enabled !== 'boolean' || value.preview !== 'generic'
    || !exactObject(value.types,['approval','task','error','server']) || !Object.values(value.types).every(item => typeof item === 'boolean')) invalid();
  return structuredClone(value) as unknown as NotificationPreferences;
}
export function notificationOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:','https:'].includes(url.protocol) || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/.test(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash || value.replace(/\/$/,'') !== url.origin) invalid();
    return url.origin;
  } catch { return invalid(); }
}
export function notificationEndpoint(value: unknown, origin: string | null): string {
  if (!origin || typeof value !== 'string' || value.length > 1000) invalid();
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password || url.hash
      || !/^\/up[A-Za-z0-9_-]{8,200}$/.test(url.pathname) || (url.search !== '' && url.search !== '?up=1')
      || url.href !== value) invalid();
    return value;
  } catch { return invalid(); }
}
export class Notifications {
  private options: NotificationOptions;
  private io: StateIO;
  private file: string;
  private entries: Entry[] = [];
  private ready: Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private fatal = false;
  private delivery = new Map<string, NotificationStatus['delivery']>();
  constructor(options: NotificationOptions) {
    this.options = { ...options, origin:options.origin === null ? null : notificationOrigin(options.origin) };
    this.io = options.io ?? fs;
    this.file = path.join(options.store.directory,'notifications.json');
    this.ready = this.load();
    void this.ready.catch(() => {});
    this.unsubscribe = options.store.subscribe(() => this.onDevicesChanged());
    void this.ready.then(() => this.onDevicesChanged(),() => {});
  }
  private device(deviceId: string) {
    const device = this.options.store.snapshot().devices.find(item => item.id === deviceId && item.revokedAt === null);
    if (!device) throw new AuthorizationError('device_revoked');
    return device;
  }
  private entry(deviceId: string): Entry | undefined {
    const device = this.device(deviceId);
    return this.entries.find(item => item.deviceId === deviceId && item.deviceHash === device.keyHash);
  }
  private async load() {
    const opened = await openPrivateFile(this.file,constants.O_RDONLY,false,this.io).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!opened) return;
    try {
      if ((await opened.handle.stat()).size > 256000) throw new StateError();
      const value: unknown = JSON.parse(await opened.handle.readFile('utf8'));
      if (!exactObject(value,['schema','entries']) || value.schema !== 1 || !Array.isArray(value.entries) || value.entries.length > 256) throw new StateError();
      const ids = new Set<string>();
      for (const entry of value.entries) {
        if (!exactObject(entry,['deviceId','deviceHash','revision','registrationId','expiresAt','endpoint','preferences'])
          || !isUuid(entry.deviceId) || ids.has(entry.deviceId) || typeof entry.deviceHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.deviceHash)
          || !Number.isSafeInteger(entry.revision) || Number(entry.revision) < 1 || !isTimestamp(entry.expiresAt)
          || (entry.registrationId !== null && !isUuid(entry.registrationId))
          || ((entry.registrationId === null) !== (entry.endpoint === null))) throw new StateError();
        notificationPreferences(entry.preferences);
        if (entry.endpoint !== null) notificationEndpoint(entry.endpoint,this.options.origin);
        ids.add(entry.deviceId);
      }
      this.entries = value.entries as unknown as Entry[];
    } catch { throw new StateError(); }
    finally { await opened.handle.close(); }
  }
  private healthy() { if (this.fatal) throw new StateError(); }
  private transact<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.queue.then(async () => { await this.ready; this.healthy(); return operation(); });
    this.queue = work.then(() => {},() => {});
    return work;
  }
  private async persist(next: Entry[], actor: ChangeInput['actor'], guard: () => void, targetDeviceId?: string) {
    const directory = this.options.store.directory;
    guard();
    await this.options.store.changeLog.appendChange({ actor,action:'notification.registration.requested',target:{kind:'device',id:targetDeviceId ?? (actor.kind === 'device' ? actor.id : 'local')} });
    guard();
    const opened = await openPrivateFile(this.file,constants.O_RDONLY,false,this.io).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    let previous: Buffer | null = null;
    if (opened) { try { previous = await opened.handle.readFile(); } finally { await opened.handle.close(); } }
    guard();
    if (previous) {
      const backup = await this.io.open(path.join(directory,`notifications-version-${randomUUID()}.json`),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try { await backup.writeFile(previous); await backup.sync(); } finally { await backup.close(); }
      guard();
    }
    const temporary = path.join(directory,`.notifications.${randomUUID()}.tmp`);
    let replaced = false;
    try {
      const handle = await this.io.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try { await handle.writeFile(JSON.stringify({schema:1,entries:next})+'\n'); await handle.sync(); } finally { await handle.close(); }
      // This is the final authorization check after disk reads, immediately before replacing state.
      guard();
      await this.io.rename(temporary,this.file); replaced = true;
      await syncStateDirectory(directory,this.io);
      this.entries = next;
    } catch (error) { if (replaced) this.fatal = true; throw error; }
    finally { await this.io.unlink(temporary).catch(() => {}); }
    // Disk and memory agree; a revocation during the write is pruned like any other.
    try { guard(); } catch (error) { this.onDevicesChanged(); throw error; }
  }
  async status(deviceId: string): Promise<NotificationStatus> {
    await this.ready; await this.queue; this.healthy();
    const entry = this.entry(deviceId);
    const registered = entry?.registrationId && entry.expiresAt > this.options.now() && entry.preferences.enabled && this.options.origin !== null;
    return { schema:1,configured:this.options.origin !== null,transport:'ntfy-unifiedpush',availableKinds:['approval', ...(this.options.observedKinds ?? [])],
      preferences:structuredClone(entry?.preferences ?? DEFAULT_NOTIFICATION_PREFERENCES),revision:entry?.revision ?? 0,
      registration:registered ? {id:entry.registrationId!,expiresAt:entry.expiresAt} : null,
      delivery:registered ? this.delivery.get(deviceId) ?? 'unknown' : 'disabled',serverNow:this.options.now() };
  }
  async register(deviceId: string, body: unknown, actor: ChangeInput['actor'], authorize: () => void) {
    if (!exactObject(body,['schema','revision','endpoint','preferences']) || body.schema !== 1 || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0 || Number(body.revision) >= Number.MAX_SAFE_INTEGER) invalid();
    const preferences = notificationPreferences(body.preferences);
    if (!this.options.origin) throw new HermesError('unavailable','El canal de Avisos no está configurado.');
    const endpoint = notificationEndpoint(body.endpoint,this.options.origin);
    await this.transact(async () => {
      authorize(); const device = this.device(deviceId); const old = this.entry(deviceId);
      if ((old?.revision ?? 0) !== body.revision) throw new HermesError('conflict','La inscripción de Avisos cambió. Actualiza Relay.');
      if (!old && this.entries.length >= 256) throw new HermesError('unavailable','No se admiten más inscripciones de Avisos.');
      const guard = () => { authorize(); if (this.device(deviceId).keyHash !== device.keyHash) throw new AuthorizationError('device_revoked'); };
      const next = this.entries.filter(item => item.deviceId !== deviceId);
      next.push({deviceId,deviceHash:device.keyHash,revision:Number(body.revision)+1,registrationId:preferences.enabled ? randomUUID() : null,
        expiresAt:this.options.now()+NOTIFICATION_REGISTRATION_TTL_MS,endpoint:preferences.enabled ? endpoint : null,preferences});
      this.changing.add(deviceId); this.invalidate(deviceId);
      try { await this.persist(next,actor,guard); } finally { this.changing.delete(deviceId); }
      this.delivery.delete(deviceId);
    });
    authorize(); return this.status(deviceId);
  }
  async unregister(deviceId: string, body: unknown, actor: ChangeInput['actor'], authorize: () => void) {
    if (!exactObject(body,['schema','revision']) || body.schema !== 1 || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0 || Number(body.revision) >= Number.MAX_SAFE_INTEGER) invalid();
    await this.transact(async () => {
      authorize(); const device = this.device(deviceId); const old = this.entry(deviceId);
      if ((old?.revision ?? 0) !== body.revision) throw new HermesError('conflict','La inscripción de Avisos cambió. Actualiza Relay.');
      // An absent enrollment is already disabled; keep revision zero without consuming quota.
      if (!old) return;
      const guard = () => { authorize(); if (this.device(deviceId).keyHash !== device.keyHash) throw new AuthorizationError('device_revoked'); };
      const next = this.entries.filter(item => item.deviceId !== deviceId);
      next.push({deviceId,deviceHash:device.keyHash,revision:Number(body.revision)+1,registrationId:null,expiresAt:this.options.now(),
        endpoint:null,preferences:{...(old?.preferences ?? structuredClone(DEFAULT_NOTIFICATION_PREFERENCES)),enabled:false}});
      this.changing.add(deviceId); this.invalidate(deviceId);
      try { await this.persist(next,actor,guard); } finally { this.changing.delete(deviceId); } this.delivery.delete(deviceId);
    });
    authorize(); return this.status(deviceId);
  }

  private notices = new Map<string, { deviceId:string; registrationId:string; approval:import('../../protocol/protocol.ts').Approval }>();
  private pending = new Map<string, Set<AbortController>>();
  private changing = new Set<string>();
  private pruning = new Set<string>();
  private unsubscribe: () => void = () => {};
  private invalidate(deviceId: string) {
    for (const [id,notice] of this.notices) if (notice.deviceId === deviceId) this.notices.delete(id);
    for (const controller of this.pending.get(deviceId) ?? []) controller.abort();
  }
  close() { this.closed = true; this.widgetCancel?.(); this.observations.clear(); this.unsubscribe(); for (const deviceId of this.pending.keys()) this.invalidate(deviceId); this.notices.clear(); }
  private onDevicesChanged() {
    for (const entry of this.entries) {
      if (!entry.endpoint || this.pruning.has(entry.deviceId)) continue;
      const valid = this.options.store.snapshot().devices.some(device => device.id === entry.deviceId && device.keyHash === entry.deviceHash && device.revokedAt === null);
      if (valid) continue;
      this.invalidate(entry.deviceId); this.pruning.add(entry.deviceId);
      void this.transact(async () => {
        const next = this.entries.map(item => item.deviceId === entry.deviceId ? {...item,endpoint:null,registrationId:null,revision:item.revision+1,preferences:{...item.preferences,enabled:false}} : item);
        await this.persist(next,{kind:'server'},() => {},entry.deviceId);
      }).catch(() => { this.fatal = true; }).finally(() => this.pruning.delete(entry.deviceId));
    }
  }
  private scoped(deviceId: string, registrationId: string) {
    this.healthy();
    const entry = this.entry(deviceId);
    if (!entry || entry.registrationId !== registrationId || !entry.endpoint || !entry.preferences.enabled || this.changing.has(deviceId)
      || entry.expiresAt <= this.options.now()) throw new HermesError('conflict','La inscripción de Avisos ya no está vigente.');
    return entry;
  }
  async approvalCreated(approval: import('../../protocol/protocol.ts').Approval): Promise<void> {
    await this.ready; await this.queue; this.healthy();
    if (!this.options.origin || !this.options.publish) return;
    // Bounded ephemeral references. Restart deliberately makes old notices unknown.
    for (const [id,notice] of this.notices) if (notice.approval.expiresAt !== null && notice.approval.expiresAt + 3600000 < this.options.now()) this.notices.delete(id);
    const outcomes = await Promise.allSettled(this.entries.filter(entry => entry.registrationId && entry.endpoint && entry.preferences.enabled && entry.preferences.types.approval)
      .map(async entry => {
        let current: Entry;
        try { current = this.scoped(entry.deviceId,entry.registrationId!); } catch { return; }
        if (approval.expiresAt !== null && approval.expiresAt <= this.options.now()) return;
        if (this.notices.size >= 2048) throw new HermesError('unavailable','El registro de Avisos está lleno.');
        const noticeId = randomUUID();
        const notice = {deviceId:current.deviceId,registrationId:current.registrationId!,approval:structuredClone(approval)};
        this.notices.set(noticeId,notice);
        const controller = new AbortController();
        const pending = this.pending.get(current.deviceId) ?? new Set<AbortController>();
        pending.add(controller); this.pending.set(current.deviceId,pending);
        const guard = () => {
          this.scoped(current.deviceId,current.registrationId!);
          if (controller.signal.aborted || this.notices.get(noticeId) !== notice || (approval.expiresAt !== null && approval.expiresAt <= this.options.now())) throw new HermesError('conflict','El Aviso ya no está vigente.');
        };
        try {
          guard();
          const body = JSON.stringify({schema:1,kind:'approval',noticeId,registrationId:current.registrationId,expiresAt:approval.expiresAt});
          await this.options.publish!(current.endpoint!,body,controller.signal);
          guard(); this.delivery.set(current.deviceId,'accepted');
        } catch {
          // A revoked/replaced registration cannot acquire a late successful delivery state.
          if (this.entrySafe(current.deviceId)?.registrationId === current.registrationId) this.delivery.set(current.deviceId,'failed');
          throw new HermesError('upstream','No se pudo publicar el Aviso. Reintenta.');
        } finally { pending.delete(controller); if (!pending.size) this.pending.delete(current.deviceId); }
      }));
    if (outcomes.some(result => result.status === 'rejected')) throw new HermesError('upstream','No se pudo publicar el Aviso. Reintenta.');
  }
  // Generic observations never enter the approval/action registry. A failed publication is not retried.
  private closed = false;
  private observations = new Map<string, number>();
  private observationPending = 0;
  async observed(kind: Exclude<NotificationKind, 'approval'>, identity: string, at: number, authorize: () => void = () => {}): Promise<void> {
    await this.ready; authorize();
    await this.queue; authorize(); this.healthy();
    if (this.closed || !this.options.origin || !this.options.publish || !this.options.observedKinds?.includes(kind)) return;
    const expiresAt = at + 300000;
    if (!isTimestamp(at) || at > this.options.now() || expiresAt <= this.options.now()) return;
    for (const [key, expiry] of this.observations) if (expiry <= this.options.now()) this.observations.delete(key);
    const outcomes = await Promise.allSettled(this.entries.filter(entry => entry.registrationId && entry.endpoint && entry.preferences.enabled && entry.preferences.types[kind])
      .map(async entry => {
        authorize();
        let current: Entry;
        try { current = this.scoped(entry.deviceId, entry.registrationId!); } catch { return; }
        const key = createHash('sha256').update(JSON.stringify([kind, identity, current.registrationId])).digest('hex');
        if (this.observations.has(key) || this.observations.size >= 2048) return;
        this.observations.set(key, expiresAt);
        if (this.observationPending >= 64 || (this.pending.get(current.deviceId)?.size ?? 0) >= 8) return;
        this.observationPending++;
        const controller = new AbortController();
        const pending = this.pending.get(current.deviceId) ?? new Set<AbortController>();
        pending.add(controller); this.pending.set(current.deviceId, pending);
        const guard = () => {
          authorize(); this.scoped(current.deviceId, current.registrationId!);
          if (this.closed || controller.signal.aborted || expiresAt <= this.options.now()) throw new HermesError('conflict', 'El Aviso ya no está vigente.');
        };
        try {
          guard();
          await this.options.publish!(current.endpoint!, JSON.stringify({ schema: 1, kind, noticeId: randomUUID(), registrationId: current.registrationId, expiresAt: Math.min(expiresAt, current.expiresAt) }), controller.signal);
          guard(); this.delivery.set(current.deviceId, 'accepted');
        } catch {
          if (this.entrySafe(current.deviceId)?.registrationId === current.registrationId) this.delivery.set(current.deviceId, 'failed');
          throw new HermesError('upstream', 'No se pudo publicar el Aviso. Reintenta.');
        } finally { this.observationPending--; pending.delete(controller); if (!pending.size) this.pending.delete(current.deviceId); }
      }));
    if (outcomes.some(result => result.status === 'rejected')) throw new HermesError('upstream', 'No se pudo publicar el Aviso. Reintenta.');
  }
  // Silent widget signal (protocol/widget.ts): it carries no content, is coalesced and never retried.
  // ponytail: every enabled registration receives it, widget or not; a per-device opt-in needs a DTO change.
  private widgetCancel: (() => void) | null = null;
  private widgetLast = -Infinity;
  widgetChanged(): void {
    if (this.closed || !this.options.origin || !this.options.publish || this.widgetCancel) return;
    const wait = Math.max(0, this.widgetLast + WIDGET_SIGNAL_INTERVAL_MS - this.options.now());
    const timer = this.options.timer ?? ((ms, run) => { const handle = setTimeout(run, ms); handle.unref(); return () => clearTimeout(handle); });
    this.widgetCancel = timer(wait, () => {
      this.widgetCancel = null; this.widgetLast = this.options.now();
      void this.publishWidget().catch(() => {});
    });
  }
  private async publishWidget() {
    await this.ready; await this.queue; this.healthy();
    if (this.closed) return;
    await Promise.allSettled(this.entries.filter(entry => entry.registrationId && entry.endpoint && entry.preferences.enabled).map(async entry => {
      let current: Entry;
      try { current = this.scoped(entry.deviceId, entry.registrationId!); } catch { return; }
      if (this.observationPending >= 64 || (this.pending.get(current.deviceId)?.size ?? 0) >= 8) return;
      this.observationPending++;
      // Revocation or a new registration aborts it through the same pending set as every notice.
      const controller = new AbortController();
      const pending = this.pending.get(current.deviceId) ?? new Set<AbortController>();
      pending.add(controller); this.pending.set(current.deviceId, pending);
      try {
        const signal: WidgetSignal = { schema: 1, kind: 'widget', registrationId: current.registrationId! };
        await this.options.publish!(current.endpoint!, JSON.stringify(signal), controller.signal);
      } finally { this.observationPending--; pending.delete(controller); if (!pending.size) this.pending.delete(current.deviceId); }
    }));
  }
  private entrySafe(deviceId: string) { try { return this.entry(deviceId); } catch { return undefined; } }
  private noticeScope(deviceId: string, noticeId: string) {
    const notice = this.notices.get(noticeId);
    if (!notice || notice.deviceId !== deviceId) throw new HermesError('not_found','Este Aviso es desconocido.');
    this.scoped(deviceId,notice.registrationId);
    return notice;
  }
  async notice(deviceId: string, noticeId: string): Promise<import('../../protocol/notifications.ts').NotificationNotice> {
    await this.ready; await this.queue; this.healthy();
    const notice = this.noticeScope(deviceId,noticeId);
    const records = await this.options.runs.decisionHistory();
    this.noticeScope(deviceId,noticeId);
    const attempts = await this.options.runs.uncertainDecisions();
    this.noticeScope(deviceId,noticeId);
    const a = notice.approval;
    const record = records.find(item => item.origin === 'relay' && item.agentId === a.agentId && item.runId === a.runId && item.approvalId === a.id);
    const uncertain = attempts.some(item => item.id === JSON.stringify(['relay',a.agentId,a.runId,a.id]));
    const live = this.options.runs.approvals().some(item => item.id === a.id && item.agentId === a.agentId && item.runId === a.runId);
    const state = record && ['approved','rejected','expired'].includes(record.outcome) ? record.outcome as 'approved'|'rejected'|'expired'
      : uncertain ? 'uncertain' : a.expiresAt !== null && a.expiresAt <= this.options.now() ? 'expired' : live ? 'pending' : 'unknown';
    return {schema:1,noticeId,registrationId:notice.registrationId,kind:'approval',target:{agentId:a.agentId,runId:a.runId,approvalId:a.id},
      approval:structuredClone(a),expiresAt:a.expiresAt,serverNow:this.options.now(),state};
  }
  async decide(deviceId: string, noticeId: string, body: unknown, authorize: () => void): Promise<import('../../protocol/notifications.ts').NotificationDecisionResult> {
    if (!exactObject(body,['schema','registrationId','target','choice']) || body.schema !== 1 || typeof body.registrationId !== 'string'
      || !exactObject(body.target,['agentId','runId','approvalId']) || (body.choice !== 'once' && body.choice !== 'deny')) invalid();
    const value = await this.notice(deviceId,noticeId); authorize();
    if (body.registrationId !== value.registrationId || body.target.agentId !== value.target.agentId || body.target.runId !== value.target.runId || body.target.approvalId !== value.target.approvalId)
      throw new HermesError('conflict','El Aviso corresponde a otra Aprobación.');
    const choice = body.choice as 'once'|'deny';
    const expected = choice === 'once' ? 'approved' : 'rejected';
    const guardScope = () => {
      authorize(); this.noticeScope(deviceId,noticeId);
      // RunManager also verifies its captured identity after waits. Never select a reused ID.
      const live = this.options.runs.approvals().find(item => item.id === value.target.approvalId);
      if (live && (live.agentId !== value.target.agentId || live.runId !== value.target.runId)) throw new HermesError('conflict','La Aprobación cambió de identidad.');
    };
    const guard = () => {
      guardScope();
      if (value.state !== expected && (value.expiresAt !== null && value.expiresAt <= this.options.now())) throw new HermesError('conflict','La Aprobación expiró.');
    };
    guard();
    if (value.state === 'uncertain') throw new HermesError('decision_uncertain','La Decisión quedó sin confirmar. No se enviará otra vez.');
    if (value.state !== 'pending' && value.state !== expected) throw new HermesError('conflict','Esta Aprobación ya no está pendiente.');
    await this.options.runs.decide(value.target.approvalId,choice,guard);
    // Expiry gates sending, not a result already confirmed by Hermes and the ledger.
    guardScope();
    const records = await this.options.runs.decisionHistory();
    guardScope();
    const confirmed = records.filter(record => record.origin === 'relay' && record.agentId === value.target.agentId
      && record.runId === value.target.runId && record.approvalId === value.target.approvalId);
    // Live Hermes evidence may resolve another choice while the HTTP ACK is in flight.
    if (confirmed.length !== 1 || confirmed[0].actor !== 'person' || confirmed[0].choice !== choice || confirmed[0].outcome !== expected)
      throw new HermesError('conflict','Esta Aprobación tiene otra Decisión o no se pudo confirmar la elección.');
    return {ok:true,outcome:expected};
  }

}
