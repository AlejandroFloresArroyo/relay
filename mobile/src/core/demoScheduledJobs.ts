import type { ScheduledJob, JobExecution } from '../../../protocol/scheduledJobs.ts';
import { RelayError, type RelayClient } from './client.ts';
import { demoConnectionError } from './demoConnection.ts';
export const DEMO_JOB_SCENARIOS = ['normal', 'loading', 'empty', 'error', 'history-error', 'write-error'] as const;
export type DemoJobScenario = typeof DEMO_JOB_SCENARIOS[number];
const scenarios = new Map<string, DemoJobScenario>();
export function setDemoJobScenario(server: string, scenario: DemoJobScenario) { scenarios.set(server, scenario); }
/** `days` from today at `hour`:00 in the demo Servidor's zone, which keeps no daylight saving (UTC-6). */
function at(days: number, hour: number): number {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(Date.now());
  return Date.parse(`${today}T00:00:00-06:00`) + days * 86_400_000 + hour * 3_600_000;
}
const worlds = new Map<string, ScheduledJob[]>();
function world(server: string): ScheduledJob[] {
  if (!worlds.has(server))
    worlds.set(server, [
      { id: 'abcdef123451', agentId: 'dev', name: 'Sincronizar métricas', schedule: 'every 5m', enabled: true, nextRunAt: at(0, 9), lastStatus: 'ok' },
      { id: 'abcdef123452', agentId: 'dev', name: 'Limpiar caché de build', schedule: '0 * * * *', enabled: true, nextRunAt: at(0, 10), lastStatus: 'error' },
      { id: 'abcdef123453', agentId: 'research', name: 'Resumen de papers', schedule: '0 8 * * *', enabled: true, nextRunAt: at(1, 8), lastStatus: 'ok' },
      { id: 'abcdef123454', agentId: 'dev', name: 'Resumen diario de PRs', schedule: '0 9 * * 1-5', enabled: true, nextRunAt: at(1, 9), lastStatus: 'ok' },
      { id: 'abcdef123455', agentId: 'dev', name: 'Auditoría de dependencias', schedule: '0 10 * * 1', enabled: true, nextRunAt: at(6, 10), lastStatus: 'ok' },
      { id: 'abcdef123451', agentId: 'research', name: 'Informe mensual de uso', schedule: '0 9 1 * *', enabled: false, nextRunAt: null, lastStatus: null },
    ].map(j => ({ ...j, state: j.id === 'abcdef123451' && j.agentId === 'dev' ? 'running' : j.enabled ? 'scheduled' : 'paused', prompt: 'Revisa los PRs abiertos y resume en cinco líneas qué necesita revisión hoy.', deliver: 'local', skills: [], repeat: null, timezone: 'America/Mexico_City', model: 'qwen3-coder-480b', workdir: '/srv/app/web', script: 'scripts/prs-abiertos.sh' })));
  return worlds.get(server)!;
}
export function createDemoScheduledJobs(server: string): Pick<RelayClient, 'scheduledJobs' | 'scheduledJob' | 'jobHistory' | 'createJob' | 'editJob' | 'deleteJob' | 'jobAction'> {
  const guard = async (write = false, history = false) => {
    const connection = demoConnectionError(server);
    if (connection)
      throw connection;
    const scenario = scenarios.get(server);
    if (scenario === 'loading')
      await new Promise(r => setTimeout(r, 1500));
    if (scenario === 'error' || write && scenario === 'write-error' || history && scenario === 'history-error')
      throw new RelayError('unavailable', 'No disponible en esta demostración.');
  };
  const get = (agent: string, id: string) => { const job = world(server).find(j => j.agentId === agent && j.id === id); if (!job)
    throw new RelayError('http', 'La tarea ya no existe.', 404); return job; };
  return {
    async scheduledJobs(agent) { await guard(); return { agentId: agent, timezone: 'America/Mexico_City', jobs: scenarios.get(server) === 'empty' ? [] : structuredClone(world(server).filter(j => j.agentId === agent)) }; },
    async scheduledJob(agent, id) { await guard(); return structuredClone(get(agent, id)); },
    async jobHistory(agent, id) { await guard(false, true); get(agent, id); const statuses: JobExecution['status'][] = ['running', 'completed', 'failed', 'unknown', 'claimed']; return { hasMore: false, executions: statuses.map((status, i) => ({ id: `demo-${i}`, status, claimedAt: `2026-10-0${5 - i}T09:00:00-06:00`, startedAt: null, finishedAt: null, deliveryOutcome: status === 'completed' ? 'delivered' : null, scheduledInstant: null })) }; },
    async createJob(agent, input) { await guard(true); const j: ScheduledJob = { ...input, agentId: agent, id: (world(server).length + 100).toString(16).padStart(12, '0'), timezone: 'America/Mexico_City', enabled: true, state: 'scheduled', nextRunAt: null, lastStatus: null, model: null, workdir: null, script: null }; world(server).push(j); return structuredClone(j); },
    async editJob(agent, id, input) { await guard(true); const j = get(agent, id); Object.assign(j, input); return structuredClone(j); },
    async deleteJob(agent, id) { await guard(true); const j = get(agent, id); world(server).splice(world(server).indexOf(j), 1); return { ok: true }; },
    async jobAction(agent, id, action) { await guard(true); const j = get(agent, id); if (action !== 'run')
      j.enabled = action === 'resume'; return structuredClone(j); },
  };
}
