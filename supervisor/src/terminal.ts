// One terminal's output ring, its window and its input order (ADR 0006 «Salida de terminal y control
// de flujo»). Bytes are never decoded: a frame may end inside a UTF-8 character.
//
// - The ring keeps the newest `ringBytes` of output, in at most `ringFrames` numbered frames; seqs
//   start at 1 with the terminal and survive channels, so a client resumes from the last seq it holds.
//   Reads of a byte or two to a channel that keeps up make a frame each: without the frame bound the
//   ring would hold a million objects and dropping the oldest would move all of them every read.
// - One active channel. At most `windowBytes` sent and unconfirmed. Reading the PTY pauses only when
//   going on would discard bytes the active channel has not confirmed: the program blocks in write.
//   Paused with no ack for `stalledMs`, the channel is stalled: reading resumes and it gets a gap.
// - Without a channel the program never waits: the ring drops the oldest, and a reader that comes
//   back gets a gap with the lost range before the rest.
import { REMOTE_LIMITS } from '../../protocol/protocol.ts';
import { TERMINAL_MAX_COLS, TERMINAL_MAX_ROWS } from '../../protocol/remoteTerminal.ts';
import type { ChannelEvent } from '../../protocol/supervisor.ts';
import type { PtyIo } from './host.ts';
import { SupervisorFailure } from './supervisor.ts';

export interface StreamLimits { frameBytes: number; windowBytes: number; ringBytes: number; ringFrames: number; stalledMs: number }

/** Parts are joined once, when the frame is first sent: until then later reads may still fill it. */
interface Frame { seq: number; parts: Buffer[]; size: number }
interface Channel { id: string; sent: number; acked: number; inflight: number; stalled: boolean }

export class TerminalStream {
  /** Last input seq written to the PTY. */
  inputSeq = 0;
  private readonly pty: PtyIo;
  private readonly emit: (event: ChannelEvent) => void;
  private readonly limits: StreamLimits;
  private frames: Frame[] = [];
  private bytes = 0;
  private nextSeq = 1;
  /** Highest seq any channel ever received: from then on that frame never changes. */
  private published = 0;
  private channel: Channel | null = null;
  private paused = false;
  private stall: NodeJS.Timeout | undefined;
  private ended = false;

  constructor(pty: PtyIo, emit: (event: ChannelEvent) => void, limits: Partial<StreamLimits> = {}) {
    this.pty = pty;
    this.emit = emit;
    this.limits = {
      frameBytes: REMOTE_LIMITS.terminalFrameBytes, windowBytes: REMOTE_LIMITS.channelWindowBytes,
      ringBytes: REMOTE_LIMITS.terminalRingBytes, stalledMs: REMOTE_LIMITS.stalledChannelMs,
      // ponytail: 8192 frames keep the array below V8's large-object size, so shift() stays O(1); a
      // deque if the ring must ever hold more frames.
      ringFrames: 8192, ...limits,
    };
    pty.onData((chunk) => this.read(chunk));
  }

  /** Opens `channel` after seq `after`, replacing the active one. */
  attach(channel: string, after: number): void {
    if (!Number.isSafeInteger(after) || after < 0 || after > this.nextSeq - 1) throw new SupervisorFailure('invalid');
    const previous = this.channel;
    this.channel = { id: channel, sent: after, acked: after, inflight: 0, stalled: false };
    if (previous) this.emit({ channel: previous.id, type: 'closed', reason: 'replaced' });
    this.emit({ channel, type: 'opened', inputSeq: this.inputSeq });
    if (this.paused) this.armStall();
    this.settle();
    this.pump();
  }

  /** Confirms everything up to `seq` on `channel`. A replaced channel's ack no longer counts. */
  ack(channel: string, seq: number): void {
    const active = this.channel;
    if (!active || active.id !== channel) return;
    if (!Number.isSafeInteger(seq) || seq > active.sent) throw new SupervisorFailure('invalid');
    if (seq <= active.acked) return;
    active.acked = seq;
    // Only an ack frees the window. Frames the ring dropped while the channel was stalled no longer
    // count, so a stalled channel may get up to two windows unconfirmed, never more.
    active.inflight = 0;
    const first = this.frames[0]?.seq ?? this.nextSeq;
    for (let i = Math.max(0, seq + 1 - first); i < this.frames.length && this.frames[i]!.seq <= active.sent; i++) active.inflight += this.frames[i]!.size;
    active.stalled = false;
    if (this.paused) this.armStall();
    this.settle();
    this.pump();
  }

  detach(channel: string): void {
    if (this.channel?.id !== channel) return;
    this.channel = null;
    this.settle();
  }

