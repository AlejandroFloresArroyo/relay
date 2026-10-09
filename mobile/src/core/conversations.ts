import type { Conversation } from '../../../protocol/protocol.ts';

export function conversationTitle(conversation: Conversation | null): string {
  return conversation?.title?.trim() || 'Sin título';
}

/** Creation receipts use UUIDs for idempotency, not credentials. Works without a native dependency. */
export function conversationRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === 'x' ? value : (value & 3) | 8).toString(16);
  });
}
