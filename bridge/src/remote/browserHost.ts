// Native messaging host of the Relay extension (#93): the local adapter between the extension (stdio,
// 4-byte length + JSON) and the Puente (its private Unix socket, one JSON object per line). Chrome
// starts it through the wrapper registerNativeHost writes, as
//   relay-browser-host <socket> <chrome-extension://id/> [--parent-window=…]
// It adds the caller's origin, which only Chrome knows, to the extension's hello, and enforces the
// native messaging limits. It imports nothing from the Puente: it starts with every connection.
import { connect } from 'node:net';

/** Chrome drops the host on a host-to-browser message over 1 MB; such a request is refused here. */
const MAX_TO_BROWSER = 1024 * 1024;
/** Browser-to-host messages are the extension's answers: a frame is at most ≈933 000 characters. */
const MAX_FROM_BROWSER = 1024 * 1024;

const [socketPath, origin] = process.argv.slice(2);
if (!socketPath || !origin) process.exit(2);
const puente = connect(socketPath);

function toBrowser(body: Buffer): void {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}

function toPuente(message: unknown): void {
  puente.write(`${JSON.stringify(message)}\n`);
}

let fromPuente = '';
puente.setEncoding('utf8');
puente.on('data', (chunk: string) => {
  fromPuente += chunk;
  let index: number;
  while ((index = fromPuente.indexOf('\n')) !== -1) {
    const line = fromPuente.slice(0, index);
    fromPuente = fromPuente.slice(index + 1);
    const body = Buffer.from(line);
    if (body.length > MAX_TO_BROWSER) {
      const id = /^\{"id":(\d+),/.exec(line)?.[1];
      toPuente({ type: 'response', id: id === undefined ? null : Number(id), ok: false, code: 'too_large' });
      continue;
    }
    toBrowser(body);
  }
  // A line that never ends is not the Puente's: stop.
  if (fromPuente.length > 2 * MAX_TO_BROWSER) process.exit(1);
});

let fromBrowser = Buffer.alloc(0);
process.stdin.on('data', (chunk: Buffer) => {
  fromBrowser = Buffer.concat([fromBrowser, chunk]);
  while (fromBrowser.length >= 4) {
    const size = fromBrowser.readUInt32LE(0);
    if (size > MAX_FROM_BROWSER) process.exit(1);
    if (fromBrowser.length < 4 + size) break;
    let message: unknown;
    try { message = JSON.parse(fromBrowser.subarray(4, 4 + size).toString('utf8')); } catch { process.exit(1); }
    fromBrowser = fromBrowser.subarray(4 + size);
    // Chrome names the caller; the Puente checks it against the extension it installed.
    toPuente(typeof message === 'object' && message !== null && 'type' in message && message.type === 'hello' ? { ...message, origin } : message);
  }
});

// Either side going away ends the host; Chrome then reports the port as disconnected.
process.stdin.on('end', () => process.exit(0));
puente.on('close', () => process.exit(0));
puente.on('error', () => process.exit(1));
