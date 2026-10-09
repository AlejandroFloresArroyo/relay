import { CHAT_INPUT_MAX_BYTES } from '../../../protocol/protocol.ts';
import type { PreparedImage } from './chatImages.ts';
import { conversationRequestId } from './conversations.ts';
export type SharedPayload = { kind: 'text'; text: string } | { kind: 'image'; uri: string; width: number; height: number } | { kind: 'rejected'; reason?: 'queue_full' | 'busy' };
export interface DraftTarget { serverId: string; agentId: string; client: object }
export interface SharedDraft { id: string; text: string; image: PreparedImage | null; target: DraftTarget }
export function shareText(text: string, instruction: string): string {
  const value = [instruction.trim(), text].filter(Boolean).join('\n\n');
  if (new TextEncoder().encode(value).length > CHAT_INPUT_MAX_BYTES) throw new Error('El texto es demasiado largo. Comparte un fragmento más corto.');
  return value;
}
export function validateSharedPayload(raw: unknown): SharedPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  if (data.kind === 'rejected') return { kind: 'rejected', ...(data.reason === 'queue_full' || data.reason === 'busy' ? { reason: data.reason } : {}) };
  if (data.kind === 'text' && typeof data.text === 'string' && data.text.length > 0) {
    try { shareText(data.text, ''); return { kind: 'text', text: data.text }; } catch { return null; }
  }
  if (data.kind === 'image' && typeof data.uri === 'string'
    && /^file:\/\/\/data\/(?:user\/\d+|data)\/[A-Za-z0-9_.]+\/cache\/relay-share\/[a-f0-9-]{36}\/image$/.test(data.uri)
    && Number.isSafeInteger(data.width) && Number.isSafeInteger(data.height) && Number(data.width) > 0 && Number(data.height) > 0
    && Number(data.width) <= 10000 && Number(data.height) <= 10000 && Number(data.width) * Number(data.height) <= 24000000) {
    return { kind: 'image', uri: data.uri, width: Number(data.width), height: Number(data.height) };
  }
  return null;
}
const same = (a: DraftTarget, b: DraftTarget) => a.serverId === b.serverId && a.agentId === b.agentId && a.client === b.client;
export type SendOutcome = 'accepted' | 'uncertain' | 'refused';
// Memory only: an external share is neither an outbox nor authority to create a Turno.
export class DraftStore {
  private rows: SharedDraft[] = [];
  private sending = new Set<string>();
  private locked = false;
  private retired = new WeakSet<object>();
  private retirementRevision = 0;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  retirementSnapshot = () => this.retirementRevision;
  private readonly discard: (image: PreparedImage) => void;
  constructor(discard: (image: PreparedImage) => void = () => {}) { this.discard = discard; }
  private notify() { this.retirementRevision++; for (const listener of this.listeners) listener(); }
  isRetired(client: object) { return this.retired.has(client); }
  retire(client: object) {
    if (this.retired.has(client)) return;
    this.retired.add(client); this.retain((target) => target.client !== client);
    this.notify();
  }
  /** Lock: every draft and its private image go, except a send in flight, which `send` settles. */
  purge() {
    this.locked = true;
    for (const row of [...this.rows]) if (!this.sending.has(row.id)) this.remove(row.id);
    this.notify();
  }
  unlock() { this.locked = false; }
  /**
   * A send holds its row until it resolves. An accepted image belongs to its Turno, and so does an
   * uncertain one under the lock: the row leaves without discarding it and the settle returns true.
   * A refusal while Relay is still locked completes the purge.
   */
  send(id: string) {
    this.sending.add(id);
    return (outcome: SendOutcome) => {
      this.sending.delete(id);
      if (outcome === 'accepted' || (this.locked && outcome === 'uncertain')) { this.remove(id, false); return true; }
      if (this.locked) { this.remove(id); this.notify(); }
      return false;
    };
  }
  read(target: DraftTarget): SharedDraft | null { return this.rows.find((row) => same(row.target, target)) ?? null; }
  byId(target: DraftTarget, id: string): SharedDraft | null { const row = this.read(target); return row?.id === id ? row : null; }
  put(target: DraftTarget, value: { text: string; image: PreparedImage | null }, permitted: () => boolean, replaceId?: string): SharedDraft | null {
    if (this.isRetired(target.client)) return null;
    const text = shareText(value.text, '');
    const old = this.read(target);
    if (!permitted() || (!old && this.rows.length >= 8) || (old && old.id !== replaceId)) return null;
    if (old) this.remove(old.id, old.image?.uri !== value.image?.uri);
    const row = { ...value, text, id: conversationRequestId(), target };
    this.rows.push(row); return row;
  }
  update(target: DraftTarget, id: string, text: string) { const row = this.byId(target, id); if (row) row.text = text; }
  updateImage(target: DraftTarget, id: string, image: PreparedImage | null) { const row = this.byId(target, id); if (row) row.image = image; }
  remove(id: string, discard = true) {
    const row = this.rows.find((item) => item.id === id); this.rows = this.rows.filter((item) => item.id !== id);
    if (discard && row?.image) this.discard(row.image);
  }
  retain(valid: (target: DraftTarget) => boolean) { for (const row of [...this.rows]) if (!valid(row.target)) this.remove(row.id); }
}
