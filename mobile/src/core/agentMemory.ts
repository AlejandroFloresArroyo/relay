import { AGENT_MEMORY_MAX_BYTES } from '../../../protocol/agentMemory.ts';
import type { AgentMemory, AgentSoul, MemoryBucketSnapshot } from '../../../protocol/agentMemory.ts';
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const timestamp = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000_000;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const revision = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown, maximum = AGENT_MEMORY_MAX_BYTES): v is string => typeof v === 'string' && v.length <= maximum && utf8Bytes(v) <= maximum && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v);
export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const c of value) {
    const point = c.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
function isBucket(value: unknown): value is MemoryBucketSnapshot {
  if (!record(value) || typeof value.exists !== 'boolean' || !revision(value.revision) || !count(value.characters)
    || !(value.limit === null || count(value.limit) && value.limit <= 100_000_000) || typeof value.writable !== 'boolean'
    || !(value.reason === null || text(value.reason, 1024)) || !Array.isArray(value.notes) || value.notes.length > AGENT_MEMORY_MAX_BYTES / 4
    || value.writable && (!value.exists || value.limit === null)) return false;
  let bytes = 0, characters = 0;
  const ids = new Set<string>();
  for (const n of value.notes) {
    if (!record(n) || !revision(n.id) || ids.has(n.id) || !text(n.text) || !n.text) return false;
    ids.add(n.id); bytes += utf8Bytes(n.text); characters += [...n.text].length;
    if (bytes > AGENT_MEMORY_MAX_BYTES) return false;
  }
  return characters + Math.max(0, value.notes.length - 1) * 3 === value.characters
    && (value.exists || value.notes.length === 0 && value.characters === 0);
}
export function isAgentMemory(value: unknown, agentId: string): value is AgentMemory {
  return record(value) && value.agentId === agentId && timestamp(value.capturedAt) && record(value.buckets)
    && isBucket(value.buckets.memory) && isBucket(value.buckets.user);
}
export function isAgentSoul(value: unknown, agentId: string): value is AgentSoul {
  return record(value) && value.agentId === agentId && timestamp(value.capturedAt) && typeof value.exists === 'boolean'
    && revision(value.revision) && text(value.content) && value.characters === [...value.content].length
    && (value.contextLimit === null || count(value.contextLimit) && value.contextLimit > 0 && value.contextLimit <= 100_000_000)
    && typeof value.writable === 'boolean' && (value.reason === null || text(value.reason, 1024))
    && (value.exists || value.content === '');
}
export function agentMemoryCacheKey(scope: string, kind: 'memory' | 'soul'): string {
  return `relay.agent-${kind}.v1.${Array.from(scope).map(c => c.codePointAt(0)!.toString(16)).join('-')}`;
}
