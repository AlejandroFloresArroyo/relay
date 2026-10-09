import type { AgentDetails, AgentSecurity, ApprovalMode } from '../../../protocol/agentDetails.ts';
const modes = ['manual', 'smart', 'off'];
const rank: Record<ApprovalMode,number> = { manual: 2, smart: 1, off: 0 };
export function lowersProtection(security: AgentSecurity, target: ApprovalMode): boolean {
  if (target === security.mode) return false; // Cancelling a pending preference does not write Hermes.
  const from=security.pendingMode?.mode??security.mode;
  return from === null || rank[target] < rank[from];
}
export function isAgentSecurity(value: unknown): value is AgentSecurity {
 if(!value||typeof value!=='object')return false;const s=value as AgentSecurity;
 return (s.mode===null||modes.includes(s.mode))&&typeof s.revision==='string'&&/^[a-f0-9]{64}$/.test(s.revision)&&typeof s.writable==='boolean'&&(s.reason===null||typeof s.reason==='string')
 &&(s.pendingMode===null||!!s.pendingMode&&modes.includes(s.pendingMode.mode)&&Number.isSafeInteger(s.pendingMode.requestedAt))
 &&(s.deny===null||Array.isArray(s.deny)&&s.deny.length<=100&&s.deny.every(p=>typeof p==='string'&&p.length<=256))&&(s.guardianPolicy===null||typeof s.guardianPolicy==='string'&&s.guardianPolicy.length<=8192);
}
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
export function isAgentDetails(value: unknown, agentId: string): value is AgentDetails {
  if (!value || typeof value !== 'object') return false;
  const d = value as AgentDetails;
  if (d.agentId !== agentId || !text(d.name, 256) || !timestamp(d.capturedAt)
    || !['on', 'busy', 'err', 'off'].includes(d.status) || !isAgentSecurity(d.security)
    || !d.defaultModel || !text(d.defaultModel.model, 1024) || !text(d.defaultModel.provider, 256)
    || !(d.usageError === null || text(d.usageError, 1024))
    || !Array.isArray(d.recentConversations) || d.recentConversations.length > 5
    || !d.recentConversations.every(c => !!c && text(c.id, 256) && c.id.length > 0
      && (c.title === null || text(c.title, 100)) && text(c.originLabel, 256)
      && Number.isSafeInteger(c.messageCount) && c.messageCount >= 0 && timestamp(c.lastActiveAt))) return false;
  if (d.usage === null) return true;
  const usage = d.usage;
  return !!usage && usage.basis === 'conversation_started_at' && usage.includesAuxiliary === false
    && timestamp(usage.capturedAt) && text(usage.timezone, 256)
    && Array.isArray(usage.daily) && usage.daily.length <= 7
    && usage.daily.every(day => !!day && typeof day.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.day))
    && [usage.today, usage.last7days, ...usage.daily].every(v => !!v
      && Number.isSafeInteger(v.tokens) && v.tokens >= 0
      && Number.isSafeInteger(v.conversations) && v.conversations >= 0
      && (v.estimatedCostUsd === null || typeof v.estimatedCostUsd === 'number'
        && Number.isFinite(v.estimatedCostUsd) && v.estimatedCostUsd >= 0));
}
export function agentDetailsCacheKey(scope:string):string{return `relay.agent-details.v1.${Array.from(scope).map(c=>c.codePointAt(0)!.toString(16)).join('-')}`;}
