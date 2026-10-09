// Terminals on the Puente's side (ADR 0006 «Canales», protocol/remoteTerminal.ts). The supervisor
// keeps the PTY, the ring and the input order; this module only relays one device's requests to its
// own terminals and each output stream to its HTTP response. Bytes stay base64: never decoded here,
// never logged. Closing a stream detaches; it never terminates anything.
import { randomBytes } from 'node:crypto';
import { TERMINAL_CHANNEL_PATTERN, TERMINAL_INPUT_BYTES, TERMINAL_MAX_COLS, TERMINAL_MAX_ROWS } from '../../../protocol/remoteTerminal.ts';
import type { TerminalInputResponse, TerminalShells, TerminalStreamEvent } from '../../../protocol/remoteTerminal.ts';
import type { BrowserStreamEvent } from '../../../protocol/remoteBrowser.ts';
import type { ChannelEvent, TerminalTarget } from '../../../protocol/supervisor.ts';
import { exactObject } from '../changeLog.ts';
import { remote } from './environments.ts';
import type { PtyHost } from './ports.ts';
import { RemoteError, RemoteStream } from './routes.ts';

/** The `terminal` contract this build serves. */
export const TERMINAL_CAPABILITY = { version: 1, minAppVersion: 1 } as const;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const count = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;


export interface Terminals {
  shells(): Promise<TerminalShells>;
  /** Attaches a new channel after `lastEventId`, then checks the device again before streaming. */
  open(deviceId: string, environmentId: string, lastEventId: unknown, guard: () => void): Promise<RemoteStream<TerminalStreamEvent>>;
  ack(deviceId: string, environmentId: string, body: unknown): Promise<{ ok: true }>;
  input(deviceId: string, environmentId: string, body: unknown): Promise<TerminalInputResponse>;
  resize(deviceId: string, environmentId: string, body: unknown): Promise<{ ok: true }>;
}

interface Channel { deliver(event: ChannelEvent): void; end(): void }
type ChannelPort = Pick<PtyHost, 'attach' | 'detach' | 'onChannel' | 'onDisconnected'>;

/**
 * Supervisor channels as SSE responses, for terminals and browsers alike: each stream is a channel the
 * Puente names, attached after its registration and checked against revocation once attached.
 */
export function channelStreams(port: ChannelPort) {
  const channels = new Map<string, Channel>();
  port.onChannel((event) => channels.get(event.channel)?.deliver(event));
  // The supervisor detached them all when its channel closed.
  port.onDisconnected(() => { for (const channel of [...channels.values()]) channel.end(); });

  return async function open<StreamEvent extends TerminalStreamEvent | BrowserStreamEvent>(target: TerminalTarget, after: number, translate: (event: ChannelEvent, channel: string) => [StreamEvent, number?] | null, guard: () => void): Promise<RemoteStream<StreamEvent>> {
    const id = randomBytes(16).toString('base64url');
    // Frames may come before the attach answer: they wait here, bounded by the window.
    const waiting: [StreamEvent, number?][] = [];
    let send: ((event: StreamEvent, id?: number) => void) | null = null;
    let end: (() => void) | null = null;
    let attached = true;
    const finish = () => {
      if (!channels.delete(id)) return;
      end?.();
    };
    channels.set(id, {
      deliver(event) {
        const out = translate(event, id);
        if (out) { if (send) send(...out); else waiting.push(out); }
        // The supervisor already let this channel go.
        if (event.type === 'closed') { attached = false; finish(); }
      },
      end() { attached = false; finish(); },
    });
    try {
      await remote(port.attach(target, id, after));
    } catch (error) {
      channels.delete(id);
      throw error;
    }
    // Registered first, then checked again: a revocation during the attach closes it (ADR 0006 «Revocación»).
    try { guard(); } catch (error) {
      channels.delete(id);
      void port.detach(target, id).catch(() => {});
      throw error;
    }
    return new RemoteStream((writer, close) => {
      send = writer;
      end = close;
      for (const event of waiting.splice(0)) writer(...event);
      if (!channels.has(id)) close();
      return () => {
        channels.delete(id);
        if (attached) void port.detach(target, id).catch(() => {});
        attached = false;
      };
    });
  };
}

export function createTerminals(pty: PtyHost): Terminals {
  const open = channelStreams(pty);

  return {
    shells: () => remote(pty.shells()),

    async open(deviceId, environmentId, lastEventId, guard) {
      // Last-Event-ID: the last seq the client holds, canonical decimal; none means from the start.
      if (lastEventId !== undefined && (typeof lastEventId !== 'string' || !/^(0|[1-9][0-9]*)$/.test(lastEventId) || !Number.isSafeInteger(Number(lastEventId)))) {
        throw new RemoteError('remote_invalid_request');
      }
      return open<TerminalStreamEvent>({ environmentId, deviceId }, lastEventId === undefined ? 0 : Number(lastEventId), (event, channel) => {
        if (event.type === 'opened') return [{ type: 'open', channel, inputSeq: event.inputSeq }];
        if (event.type === 'output') return [{ type: 'output', seq: event.seq, data: event.data }, event.seq];
        if (event.type === 'gap') return [{ type: 'gap', from: event.from, to: event.to }];
        if (event.type === 'closed') return [{ type: 'closed', reason: event.reason }];
        // A terminal channel never carries browser events.
        return null;
      }, guard);
    },

    async ack(deviceId, environmentId, body) {
      if (!exactObject(body, ['channel', 'seq']) || typeof body.channel !== 'string' || !new RegExp(TERMINAL_CHANNEL_PATTERN).test(body.channel) || !count(body.seq, 0)) {
        throw new RemoteError('remote_invalid_request');
      }
      await remote(pty.ack({ environmentId, deviceId }, body.channel, body.seq));
      return { ok: true };
    },

    async input(deviceId, environmentId, body) {
      if (!exactObject(body, ['seq', 'data']) || !count(body.seq, 1) || typeof body.data !== 'string' || !BASE64.test(body.data)) throw new RemoteError('remote_invalid_request');
      const bytes = body.data.length / 4 * 3 - (body.data.endsWith('==') ? 2 : body.data.endsWith('=') ? 1 : 0);
      if (bytes === 0) throw new RemoteError('remote_invalid_request');
      if (bytes > TERMINAL_INPUT_BYTES) throw new RemoteError('remote_too_large');
      return { inputSeq: await remote(pty.input({ environmentId, deviceId }, body.seq, body.data)) };
    },

    async resize(deviceId, environmentId, body) {
      if (!exactObject(body, ['cols', 'rows'], ['redraw']) || !count(body.cols, 1, TERMINAL_MAX_COLS) || !count(body.rows, 1, TERMINAL_MAX_ROWS)
        || (body.redraw !== undefined && body.redraw !== true)) throw new RemoteError('remote_invalid_request');
      await remote(pty.resize({ environmentId, deviceId }, body.cols, body.rows, body.redraw === true));
      return { ok: true };
    },
  };
}
