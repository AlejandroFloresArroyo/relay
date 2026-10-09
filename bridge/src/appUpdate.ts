import type { AppUpdateManifest } from '../../protocol/appUpdate.ts';
import { AppUpdateError, PublicationReader, validRoot } from './appUpdateReader.ts';
import type { Snapshot } from './appUpdateReader.ts';
export { AppUpdateError } from './appUpdateReader.ts';
export interface AppUpdateContext { deviceId: string; guard(): void; signal: AbortSignal }
interface Entry { snapshot: Snapshot; users: number; disposal?: Promise<void> }
interface Build { controller: AbortController; consumers: Set<AppUpdateContext>; promise: Promise<Entry | null> }
export interface AppUpdateDownload { file: Snapshot['file']; manifest: Extract<AppUpdateManifest, { state: 'published' }>; release(): Promise<void> }
export class AppUpdates {
  private root: string;
  private privateRoot: string;
  private entries = new Set<Entry>();
  private current: Entry | null = null;
  private build?: Build;
  private devices = new Set<string>();
  private closed = false;
  constructor(options: { root: string; privateRoot: string }) {
    this.root = options.root; this.privateRoot = options.privateRoot;
    if (!validRoot(this.root) || !validRoot(this.privateRoot) || this.root === this.privateRoot
      || this.root.startsWith(this.privateRoot + '/') || this.privateRoot.startsWith(this.root + '/')) throw new AppUpdateError();
  }
  private check(context: AppUpdateContext) { context.guard(); context.signal.throwIfAborted(); if (this.closed) throw new AppUpdateError('app_update_unavailable', 404); }
  private async prune() {
    for (const entry of this.entries) if (entry !== this.current && !entry.users) {
      entry.disposal ??= entry.snapshot.dispose().then(() => { this.entries.delete(entry); });
      await entry.disposal;
    }
  }
  private async get(context: AppUpdateContext): Promise<Entry | null> {
    this.check(context);
    let build = this.build;
    if (!build) {
      build = { controller: new AbortController(), consumers: new Set(), promise: undefined as unknown as Promise<Entry | null> };
      const active = build; this.build = build;
      active.consumers.add(context);
      const timer = setTimeout(() => active.controller.abort(new AppUpdateError()), 30_000); timer.unref();
      const guard = () => {
        active.controller.signal.throwIfAborted();
        let allowed = false;
        for (const c of active.consumers) { try { this.check(c); allowed = true; } catch {} }
        if (!allowed) { active.controller.abort(new AppUpdateError()); active.controller.signal.throwIfAborted(); }
      };
      active.promise = (async () => {
        const reader = new PublicationReader(this.root);
        try {
          const published = await reader.open(guard); guard();
          if (!published) { this.current = null; await this.prune(); guard(); return null; }
          if (this.current?.snapshot.identity === reader.identity && this.current.snapshot.revision === reader.revision) return this.current;
          await this.prune(); guard();
          if (this.entries.size >= 2) throw new AppUpdateError('app_update_busy', 429);
          const snapshot = await reader.snapshot(this.privateRoot, guard);
          try { guard(); } catch (error) { await snapshot.dispose(); throw error; }
          const entry = { snapshot, users: 0 }; this.entries.add(entry); this.current = entry;
          return entry;
        } finally { try { await reader.close(); } finally { clearTimeout(timer); if (this.build === active) this.build = undefined; } }
      })();
    } else {
      if (build.consumers.size >= 64) throw new AppUpdateError('app_update_busy', 429);
      build.consumers.add(context);
    }
    const active = build;
    let abort!: () => void; let buildAbort!: () => void;
    try {
      const cancellation = new Promise<never>((_, reject) => {
        abort = () => reject(context.signal.reason ?? new AppUpdateError());
        buildAbort = () => reject(active.controller.signal.reason ?? new AppUpdateError());
        context.signal.addEventListener('abort', abort, { once: true }); active.controller.signal.addEventListener('abort', buildAbort, { once: true });
        if (context.signal.aborted) abort(); else if (active.controller.signal.aborted) buildAbort();
      });
      const entry = await Promise.race([active.promise, cancellation]); this.check(context); return entry;
    } catch (error) { this.check(context); throw error; }
    finally {
      context.signal.removeEventListener('abort', abort); active.controller.signal.removeEventListener('abort', buildAbort); active.consumers.delete(context);
      if (!active.consumers.size) active.controller.abort(new AppUpdateError());
    }
  }
  async manifest(context: AppUpdateContext): Promise<AppUpdateManifest> {
    const entry = await this.get(context); this.check(context);
    return entry ? { state: 'published', revision: entry.snapshot.revision, artifact: { ...entry.snapshot.artifact } } : { state: 'unpublished' };
  }
  async download(ifMatch: string | undefined, context: AppUpdateContext): Promise<AppUpdateDownload> {
    this.check(context);
    if (ifMatch === undefined) throw new AppUpdateError('app_update_precondition', 428);
    if (!/^"[a-f0-9]{64}"$/.test(ifMatch)) throw new AppUpdateError('app_update_precondition', 428);
    if (this.devices.size >= 4 || this.devices.has(context.deviceId)) throw new AppUpdateError('app_update_busy', 429);
    this.devices.add(context.deviceId);
    try {
      const entry = await this.get(context); this.check(context);
      if (!entry || '"' + entry.snapshot.revision + '"' !== ifMatch) throw new AppUpdateError('app_update_changed', 412);
      entry.users++;
      let released = false;
      return { file: entry.snapshot.file, manifest: { state: 'published', revision: entry.snapshot.revision, artifact: { ...entry.snapshot.artifact } },
        release: async () => { if (released) return; released = true; entry.users--; this.devices.delete(context.deviceId); await this.prune(); } };
    } catch (error) { this.devices.delete(context.deviceId); throw error; }
  }
  async close() {
    this.closed = true; this.build?.controller.abort(new AppUpdateError());
    await this.build?.promise.catch(() => {}); this.current = null; await this.prune();
  }
}
