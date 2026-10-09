// One terminal's connection on the app's side (ADR 0006 «Salida de terminal y control de flujo», #83's
// contract in protocol/remoteTerminal.ts). Output frames wait here until the terminal view pulls them;
// a frame is acknowledged only after the view wrote it, so the Puente's window bounds this queue and a
// view that falls behind slows the program, never Relay's memory. Closing disconnects; it never
// terminates, interrupts or sends anything to the program.
import { TERMINAL_CHANNEL_PATTERN, TERMINAL_INPUT_BYTES, TERMINAL_MAX_COLS, TERMINAL_MAX_ROWS } from '../../../protocol/remoteTerminal.ts';
import { boardWebBase64 } from './boardWeb.ts';
import type { RemoteClient } from './remoteClient.ts';
import { RemoteFailure } from './remoteClient.ts';

/** The terminal requests of one environment. Each call may use a fresh remote client. */
export interface TerminalPort {
  stream(lastEventId: number, onData: (data: string) => void, signal: AbortSignal): Promise<void>;
  ack(channel: string, seq: number): Promise<unknown>;
  input(seq: number, data: string): Promise<unknown>;
  resize(cols: number, rows: number, redraw: boolean): Promise<unknown>;
}

export function terminalPort(client: () => RemoteClient, environmentId: string): TerminalPort {
  const base = `/v1/remote/terminals/${environmentId}`;
  return {
    stream: (lastEventId, onData, signal) => client().stream(`${base}/output`, lastEventId, onData, signal),
    ack: (channel, seq) => client().request('POST', `${base}/ack`, { channel, seq }),
    input: (seq, data) => client().request('POST', `${base}/input`, { seq, data }),
    resize: (cols, rows, redraw) => client().request('POST', `${base}/resize`, redraw ? { cols, rows, redraw: true } : { cols, rows }),
  };
}

export type TerminalLink =
  | { state: 'connecting' }
  | { state: 'connected' }
  /** Lost: the program keeps running; Relay reconnects from the last frame it holds. */
  | { state: 'reconnecting'; message: string }
  /** Another stream of this terminal took over; nothing reconnects until asked. */
  | { state: 'replaced' }
  /** The program ended and every frame arrived. */
  | { state: 'exited' }
  /** Not recoverable: it ended without this view, the Servidor lost it, or it no longer exists. */
  | { state: 'ended'; message: string }
  | { state: 'failed'; message: string }
  /** Closed by Relay: left, suspended or revoked. */
  | { state: 'closed' };

export interface TerminalSession {
  link(): TerminalLink;
  subscribe(listener: () => void): () => void;
  /** Base64 output frames, in order. Acknowledges what the previous pull returned: the view wrote it. */
  pull(): Promise<string[]>;
  /** Input typed or pasted while connected. Anything typed while not connected is dropped. */
  write(text: string): void;
  resize(cols: number, rows: number): void;
  /** After `replaced` or `failed`: opens the stream again from the last frame held. */
  reconnect(): void;
  close(): void;
}

export interface SessionOptions {
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Base64 characters per pull, at least one frame. */
  pullChars?: number;
}

export const BACKOFF_MS = [1000, 2000, 5000, 10_000];
const CHANNEL = new RegExp(TERMINAL_CHANNEL_PATTERN);
export const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const seqOk = (value: unknown, min: number): value is number => Number.isSafeInteger(value) && (value as number) >= min;

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  return promise;
}

class BadEvent extends Error {}

