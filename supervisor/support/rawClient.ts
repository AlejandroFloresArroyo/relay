// A bare client of the supervisor socket: what any process of the account can do with it.
import net from 'node:net';
import path from 'node:path';
import { MIN_SUPERVISOR_PROTOCOL, PUENTE_SUPERVISOR_PROTOCOL, SUPERVISOR_SOCKET_FILE } from '../../protocol/supervisor.ts';

export type Line = Record<string, unknown>;

export function connect(runtime: string) {
  const socket = net.createConnection(path.join(runtime, SUPERVISOR_SOCKET_FILE));
  const lines: Line[] = [];
  const waiters: (() => void)[] = [];
  const closed = Promise.withResolvers<void>();
  let buffer = '';
  const wake = () => { for (const resolve of waiters.splice(0)) resolve(); };
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf('\n')) !== -1) { lines.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); }
    wake();
  });
  socket.on('close', () => { closed.resolve(); wake(); });
  socket.on('error', () => {});
  async function next(): Promise<Line | null> {
    while (lines.length === 0) {
      if (socket.destroyed) return null;
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.push(resolve);
      await promise;
    }
    return lines.shift()!;
  }
  /** The next line that is not an event: responses and handshake lines. */
  async function reply(): Promise<Line | null> {
    for (;;) {
      const line = await next();
      if (line?.type !== 'event') return line;
    }
  }
  const send = (message: unknown) => socket.write(`${JSON.stringify(message)}\n`);
  return { socket, next, reply, send, closed: closed.promise, lines };
}

export const auth = (key: string, extra = {}) => ({ type: 'auth', key, puenteProtocol: PUENTE_SUPERVISOR_PROTOCOL, minSupervisorProtocol: MIN_SUPERVISOR_PROTOCOL, ...extra });
