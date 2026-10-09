import { constants } from 'node:fs';
import path from 'node:path';
import type { JobAction, ScheduledJobInput } from '../../protocol/scheduledJobs.ts';
import { exactObject, openPrivateFile, syncStateDirectory, type ChangeInput, type ChangeLog } from './changeLog.ts';
import { HermesError } from './hermes.ts';
import type { JobsManager } from './jobsManager.ts';
export class ScheduledJobsError extends Error {
  readonly status = 409;
  readonly code = 'job_paused';
  constructor() { super('Hermes reanuda una tarea al ejecutarla. Reanuda primero con huella.'); }
}
function validSchedule(value: string): boolean {
  if (/^every [1-9]\d{0,5}[mhd]$/.test(value))
    return true;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
    return Number.isFinite(Date.parse(value));
  const fields = value.split(' ');
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return fields.length === 5 && fields.every((f, i) => f.split(',').every(part => {
    const m = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m || m[2] !== undefined && Number(m[2]) < 1)
      return false;
    if (m[1] === '*')
      return true;
    const values = m[1].split('-').map(Number);
    return values.every(n => n >= ranges[i][0] && n <= ranges[i][1]) && (values.length === 1 || values[0] <= values[1]);
  }));
}
export function jobInput(value: unknown): ScheduledJobInput {
  if (!exactObject(value, ['name', 'prompt', 'schedule', 'deliver', 'skills', 'repeat'])
    || typeof value.name !== 'string' || !value.name.trim() || Array.from(value.name).length > 200 || /[\x00-\x1f\x7f]/.test(value.name)
    || typeof value.prompt !== 'string' || Array.from(value.prompt).length > 5000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.prompt)
    || typeof value.schedule !== 'string' || value.schedule.length > 128 || !validSchedule(value.schedule)
    || typeof value.deliver !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:@.\/-]{0,255}$/.test(value.deliver)
    || !Array.isArray(value.skills) || value.skills.length > 32 || value.skills.some(s => typeof s !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,127}$/.test(s) || s.split('/').includes('..'))
    || value.repeat !== null && (!Number.isSafeInteger(value.repeat) || Number(value.repeat) < 1 || Number(value.repeat) > 1000000)) {
    throw new HermesError('bad_request', 'Datos de tarea inválidos.');
  }
  return value as unknown as ScheduledJobInput;
}
/** Serialize Relay writes per Agente; never overwrite an earlier snapshot. */
export class ScheduledJobs {
  private queues = new Map<string, Promise<unknown>>();
  private manager: JobsManager;
  private directory: string;
  private log: ChangeLog;
  constructor(manager: JobsManager, directory: string, log: ChangeLog) { this.manager = manager; this.directory = directory; this.log = log; }
  async mutate(agent: string, job: string | null, action: 'create' | 'edit' | 'delete' | JobAction, input: ScheduledJobInput | undefined, actor: ChangeInput['actor'], guard: () => void) {
    const run = (this.queues.get(agent) ?? Promise.resolve()).catch(() => { }).then(async () => {
      guard();
      // Upstream trigger_job sets enabled=true; it cannot run a paused job just once.
      if (action === 'run' && (await this.manager.get(agent, job!)).enabled === false)
        throw new ScheduledJobsError();
      guard();
      const previous = await this.manager.snapshot(agent);
      guard();
      const record = await this.log.appendChange({ actor, action: `job.${action}.requested`, target: { kind: 'agent', id: JSON.stringify([agent, job ?? 'new']) } });
      guard();
      const file = path.join(this.directory, `jobs-version-${record.id}.json`);
      const { handle } = await openPrivateFile(file, constants.O_WRONLY | constants.O_EXCL, true);
      try {
        await handle.writeFile(JSON.stringify({ agentId: agent, previousEncoding: 'base64', previous }));
        await handle.sync();
      }
      finally {
        await handle.close();
      }
      await syncStateDirectory(this.directory);
      guard();
      if (action === 'create')
        return this.manager.create(agent, input!);
      if (action === 'edit')
        return this.manager.edit(agent, job!, input!);
      if (action === 'delete') {
        await this.manager.delete(agent, job!);
        return { ok: true };
      }
      return this.manager.action(agent, job!, action);
    });
    this.queues.set(agent, run);
    try {
      return await run;
    }
    finally {
      if (this.queues.get(agent) === run)
        this.queues.delete(agent);
    }
  }
}