export function createTerminalSession(port: TerminalPort, options: SessionOptions = {}): TerminalSession {
  const wait = options.wait ?? sleep;
  const pullChars = options.pullChars ?? 96 * 1024;
  const listeners = new Set<() => void>();
  let link: TerminalLink = { state: 'connecting' };
  let stopped = false;
  let running = false;
  let controller: AbortController | null = null;
  let attempt = 0;
  let ending: 'replaced' | 'exited' | null = null;

  // Output: `received` is the Last-Event-ID; `written` is what the view confirmed by pulling again.
  const frames: { seq: number; data: string }[] = [];
  let received = 0;
  let delivered = 0;
  let written = 0;
  let wake: (() => void) | null = null;

  // Per channel.
  let channel: string | null = null;
  let acked = 0;
  let acking = false;
  let inputSeq = 0;
  let sentSize: string | null = null;

  // Input: one frame in flight, the rest waiting; a frame in flight survives a reconnection.
  let pending: Uint8Array = new Uint8Array(0);
  let inflight: { seq: number; data: string } | null = null;
  let sending = false;

  let size: { cols: number; rows: number } | null = null;
  let redraw = false;
  let resizing = false;

  const set = (next: TerminalLink) => { link = next; for (const listener of [...listeners]) listener(); };
  const awaken = () => { const resolve = wake; wake = null; resolve?.(); };

  function sendAck() {
    if (acking || !channel || written <= acked) return;
    const on = channel, seq = written;
    acking = true;
    port.ack(on, seq).then(() => {
      acking = false;
      if (channel === on && seq > acked) acked = seq;
      sendAck();
    }, () => { acking = false; });
  }

  function pump() {
    if (sending || !channel || link.state !== 'connected') return;
    if (!inflight) {
      if (!pending.length) return;
      const bytes = pending.subarray(0, TERMINAL_INPUT_BYTES);
      pending = pending.slice(bytes.length);
      inflight = { seq: inputSeq + 1, data: boardWebBase64(bytes) };
    }
    const frame = inflight, on = channel;
    sending = true;
    port.input(frame.seq, frame.data).then((body) => {
      sending = false;
      const applied = (body as { inputSeq?: unknown } | null)?.inputSeq;
      if (inflight === frame) inflight = null;
      if (seqOk(applied, frame.seq)) inputSeq = applied;
      if (channel === on) pump();
    }, (error: unknown) => {
      sending = false;
      if (channel !== on) return;
      // A hole or a lost answer: the next `open` tells which input seq was applied, and the frame
      // is sent again (a retry of an applied seq is ignored) or dropped.
      if (error instanceof RemoteFailure && (error.kind === 'no_response' || error.code === 'remote_conflict' || error.code === 'remote_unavailable')) controller?.abort();
      else if (!(error instanceof RemoteFailure && error.code === 'remote_ended')) { if (inflight === frame) inflight = null; pump(); }
    });
  }

  function sendSize() {
    if (resizing || !size || !channel || link.state !== 'connected') return;
    const { cols, rows } = size, key = `${cols}x${rows}`, again = redraw;
    if (key === sentSize && !again) return;
    resizing = true;
    redraw = false;
    port.resize(cols, rows, again).then(() => {
      resizing = false;
      sentSize = key;
      sendSize();
    }, () => {
      resizing = false;
      // Sent again on the next `open`.
      if (again) redraw = true;
    });
  }

  function onData(text: string) {
    let event: { type?: unknown; [key: string]: unknown };
    try { event = JSON.parse(text); } catch { throw new BadEvent(); }
    if (typeof event !== 'object' || event === null) throw new BadEvent();
    if (event.type === 'open') {
      if (typeof event.channel !== 'string' || !CHANNEL.test(event.channel) || !seqOk(event.inputSeq, 0)) throw new BadEvent();
      channel = event.channel;
      acked = received;
      sentSize = null;
      inputSeq = event.inputSeq;
      if (inflight && inflight.seq <= inputSeq) inflight = null;
      else if (inflight) inflight = { ...inflight, seq: inputSeq + 1 };
      attempt = 0;
      set({ state: 'connected' });
      pump();
      sendSize();
      sendAck();
    } else if (event.type === 'output') {
      if (!seqOk(event.seq, 1) || typeof event.data !== 'string' || !BASE64.test(event.data)) throw new BadEvent();
      if (event.seq <= received) return;
      received = event.seq;
      frames.push({ seq: event.seq, data: event.data });
      awaken();
    } else if (event.type === 'gap') {
      if (!seqOk(event.from, 1) || !seqOk(event.to, event.from)) throw new BadEvent();
      if (event.to > received) received = event.to;
      // What was lost may have been a full-screen program's drawing: ask it to repaint.
      redraw = true;
      sendSize();
    } else if (event.type === 'closed') {
      if (event.reason !== 'replaced' && event.reason !== 'exited') throw new BadEvent();
      ending = event.reason;
    } else throw new BadEvent();
  }

  async function run() {
    if (running) return;
    running = true;
    while (!stopped) {
      ending = null;
      controller = new AbortController();
      let failure: unknown = null;
      try { await port.stream(received, onData, controller.signal); } catch (error) { failure = error; }
      channel = null;
      if (stopped) break;
      if (ending) { set({ state: ending }); break; }
      if (failure instanceof RemoteFailure && failure.kind === 'remote' && (failure.code === 'remote_ended' || failure.code === 'remote_not_found')) {
        set({ state: 'ended', message: failure.message });
        break;
      }
      const retry = failure === null || controller.signal.aborted || (failure instanceof RemoteFailure
        && (['no_response', 'not_offered', 'bridge_changed'].includes(failure.kind) || failure.code === 'remote_unavailable'));
      if (!retry) {
        set({ state: 'failed', message: failure instanceof RemoteFailure ? failure.message : 'El Puente respondió algo inesperado.' });
        break;
      }
      set({ state: 'reconnecting', message: failure instanceof RemoteFailure ? failure.message : 'Se cortó la conexión.' });
      // A deliberate restart (input hole) reopens at once.
      if (!controller.signal.aborted) await wait(BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]!, (controller = new AbortController()).signal);
    }
    running = false;
  }

  void run();

  return {
    link: () => link,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async pull() {
      if (delivered > written) { written = delivered; sendAck(); }
      // Waits until output comes or the session closes: an ended terminal's view simply idles.
      while (!frames.length && !stopped) {
        const { promise, resolve } = Promise.withResolvers<void>();
        wake = resolve;
        await promise;
      }
      const batch: string[] = [];
      let chars = 0;
      while (frames.length && (batch.length === 0 || chars + frames[0]!.data.length <= pullChars)) {
        const frame = frames.shift()!;
        batch.push(frame.data);
        chars += frame.data.length;
        delivered = frame.seq;
      }
      return batch;
    },
    write(text) {
      if (link.state !== 'connected' || !text) return;
      const bytes = new TextEncoder().encode(text);
      const next = new Uint8Array(pending.length + bytes.length);
      next.set(pending);
      next.set(bytes, pending.length);
      pending = next;
      pump();
    },
    resize(cols, rows) {
      if (!seqOk(cols, 1) || !seqOk(rows, 1)) return;
      size = { cols: Math.min(cols, TERMINAL_MAX_COLS), rows: Math.min(rows, TERMINAL_MAX_ROWS) };
      sendSize();
    },
    reconnect() {
      if (stopped || running) return;
      attempt = 0;
      set({ state: 'connecting' });
      void run();
    },
    close() {
      if (stopped) return;
      stopped = true;
      controller?.abort();
      set({ state: 'closed' });
      awaken();
    },
  };
}
