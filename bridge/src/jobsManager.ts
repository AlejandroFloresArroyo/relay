import type { ScheduledJob, ScheduledJobInput, ScheduledJobList, JobHistory, JobAction } from '../../protocol/scheduledJobs.ts';
export interface JobsManager {
  list(agent: string): Promise<ScheduledJobList>;
  get(agent: string, job: string): Promise<ScheduledJob>;
  history(agent: string, job: string, offset: number): Promise<JobHistory>;
  // Base64 of the complete previous jobs.json bytes; null means it did not exist.
  snapshot(agent: string): Promise<string | null>;
  create(agent: string, input: ScheduledJobInput): Promise<ScheduledJob>;
  edit(agent: string, job: string, input: ScheduledJobInput): Promise<ScheduledJob>;
  delete(agent: string, job: string): Promise<void>;
  action(agent: string, job: string, action: JobAction): Promise<ScheduledJob>;
}