  /** The Puente went away: its channel is gone, without a `closed` event to anyone. */
  detachAny(): void {
    this.channel = null;
    this.settle();
  }

  /** Ended and nothing left to deliver to. */
  get done(): boolean {
    return this.ended && this.channel === null;
  }

  /** Applies input seq `seq`: a retry of an applied one is ignored, a later one is a hole. */
  input(seq: number, data: Buffer): number {
    if (this.ended) throw new SupervisorFailure('ended');
    if (!Number.isSafeInteger(seq) || seq < 1) throw new SupervisorFailure('invalid');
    if (seq <= this.inputSeq) return this.inputSeq;
    if (seq !== this.inputSeq + 1) throw new SupervisorFailure('conflict');
    this.pty.write(data);
    this.inputSeq = seq;
    return seq;
  }

  /** `redraw` passes through another size first: the program gets SIGWINCH even at the same size. */
  resize(cols: number, rows: number, redraw: boolean): void {
    if (this.ended) throw new SupervisorFailure('ended');
    const valid = (value: number, max: number) => Number.isSafeInteger(value) && value >= 1 && value <= max;
    if (!valid(cols, TERMINAL_MAX_COLS) || !valid(rows, TERMINAL_MAX_ROWS)) throw new SupervisorFailure('invalid');
    if (redraw) this.pty.resize(cols, rows > 1 ? rows - 1 : rows + 1);
    this.pty.resize(cols, rows);
  }

  /** The program ended: the active channel still gets every frame, then `closed`. */
  exited(): void {
    this.ended = true;
    this.settle();
    this.pump();
  }

  close(): void {
    clearTimeout(this.stall);
  }

  private read(chunk: Buffer): void {
    const { frameBytes } = this.limits;
    for (let offset = 0; offset < chunk.length;) {
      let frame = this.frames.at(-1);
      if (!frame || frame.seq <= this.published || frame.size >= frameBytes) {
        frame = { seq: this.nextSeq++, parts: [], size: 0 };
        this.frames.push(frame);
      }
      const piece = chunk.subarray(offset, offset + frameBytes - frame.size);
      frame.parts.push(piece);
      frame.size += piece.length;
      this.bytes += piece.length;
      offset += piece.length;
    }
    this.settle();
    this.pump();
  }

  /** Drops what may go and pauses reading only while the ring is full of unconfirmed frames. */
  private settle(): void {
    const { ringBytes, ringFrames } = this.limits;
    const channel = this.channel;
    const guarded = channel !== null && !channel.stalled && !this.ended;
    while ((this.bytes > ringBytes || this.frames.length > ringFrames) && (!guarded || this.frames[0]!.seq <= channel.acked)) this.bytes -= this.frames.shift()!.size;
    const full = guarded && (this.bytes >= ringBytes || this.frames.length >= ringFrames) && this.frames[0]!.seq > channel.acked;
    if (full && !this.paused) {
      this.paused = true;
      this.pty.pause();
      this.armStall();
    } else if (!full && this.paused) {
      this.paused = false;
      clearTimeout(this.stall);
      this.pty.resume();
    }
  }

  private armStall(): void {
    clearTimeout(this.stall);
    this.stall = setTimeout(() => {
      if (!this.channel) return;
      this.channel.stalled = true;
      this.settle();
      this.pump();
    }, this.limits.stalledMs);
    this.stall.unref();
  }

  private pump(): void {
    const channel = this.channel;
    if (!channel) return;
    const last = this.nextSeq - 1;
    while (this.channel === channel && channel.sent < last) {
      // What the ring dropped is one gap, announced right before the frame that follows it.
      const first = this.frames[0]!.seq;
      const next = Math.max(channel.sent + 1, first);
      const frame = this.frames[next - first]!;
      if (channel.inflight + frame.size > this.limits.windowBytes) return;
      if (next > channel.sent + 1) this.emit({ channel: channel.id, type: 'gap', from: channel.sent + 1, to: next - 1 });
      if (frame.parts.length > 1) frame.parts = [Buffer.concat(frame.parts)];
      channel.sent = frame.seq;
      channel.inflight += frame.size;
      this.published = Math.max(this.published, frame.seq);
      this.emit({ channel: channel.id, type: 'output', seq: frame.seq, data: frame.parts[0]!.toString('base64') });
    }
    if (this.ended && this.channel === channel && channel.sent === this.nextSeq - 1) {
      this.channel = null;
      this.emit({ channel: channel.id, type: 'closed', reason: 'exited' });
    }
  }
}
