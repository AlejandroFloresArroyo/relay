import type { RunSnapshot } from '../../../protocol/protocol.ts';
import { mergeTranscript, type ChatItem } from './transcript.ts';

/** A snapshot covers this Turn, never the Conversation history that precedes it. */
export function mergeTurnSnapshot(history: ChatItem[], previous: ChatItem[], snapshot: RunSnapshot): ChatItem[] {
  if (snapshot.complete) return mergeTranscript(previous, [...history, ...snapshot.items]);
  const retained = previous.slice(history.length);
  const keys = (items: ChatItem[]) => {
    let assistant = 1;
    const prefix = `${snapshot.runId}:message:`;
    return items.map((item) => {
      if (item.kind === 'assistant') {
        const ordinal = assistant++;
        return `assistant:${item.id.startsWith(prefix) ? item.id.slice(prefix.length) : ordinal}`;
      }
      return item.kind === 'user' ? item.redirected ? `steer:${item.clientMessageId ?? item.id}` : 'input' : `tool:${item.id}`;
    });
  };
  const retainedKeys = new Map(keys(retained).map((key, index) => [key, index]));
  const incomingKeys = keys(snapshot.items);
  for (let i = 0; i < snapshot.items.length; i++) {
    const incoming = snapshot.items[i];
    const position = retainedKeys.get(incomingKeys[i]);
    if (position === undefined) { retainedKeys.set(incomingKeys[i], retained.length); retained.push(incoming); continue; }
    const old = retained[position];
    // Missing upstream replay is not evidence that the text already on the phone disappeared.
    if (old.kind === 'assistant' && incoming.kind === 'assistant' && old.text.length > incoming.text.length && snapshot.terminal?.type !== 'run.completed') {
      retained[position] = { ...incoming, text: old.text };
    } else retained[position] = incoming;
  }
  return mergeTranscript(previous, [...history, ...retained]);
}
