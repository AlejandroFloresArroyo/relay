// The `terminal` capability (ADR 0006 «Canales», #83). A terminal is an environment of kind
// 'terminal' and is addressed by its environment ID. Transport: an SSE stream for the output and
// plain POSTs for acks, input and size, all through the same route() as every request (key,
// limiter, guardAuthorization, protocol and capability checks). The key never goes in a URL.
// Types and constants only; no platform imports.
import type { RemoteChannelGap } from './protocol.ts';

/** POST /v1/remote/environments for a terminal: an installed shell and an existing folder. */
export interface TerminalCreateRequest { requestId: string; kind: 'terminal'; shell: string; cwd: string }

/** GET /v1/remote/shells: the installed shells (/etc/shells entries that can run) and the account's. */
export interface TerminalShells { shells: string[]; defaultShell: string | null; home: string }

// GET /v1/remote/terminals/:id/output: text/event-stream, one JSON object per `data:` line.
// Output seqs belong to the terminal, not to one connection: they start at 1 when the terminal starts
// and survive reconnections and Puente restarts. The request carries `Last-Event-ID` with the last seq
// the client holds (none = 0). What the ring no longer holds arrives as a gap before the rest.
// Opening a stream replaces the terminal's previous one, which ends with `closed: replaced`.
export type TerminalStreamEvent =
  /** First event. `inputSeq` is the last input seq applied: the client continues from it. */
  | { type: 'open'; channel: string; inputSeq: number }
  /** Raw PTY bytes in base64, never decoded by the Puente: a UTF-8 character may span two frames. */
  | { type: 'output'; seq: number; data: string }
  | RemoteChannelGap
  /** Last event before the stream ends. `exited`: every frame was delivered and the program ended. */
  | { type: 'closed'; reason: 'replaced' | 'exited' };

/** POST …/:id/ack: the last output seq received on `channel`. Frees the window and the ring. */
export interface TerminalAckRequest { channel: string; seq: number }

/**
 * POST …/:id/input: raw bytes in base64, at most TERMINAL_INPUT_BYTES decoded. Input seqs belong to
 * the terminal and start at 1: the next one is applied, an older one is a retry and is ignored,
 * a later one is refused (remote_conflict) and the client reopens the stream to learn `inputSeq`.
 * A paste larger than a frame is split into ordered frames, never cut.
 */
export interface TerminalInputRequest { seq: number; data: string }
export interface TerminalInputResponse { inputSeq: number }

/** POST …/:id/resize. `redraw` makes a full-screen program repaint (after a gap) at the same size. */
export interface TerminalResizeRequest { cols: number; rows: number; redraw?: true }

/** Decoded bytes per input frame: its base64 JSON body stays under REMOTE_LIMITS.controlBodyBytes. */
export const TERMINAL_INPUT_BYTES = 32_768;
export const TERMINAL_MAX_COLS = 1000;
export const TERMINAL_MAX_ROWS = 1000;
/** Channel IDs: random, chosen by the Puente for each stream. */
export const TERMINAL_CHANNEL_PATTERN = '^[A-Za-z0-9_-]{22}$';
/** A path the Puente passes to the supervisor: absolute, without NUL, bounded. */
export const TERMINAL_PATH_BYTES = 4096;
