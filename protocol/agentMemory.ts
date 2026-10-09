// Payload bounds protect transport and storage; they are not Hermes context quotas.
export const AGENT_MEMORY_MAX_BYTES = 1024 * 1024;
export const AGENT_MEMORY_REQUEST_MAX_BYTES = 6 * AGENT_MEMORY_MAX_BYTES + 4096;
export const AGENT_MEMORY_RESPONSE_MAX_BYTES = 12 * AGENT_MEMORY_MAX_BYTES + 4096;
export type MemoryBucket = 'memory' | 'user';
export interface MemoryNote { id: string; text: string }
export interface MemoryBucketSnapshot {
  exists: boolean; revision: string; notes: MemoryNote[]; characters: number;
  limit: number | null; writable: boolean; reason: string | null;
}
export interface AgentMemory {
  agentId: string; capturedAt: number;
  buckets: Record<MemoryBucket, MemoryBucketSnapshot>;
}
export interface AgentSoul {
  agentId: string; capturedAt: number; exists: boolean; revision: string;
  content: string; characters: number; contextLimit: number | null;
  writable: boolean; reason: string | null;
}
export interface MemoryChange { bucket: MemoryBucket; revision: string; noteId: string; content: string | null }
export interface SoulChange { revision: string; content: string }
export type AgentMemoryErrorCode = 'agent_memory_unavailable' | 'agent_memory_read_only' | 'agent_memory_conflict' | 'agent_memory_invalid' | 'agent_memory_limit' | 'agent_memory_busy' | 'agent_memory_uncertain';
export const AGENT_MEMORY_ERROR_STATUS: Record<AgentMemoryErrorCode, number> = {
  agent_memory_unavailable:503, agent_memory_read_only:403, agent_memory_conflict:409,
  agent_memory_invalid:400, agent_memory_limit:400, agent_memory_busy:409, agent_memory_uncertain:503,
};
export const AGENT_MEMORY_MESSAGES: Record<AgentMemoryErrorCode, string> = {
  agent_memory_unavailable:'La memoria o personalidad de este Agente no está disponible.',
  agent_memory_read_only:'Solo lectura: no se puede verificar la configuración efectiva del Agente.',
  agent_memory_conflict:'El archivo cambió en el Servidor. Recarga antes de guardar; conserva tu texto.',
  agent_memory_invalid:'El texto o la nota no es válido.',
  agent_memory_limit:'La memoria supera el límite del Agente. Acorta la nota.',
  agent_memory_busy:'Hermes está actualizando este archivo. Reintenta en un momento.',
  agent_memory_uncertain:'El guardado quedó sin confirmar. Recarga antes de repetirlo.',
};
