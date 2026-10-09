// Additive routes: GET /v1/server/control, POST /v1/server/pause and /resume.
// Authenticated requests use the existing X-Relay-Protocol version; no version bump.
export type ServerControlAction = 'pause' | 'resume';
export interface ServerControlStatus {
  // Relay admission is closed; Hermes may still be unpaused after a failed command.
  paused: boolean;
  // Sentinel existence only. Null means the read could not be confirmed.
  hermesPaused: boolean | null;
  phase: 'ready' | 'pending' | 'failed';
  action: ServerControlAction | null;
}
export interface HermesServerControl {
  paused(): Promise<boolean>;
  pause(): Promise<void>;
  resume(): Promise<void>;
}
