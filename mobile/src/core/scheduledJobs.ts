import type { ScheduledJob } from '../../../protocol/scheduledJobs.ts';
export interface JobAuthorization {
  identity: string;
  epoch: number;
  visible: boolean;
  connected: boolean;
  now: number;
}
export function jobAuthorizationCurrent(start: JobAuthorization, current: JobAuthorization): boolean {
  return start.visible && start.connected && current.visible && current.connected && start.identity === current.identity
    && start.epoch === current.epoch && current.now >= start.now && current.now - start.now < 60000;
}
export function jobScheduleLabel(schedule: string): string {
  const match = /^every (\d+)([mhd])$/.exec(schedule);
  const common: Record<string, string> = { '0 * * * *': 'Cada hora', '0 8 * * *': 'Todos los días a las 8:00', '0 9 * * *': 'Todos los días a las 9:00', '0 9 * * 1-5': 'De lunes a viernes a las 9:00', '0 9 * * 1': 'Los lunes a las 9:00', '0 10 * * 1': 'Los lunes a las 10:00', '0 9 1 * *': 'El día 1 de cada mes a las 9:00' };
  if (common[schedule])
    return common[schedule];
  return match ? `Cada ${match[1]} ${match[2] === 'm' ? 'min' : match[2] === 'h' ? 'h' : 'días'}` : schedule;
}
export function jobTime(at: number | null, timezone: string | null): string {
  if (at === null)
    return 'Sin próxima ejecución';
  if (!timezone)
    return 'Zona horaria de Hermes no disponible';
  try {
    return new Intl.DateTimeFormat('es-MX', { timeZone: timezone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
  }
  catch {
    return 'Fecha no disponible';
  }
}
export function jobHasFailed(status: string | null): boolean {
  return status === 'error' || status === 'delivery_failed' || status === 'failed';
}

export function jobIsPaused(job: Pick<ScheduledJob, 'enabled' | 'state'>): boolean {
  return !job.enabled && (job.state == null || job.state === 'paused');
}
export function jobStateLabel(job: Pick<ScheduledJob, 'enabled' | 'state'>): string {
  return job.enabled ? 'ACTIVA' : jobIsPaused(job) ? 'PAUSADA' : job.state === 'completed' ? 'COMPLETADA' : job.state === 'error' ? 'CON FALLO' : 'DESACTIVADA';
}

/** Hermes says `running` while a job executes; a paused job never counts. */
export function jobIsRunning(job: Pick<ScheduledJob, 'enabled' | 'state'>): boolean {
  return job.enabled && job.state === 'running';
}

/** The next-run window of a row: «hoy 10:00», «mañ 08:00», «12 oct», «—» without a next run, or «?» when the Servidor's zone is missing or unusable. Days are the Servidor's. */
export function jobWindow(at: number | null, timezone: string | null, now: number): string {
  if (at === null)
    return '—';
  if (!timezone)
    return '?';
  try {
    const parts = (time: number, options: Intl.DateTimeFormatOptions) => Object.fromEntries(new Intl.DateTimeFormat('es-MX', { timeZone: timezone, hourCycle: 'h23', ...options }).formatToParts(time).map(p => [p.type, p.value]));
    const number = { year: 'numeric', month: 'numeric', day: 'numeric' } as const;
    const days = (time: number) => { const p = parts(time, number); return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86_400_000; };
    const ahead = days(at) - days(now);
    const clock = parts(at, { hour: '2-digit', minute: '2-digit' });
    const time = `${clock.hour}:${clock.minute}`;
    return ahead === 0 ? `hoy ${time}` : ahead === 1 ? `mañ ${time}` : `${Number(parts(at, { day: 'numeric' }).day)} ${parts(at, { month: 'short' }).month.replace('.', '')}`;
  }
  catch {
    return '?';
  }
}
