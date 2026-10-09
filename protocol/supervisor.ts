// The local channel between the Puente and the supervisor (ADR 0006 «Supervisor», #81): one JSON
// object per line over a private Unix socket. Types, constants and the pure record check both sides
// apply; no platform imports.
import { REMOTE_ID_PATTERN, REMOTE_REQUEST_ID_PATTERN } from './protocol.ts';
import type { EnvironmentKind, EnvironmentState, Ownership, RemoteChannelGap, ToolAvailability } from './protocol.ts';
import type { BrowserAction, BrowserActionResult, BrowserStreamEvent, BrowserTab, BrowserView } from './remoteBrowser.ts';
import { TERMINAL_PATH_BYTES } from './remoteTerminal.ts';
import type { TerminalShells } from './remoteTerminal.ts';

/** Each side applies the ADR 0002 rules to the other's version. Both move independently. */
// 2 (#83): terminal records carry shell and cwd, and the channel carries terminal I/O.
// 3 (#92): dedicated browsers: their operations and their frames on the same channels. A version 2
// Puente never asks for them, so this supervisor still serves it.
export const SUPERVISOR_PROTOCOL = 3;
/** Oldest Puente channel version this supervisor serves. */
export const MIN_PUENTE_PROTOCOL = 2;
/** Channel version this Puente speaks. */
export const PUENTE_SUPERVISOR_PROTOCOL = 3;
/** Oldest supervisor this Puente sends operations to; browsers need BROWSER_SUPERVISOR_PROTOCOL. */
export const MIN_SUPERVISOR_PROTOCOL = 2;
export const BROWSER_SUPERVISOR_PROTOCOL = 3;

/** Files in the supervisor's private runtime directory (0700). The key is regenerated at every start. */
export const SUPERVISOR_SOCKET_FILE = 'supervisor.sock';
export const SUPERVISOR_KEY_FILE = 'supervisor.key';
export const SUPERVISOR_KEY_BYTES = 32;
/** A line longer than this closes the connection. */
export const SUPERVISOR_LINE_BYTES = 1_048_576;
/**
 * The programs a dedicated browser runs, in the order the supervisor looks for them in its PATH unless
 * --browser names one; `relayd doctor` looks the same way. Certified: Chromium 152, Chrome 154.
 */
export const DEDICATED_BROWSER_PROGRAMS = ['chromium', 'google-chrome-stable', 'google-chrome', 'chromium-browser'] as const;

/** What the supervisor keeps durably per environment. `deviceId` is opaque to it: ownership is the Puente's. */
export interface EnvironmentRecord {
  id: string;
  deviceId: string;
  kind: EnvironmentKind;
  ownership: Ownership;
  requestId: string;
  createdAt: number;
  state: EnvironmentState;
  /** Main process code once it ended on its own; null when a signal ended it. */
  exitCode: number | null;
  /** Null while processes may remain in the environment's cgroup, including a `lost` one. */
  endedAt: number | null;
  terminationError?: 'supervisor_unreachable' | 'processes_remaining';
  /** Exactly for kind 'terminal'. */
  terminal?: TerminalSpec;
}
export interface TerminalSpec { shell: string; cwd: string }

/** Server → Puente, first line, before any authentication. */
export interface SupervisorHello { type: 'hello'; supervisorProtocol: number; minPuenteProtocol: number }
/** Puente → server. The key is compared in constant time; anything else first closes the socket. */
export interface SupervisorAuth { type: 'auth'; key: string; puenteProtocol: number; minSupervisorProtocol: number }
export interface SupervisorReady { type: 'ready'; availability: ToolAvailability }
export interface SupervisorRefused { type: 'refused'; code: 'unauthorized' | 'incompatible' }

export interface RegisterInput { id: string; deviceId: string; kind: EnvironmentKind; requestId: string; createdAt: number; terminal?: TerminalSpec }
/** Every terminal and browser operation names the device that asks: a foreign one answers `not_found`. */
export interface TerminalTarget { environmentId: string; deviceId: string }
export type SupervisorOperation =
  | { op: 'list' }
  /** Durable record first, nothing launched. The same device and requestId answer the same record. */
  | { op: 'register'; environment: RegisterInput }
  | { op: 'launch'; environmentId: string }
  /** Answers once the environment ended or termination gave up (`terminateGiveUpMs`). */
  | { op: 'terminate'; environmentId: string }
  | { op: 'discard'; environmentId: string }
  | { op: 'shells' }
  /**
   * Opens `channel` on the terminal's output after seq `after`, replacing its previous channel. On a
   * browser it opens its frame and tab stream (`after` is 0).
   */
  | ({ op: 'attach'; channel: string; after: number } & TerminalTarget)
  | ({ op: 'ack'; channel: string; seq: number } & TerminalTarget)
  | ({ op: 'detach'; channel: string } & TerminalTarget)
  /** `data` is base64 of the raw bytes. */
  | ({ op: 'input'; seq: number; data: string } & TerminalTarget)
  | ({ op: 'resize'; cols: number; rows: number; redraw: boolean } & TerminalTarget)
  /** Whether a dedicated browser can be launched here. */
  | { op: 'browserStatus' }
  | ({ op: 'tabs' } & TerminalTarget)
  | ({ op: 'openTab'; url: string | null } & TerminalTarget)
  | ({ op: 'closeTab'; tab: string } & TerminalTarget)
  | ({ op: 'act'; tab: string; action: BrowserAction } & TerminalTarget)
  | ({ op: 'view'; channel: string; view: BrowserView } & TerminalTarget);
