/** Additive jobs capability. Every identity is scoped by Servidor and Agente. */
export interface ScheduledJobInput {
  name: string;
  prompt: string;
  schedule: string;
  deliver: string;
  skills: string[];
  repeat: number | null;
}
export interface ScheduledJob extends ScheduledJobInput {
  id: string;
  agentId: string;
  enabled: boolean;
  state: string | null;
  timezone: string | null;
  nextRunAt: number | null;
  lastStatus: string | null;
  model: string | null;
  workdir: string | null;
  script: string | null;
}
export interface ScheduledJobList {
  agentId: string;
  timezone: string | null;
  jobs: ScheduledJob[];
}
export interface JobExecution {
  id: string;
  status: 'claimed' | 'running' | 'completed' | 'failed' | 'unknown';
  claimedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  deliveryOutcome: string | null;
  scheduledInstant: string | null;
}
export interface JobHistory {
  executions: JobExecution[];
  hasMore: boolean;
}
export type JobAction = 'pause' | 'resume' | 'run';
