import { randomUUID } from 'node:crypto';
import type { JobHistory } from '../../protocol/scheduledJobs.ts';
import type { GatewayStatus } from '../../protocol/protocol.ts';
import type { Notifications } from './notifications.ts';

// Only confirmed observations enter this port. Delivery failure cannot change a confirmed operation.
export class NotificationProducers {
  private gatewayRead = 0;
  private pausedRead = 0;
  beginGatewayRead() { return ++this.gatewayRead; }
  beginPausedRead() { return ++this.pausedRead; }
  private pausedState: boolean | null = null;
  private gatewayPid: number | null = null;
  private gatewayState: 'active' | 'stopped' | null = null;
  private notifications: Notifications;
  private now: () => number;
  private log: (line: string) => void;
  constructor(notifications: Notifications, now: () => number, log: (line: string) => void) {
    this.notifications = notifications; this.now = now; this.log = log;
  }
  gateway(status: GatewayStatus, authorize: () => void, read: number) {
    authorize();
    if (read !== this.gatewayRead) return;
    if (status.state !== 'active' && status.state !== 'stopped') return;
    const previous = this.gatewayState; const previousPid = this.gatewayPid;
    const pid = typeof status.pid === 'number' && Number.isSafeInteger(status.pid) && status.pid > 0 ? status.pid : null;
    this.gatewayState = status.state; this.gatewayPid = pid;
    if (previous !== null && (previous !== status.state
      || status.state === 'active' && previousPid !== null && pid !== null && previousPid !== pid)) this.publishServer(authorize);
  }
  paused(paused: boolean | null, authorize: () => void, read: number) {
    authorize();
    if (read !== this.pausedRead || paused === null) return;
    const previous = this.pausedState; this.pausedState = paused;
    if (previous !== null && previous !== paused) this.publishServer(authorize);
  }
  jobs(agentId: string, jobId: string, history: JobHistory, authorize: () => void) {
    authorize();
    // Hermes's ledger is a bounded page, not a live or complete execution stream.
    for (const row of history.executions.slice(0, 50)) {
      if ((row.status !== 'completed' && row.status !== 'failed') || typeof row.id !== 'string' || row.id.length > 1024
        || typeof row.finishedAt !== 'string' || row.finishedAt.length > 100 || !/(?:Z|[+-]\d{2}:\d{2})$/.test(row.finishedAt)) continue;
      const at = Date.parse(row.finishedAt);
      if (!Number.isSafeInteger(at) || at < 0) continue;
      void this.notifications.observed(row.status === 'completed' ? 'task' : 'error', JSON.stringify(['job', agentId, jobId, row.id]), at, authorize)
        .catch(() => this.log('Task notification unavailable.'));
    }
  }
  private publishServer(authorize: () => void) {
    // A confirmed gateway change moves every Agente's on/off state shown by the widget.
    this.notifications.widgetChanged();
    void this.notifications.observed('server', randomUUID(), this.now(), authorize)
      .catch(() => this.log('Server notification unavailable.'));
  }
}