export type SupervisorRequest = SupervisorOperation & { id: number };

/** `unsupported`: the browser lacks the method. `limited`: the tab has a limitation (an internal page). */
export type SupervisorErrorCode = 'not_found' | 'conflict' | 'limit' | 'alive' | 'launch_failed' | 'invalid' | 'unavailable' | 'ended' | 'permission' | 'unsupported' | 'limited';
export type SupervisorResponse =
  | {
    type: 'response'; id: number; ok: true; environments?: EnvironmentRecord[]; environment?: EnvironmentRecord; created?: boolean; inputSeq?: number;
    shells?: TerminalShells; availability?: ToolAvailability; tabs?: BrowserTab[]; tab?: BrowserTab; result?: BrowserActionResult;
  }
  | { type: 'response'; id: number; ok: false; code: SupervisorErrorCode };

/** Audit facts only the supervisor sees, queued until a Puente is connected to log them. */
export interface SupervisorEvent { type: 'event'; action: 'terminated' | 'terminate_failed' | 'lost' | 'discarded'; environmentId: string }

/**
 * One attached channel's stream, in order, only to the connected Puente and never queued for a later
 * one: when the Puente goes away every channel is detached. `opened` comes first, before any frame.
 */
export type ChannelEvent = { channel: string } & (
  | { type: 'opened'; inputSeq: number }
  | { type: 'output'; seq: number; data: string }
  | RemoteChannelGap
  | { type: 'closed'; reason: 'replaced' | 'exited' }
  /** Browser streams: the same events the phone gets, besides `open` and `closed`. */
  | Extract<BrowserStreamEvent, { type: 'frame' | 'oversized' | 'tabs' | 'download' }>
);

const KINDS = ['terminal', 'browser_dedicated', 'browser_habitual'];
const STATES = ['starting', 'running', 'terminating', 'exited', 'lost'];
const RECORD_KEYS = ['id', 'deviceId', 'kind', 'ownership', 'requestId', 'createdAt', 'state', 'exitCode', 'endedAt'];
const OPTIONAL_KEYS = ['terminationError', 'terminal'];

/** An absolute path without NUL, well-formed, at most TERMINAL_PATH_BYTES in UTF-8. */
export function validTerminalPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0') && value.isWellFormed()
    && new TextEncoder().encode(value).length <= TERMINAL_PATH_BYTES;
}
function validSpec(value: unknown): value is TerminalSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const spec = value as Record<string, unknown>;
  return Object.keys(spec).length === 2 && validTerminalPath(spec.shell) && validTerminalPath(spec.cwd);
}
const time = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Exactly an EnvironmentRecord: what the registry stores and what the Puente accepts from the channel. */
export function validEnvironmentRecord(value: unknown): value is EnvironmentRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!RECORD_KEYS.every((key) => Object.hasOwn(record, key)) || !keys.every((key) => RECORD_KEYS.includes(key) || OPTIONAL_KEYS.includes(key))) return false;
  const { id, deviceId, kind, ownership, requestId, createdAt, state, exitCode, endedAt, terminationError, terminal } = record;
  return typeof id === 'string' && new RegExp(REMOTE_ID_PATTERN).test(id) && id.startsWith('env_')
    && typeof deviceId === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(deviceId)
    && KINDS.includes(kind as string) && (ownership === 'own' || ownership === 'shared')
    && typeof requestId === 'string' && new RegExp(REMOTE_REQUEST_ID_PATTERN).test(requestId)
    && time(createdAt) && STATES.includes(state as string)
    && (exitCode === null || (typeof exitCode === 'number' && Number.isSafeInteger(exitCode)))
    && (endedAt === null || time(endedAt))
    && (terminationError === undefined || (state === 'terminating' && (terminationError === 'supervisor_unreachable' || terminationError === 'processes_remaining')))
    && (kind === 'terminal' ? validSpec(terminal) : terminal === undefined)
    // Ended means no process can remain: only exited and lost end, and exited always ended.
    && (endedAt === null || state === 'exited' || state === 'lost') && (state !== 'exited' || endedAt !== null);
}
