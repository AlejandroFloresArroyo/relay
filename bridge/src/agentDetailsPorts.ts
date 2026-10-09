import type { AgentSecurity, AgentUsage, ApprovalMode } from '../../protocol/agentDetails.ts';
export interface SecuritySnapshot {
  security: Omit<AgentSecurity, 'revision' | 'pendingMode'>;
  revision: string; bytes: Uint8Array; identity: string;
}
export interface HermesAgentDetails {
  security(profile: string): Promise<SecuritySnapshot>;
  usage(profile: string, capturedAt: number): Promise<AgentUsage>;
  // Retention must finish before the only authorized leaf is replaced.
  writeSecurity(profile: string, snapshot: SecuritySnapshot, leaf: 'mode' | 'deny', value: ApprovalMode | string[],
    guard: () => void, retain: () => Promise<void>): Promise<SecuritySnapshot>;
}
