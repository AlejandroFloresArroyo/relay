// Hermes API and ledger schema pinned to NousResearch/hermes-agent@ea114c3e98c3339e13004adfc6098cf28ed7d754.
import { CronFiles } from './cronFiles.ts';
import { readCronStore } from './cronStore.ts';
import type { JobAction, JobExecution, ScheduledJob, ScheduledJobInput, ScheduledJobList } from '../../protocol/scheduledJobs.ts';
import { HermesError } from './hermes.ts';
import type { JobsManager } from './jobsManager.ts';
interface Options {
  home(agent: string): string;
  timezone(agent: string): string | null;
  request(agent: string, method: string, route: string, body?: unknown): Promise<unknown>;
}
function failure(): never { throw new HermesError('unavailable', 'Tareas no disponibles.'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return failure();
  return value as Record<string, unknown>;
}
function text(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function instant(value: unknown): number | null {
  if (value === null || value === undefined)
    return null;
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
    return failure();
  return Date.parse(value);
}
/** No upstream cron imports: even their list/history helpers can repair or prune files. */
export class HermesJobs implements JobsManager {
  private options: Options;
  constructor(options: Options) { this.options = options; }
  private map(agent: string, value: unknown): ScheduledJob {
    const j = object(value), schedule = object(j.schedule);
    if (typeof j.id !== 'string' || !/^[a-f0-9]{12}$/.test(j.id) || typeof j.name !== 'string' || typeof j.enabled !== 'boolean')
      return failure();
    const expression = schedule.kind === 'cron' ? text(schedule.expr) : schedule.kind === 'interval' && Number.isSafeInteger(schedule.minutes) && Number(schedule.minutes) > 0 ? `every ${schedule.minutes}m` : schedule.kind === 'once' ? text(schedule.run_at) : null;
    if (!expression)
      return failure();
    const repeat = j.repeat ? object(j.repeat) : {};
    return { id: j.id, agentId: agent, name: j.name, prompt: text(j.prompt) ?? '', schedule: expression, deliver: text(j.deliver) ?? 'local', skills: Array.isArray(j.skills) ? j.skills.filter((s): s is string => typeof s === 'string') : [], repeat: typeof repeat.times === 'number' ? repeat.times : null, enabled: j.enabled, state: text(j.state), timezone: this.options.timezone(agent), nextRunAt: instant(j.next_run_at), lastStatus: text(j.last_status), model: text(j.model), workdir: text(j.workdir), script: text(j.script) };
  }
  async list(agent: string): Promise<ScheduledJobList> {
    const data = object(await this.options.request(agent, 'GET', '/api/jobs?include_disabled=true'));
    if (!Array.isArray(data.jobs))
      return failure();
    return { agentId: agent, timezone: this.options.timezone(agent), jobs: data.jobs.map(j => this.map(agent, j)) };
  }
  async get(agent: string, id: string) { return this.map(agent, object(await this.options.request(agent, 'GET', `/api/jobs/${id}`)).job); }
  async snapshot(agent: string): Promise<string | null> {
    let files: CronFiles | undefined;
    try {
      files = new CronFiles(this.options.home(agent));
      const pin = files.open('jobs.json', 8 * 1024 * 1024, true);
      if (!pin) return null;
      const bytes = files.read(pin);
      files.verify();
      return bytes.toString('base64');
    } catch { return failure(); }
    finally { files?.close(); }
  }
  async history(agent: string, id: string, offset: number) {
    try {
      return readCronStore(this.options.home(agent), db => {
        if (db.prepare("SELECT type FROM sqlite_schema WHERE name='executions'").get()?.type !== 'table') return failure();
        const columns = db.prepare('PRAGMA table_info(executions)').all().map(r => r.name);
        const optional = (name: string) => columns.includes(name) ? name : `NULL AS ${name}`;
        const rows = db.prepare(`SELECT id,status,claimed_at,started_at,finished_at,${optional('delivery_outcome')},${optional('scheduled_instant')} FROM executions WHERE job_id=? ORDER BY julianday(claimed_at) DESC,id DESC LIMIT 51 OFFSET ?`).all(id, offset);
        const executions: JobExecution[] = rows.slice(0, 50).map(r => {
          if (typeof r.id !== 'string' || typeof r.claimed_at !== 'string' || !['claimed', 'running', 'completed', 'failed', 'unknown'].includes(String(r.status)))
            return failure();
          return { id: r.id, status: r.status as JobExecution['status'], claimedAt: r.claimed_at, startedAt: text(r.started_at), finishedAt: text(r.finished_at), deliveryOutcome: text(r.delivery_outcome), scheduledInstant: text(r.scheduled_instant) };
        });
        return { executions, hasMore: rows.length > 50 };
      });
    }
    catch {
      return failure();
    }
  }
  private requireTimezone(agent: string) { if (!this.options.timezone(agent))
    throw new HermesError('unavailable', 'No se conoce la zona horaria de Hermes.'); }
  async create(agent: string, input: ScheduledJobInput) { this.requireTimezone(agent); return this.map(agent, object(await this.options.request(agent, 'POST', '/api/jobs', input)).job); }
  async edit(agent: string, id: string, input: ScheduledJobInput) { this.requireTimezone(agent); return this.map(agent, object(await this.options.request(agent, 'PATCH', `/api/jobs/${id}`, input)).job); }
  async delete(agent: string, id: string) { const result = object(await this.options.request(agent, 'DELETE', `/api/jobs/${id}`)); if (result.ok !== true)
    return failure(); }
  async action(agent: string, id: string, action: JobAction) { return this.map(agent, object(await this.options.request(agent, 'POST', `/api/jobs/${id}/${action}`, {})).job); }
}
