export interface SseFrame {
  id: string | null;
  event: string | null;
  data: string;
}

// Parses a text/event-stream byte stream into frames. Comment lines (": keepalive") and frames
// without data are dropped.
export async function* parseSse(stream: AsyncIterable<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let id: string | null = null;
  let event: string | null = null;
  let data: string[] = [];

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);

      if (line === '') {
        if (data.length > 0) yield { id, event, data: data.join('\n') };
        id = null;
        event = null;
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
      else if (field === 'event') event = value;
    }
  }
}
