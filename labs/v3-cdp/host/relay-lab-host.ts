// Native messaging host: the local adapter between the extension (stdio, 4-byte length + JSON) and
// the Puente (a Unix socket, one JSON object per line). Chrome starts it as
//   host.sh <chrome-extension://id/> [--parent-window=…]
// and the lab wrapper puts the Puente socket path first.
import { connect } from 'node:net';
import { createInterface } from 'node:readline';

/** Chrome refuses host-to-browser messages over 1 MB and drops the host; refuse them here instead. */
const MAX_TO_BROWSER = 1024 * 1024;

const [socketPath, origin] = process.argv.slice(2);
const puente = connect(socketPath);

function toBrowser(message: unknown) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}

function toPuente(message: unknown) {
  puente.write(`${JSON.stringify(message)}\n`);
}

createInterface({ input: puente, crlfDelay: Infinity }).on('line', (line) => {
  let message: { id?: unknown };
  try {
    message = JSON.parse(line);
  } catch {
    return toPuente({ ok: false, error: 'invalid json' });
  }
  if (Buffer.byteLength(line) > MAX_TO_BROWSER) return toPuente({ id: message.id, ok: false, error: 'request too large' });
  toBrowser(message);
});

let pending = Buffer.alloc(0);
process.stdin.on('data', (chunk: Buffer) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const size = pending.readUInt32LE(0);
    if (pending.length < 4 + size) break;
    const message = JSON.parse(pending.subarray(4, 4 + size).toString('utf8'));
    pending = pending.subarray(4 + size);
    // Chrome tells the host who called it; the Puente can check it against the expected extension.
    toPuente(message.event === 'hello' ? { ...message, origin } : message);
  }
});

// Either side going away ends the host; Chrome then reports the port as disconnected.
process.stdin.on('end', () => process.exit(0));
puente.on('close', () => process.exit(0));
puente.on('error', () => process.exit(1));
