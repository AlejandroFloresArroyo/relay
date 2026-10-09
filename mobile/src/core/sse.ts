// Minimal SSE decoder. Preserve the Puente sequence so consumers can ignore replayed frames.
export function createSseDecoder(onData: (data: string, eventId?: number) => void) {
  let buffer = '';
  let dataLines: string[] = [];
  let eventId: number | undefined;

  const flush = () => {
    if (dataLines.length) onData(dataLines.join('\n'), eventId);
    dataLines = [];
    eventId = undefined;
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line === '') flush();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        else if (/^id: *[0-9]+$/.test(line)) {
          const parsed = Number(line.slice(3).trim());
          if (Number.isSafeInteger(parsed)) eventId = parsed;
        }
      }
    },
    end() {
      flush();
    },
  };
}
