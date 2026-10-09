import type { AgentStatus, Conversation, ModelSelection } from './protocol.ts';

export type ApprovalMode = 'manual' | 'smart' | 'off';
export type AgentDetailsErrorCode = 'agent_details_unavailable' | 'agent_security_read_only' | 'agent_security_conflict' | 'agent_security_invalid' | 'agent_security_uncertain';
export interface UsageAmount { tokens: number; estimatedCostUsd: number | null; conversations: number }
export interface AgentUsage {
  capturedAt: number; timezone: string; basis: 'conversation_started_at'; includesAuxiliary: false;
  today: UsageAmount; last7days: UsageAmount; daily: Array<UsageAmount & { day: string }>;
}
export interface AgentSecurity {
  mode: ApprovalMode | null;
  pendingMode: { mode: ApprovalMode; requestedAt: number } | null;
  deny: string[] | null; guardianPolicy: string | null;
  revision: string; writable: boolean; reason: string | null;
}
export interface AgentDetails {
  agentId: string; name: string; status: AgentStatus; capturedAt: number;
  defaultModel: ModelSelection; security: AgentSecurity;
  usage: AgentUsage | null; usageError: string | null; recentConversations: Conversation[];
}
export interface ApprovalModeRequest { mode: ApprovalMode; revision: string }
export interface BlockRuleRequest { action: 'add' | 'remove'; pattern: string; revision: string }
export const AGENT_DETAILS_ERROR_STATUS: Record<AgentDetailsErrorCode, number> = {
  agent_details_unavailable: 503, agent_security_read_only: 403, agent_security_conflict: 409,
  agent_security_invalid: 400, agent_security_uncertain: 503,
};
