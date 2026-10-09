import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerControlAction, ServerControlStatus, HermesServerControl } from '../../protocol/serverControl.ts';
import { checkStateDirectory, exactObject, openPrivateFile, syncStateDirectory } from './changeLog.ts';
import type { ChangeLog, ChangeInput } from './changeLog.ts';
import { HermesError } from './hermes.ts';
import type { RunManager } from './runs.ts';

// A closed admission gate is durable before any command. Failed/uncertain operations stay closed.
export class ServerControl {
  private state: ServerControlStatus = { paused: true, hermesPaused: null, phase: 'ready', action: null };
  private ready: Promise<void>;
  private pending = false;
  private epoch = 0;
  private admitted = new Set<Promise<unknown>>();
  private file: string;
  private port: () => HermesServerControl | undefined;
  private runs: RunManager;
  private audit: ChangeLog;
  constructor(directory: string, port: () => HermesServerControl | undefined, runs: RunManager, audit: ChangeLog) {
    this.file = path.join(directory, 'server-control.json'); this.port = port; this.runs = runs; this.audit = audit;
    this.ready = this.load();
    void this.ready.catch(() => {});
  }
  private async load() {
    try {
      const { handle } = await openPrivateFile(this.file, constants.O_RDONLY, false);
      try {
        if ((await handle.stat()).size > 128) throw new Error();
        const value: unknown = JSON.parse(await handle.readFile('utf8'));
        if (!exactObject(value, ['paused', 'phase', 'action']) || typeof value.paused !== 'boolean'
          || !['ready', 'pending', 'failed'].includes(String(value.phase))
          || value.action !== null && value.action !== 'pause' && value.action !== 'resume'
          || value.phase !== 'ready' && (!value.paused || value.action === null)
          || value.phase === 'ready' && value.action !== null) throw new Error();
        this.state = { paused: value.paused, hermesPaused: null,
          phase: value.phase === 'ready' ? 'ready' : 'failed', action: value.action as ServerControlAction | null };
        // A pending command from a previous process has no confirmed outcome.

      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new HermesError('unavailable', 'El estado de Pausa general no está disponible.');
      this.state.paused = false;
    }
  }
  private async save(paused: boolean, phase: ServerControlStatus['phase'] = 'ready', action: ServerControlAction | null = null) {
    const directory = path.dirname(this.file);
    await checkStateDirectory(directory);
    const existing = await openPrivateFile(this.file, constants.O_RDONLY, false).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    await existing?.handle.close();
    const temporary = path.join(directory, `.server-control.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(`${JSON.stringify({ paused, phase, action })}\n`); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, this.file); await syncStateDirectory(directory);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }

  private requirePort() {
    const port = this.port();
    if (!port) throw new HermesError('unavailable', 'Pausa general no está disponible en este Puente.');
    return port;
  }
  async status(): Promise<ServerControlStatus> {
    await this.ready;
    const port = this.requirePort();
    if (!this.pending) {
      try { this.state.hermesPaused = await port.paused(); }
      catch { this.state.hermesPaused = null; }
    }
    return { ...this.state, paused: this.pending || this.state.paused || this.state.hermesPaused !== false };
  }
  assertAdmission() {
    if (this.pending || this.state.paused || this.state.hermesPaused === true) throw new HermesError('server_paused', 'Pausa general: reanuda el Servidor antes de iniciar trabajo.');
  }
  async admit<T>(operation: (guard: () => void) => Promise<T>, authorize: () => void): Promise<T> {
    await this.ready; authorize();
    // Older Hermes ports keep their existing behavior until this additive capability is installed.
    if (this.port()) {
      const status = await this.status(); authorize();
      if (status.paused) throw new HermesError('server_paused', 'Pausa general: el Servidor no admite trabajo.');
    }
    this.assertAdmission(); const epoch = this.epoch;
    const guard = () => { authorize(); this.assertAdmission(); if (epoch !== this.epoch) throw new HermesError('server_paused', 'El Servidor cambió de estado. Reenvía el Turno.'); };
    guard();
    const work = operation(guard); this.admitted.add(work);
    try { return await work; } finally { this.admitted.delete(work); }
  }
  async change(action: ServerControlAction, actor: ChangeInput['actor'], authorize: () => void): Promise<ServerControlStatus> {
    if (this.pending) throw new HermesError('conflict', 'Hay un cambio de control pendiente.');
    this.pending = true; this.epoch++;
    try {
      await this.ready; authorize();
      this.state = { ...this.state, paused: true, phase: 'pending', action };
      await this.save(true, 'pending', action); authorize();
      await this.audit.appendChange({ actor, action: `server.${action}.requested`, target: { kind: 'server', id: 'local' } }); authorize();
      const port = this.requirePort();
      if (action === 'pause') {
        // Stop Relay work even if Hermes's global command fails.
        const attempted = new Set<string>();
        const stopping = this.runs.stopActive(authorize, attempted);
        const outcomes = await Promise.allSettled([port.pause(), stopping, (async () => {
          await Promise.allSettled([...this.admitted]); authorize();
          // Preserve the first stop's outcome, and attempt any creation that finished late.
          await this.runs.stopActive(authorize, attempted);
        })()]);
        authorize();
        if (outcomes.some((result) => result.status === 'rejected')) throw new Error();
      } else { await port.resume(); authorize(); }
      this.state.hermesPaused = await port.paused(); authorize();
      if (this.state.hermesPaused !== (action === 'pause')) throw new Error();
      await this.audit.appendChange({ actor, action: `server.${action}.succeeded`, target: { kind: 'server', id: 'local' } }); authorize();
      await this.save(action === 'pause'); authorize();
      this.state = { paused: action === 'pause', hermesPaused: action === 'pause', phase: 'ready', action: null };
      return { ...this.state };
    } catch {
      this.state = { ...this.state, paused: true, phase: 'failed', action };
      await this.save(true, 'failed', action).catch(() => {});
      await this.audit.appendChange({ actor, action: `server.${action}.failed`, target: { kind: 'server', id: 'local' } }).catch(() => {});
      authorize();
      throw new HermesError('upstream', 'El cambio quedó sin confirmar. Relay mantiene cerrada la admisión de Turnos.');
    } finally { this.pending = false; }
  }
}
