// One interface per remote tool boundary (ADR 0006 «Módulos»). Their implementations bring PTY and
// browser dependencies; those live in the supervisor, never in the Hermes core of the Puente, which
// imports nothing from remote/. Doubles: bridge/support/fake_remote.ts. An availability() that
// rejects counts as unavailable (routes.ts `ask`): `helper_stopped` for what lives in the supervisor.
import type { CapabilityAdvertisement, RemoteOperation, ToolAvailability } from '../../../protocol/protocol.ts';
import type { BrowserAction, BrowserActionResult, BrowserTab, BrowserView } from '../../../protocol/remoteBrowser.ts';
import type { TerminalShells } from '../../../protocol/remoteTerminal.ts';
import type { ChannelEvent, EnvironmentRecord, RegisterInput, SupervisorEvent, TerminalTarget } from '../../../protocol/supervisor.ts';
import type {
  RemoteFileDownload, RemoteFileEntry, RemoteFileList, RemoteFileSave, RemoteFileSaved, RemoteFileSearchEvent, RemoteFileText, RemoteFileUpload,
} from '../../../protocol/remoteFiles.ts';
import type { ChangeRecord } from '../changeLog.ts';
import type { RemoteStream } from './routes.ts';

/**
 * Environments and their ownership: the supervisor, a separate systemd user unit, never a child of
 * the Puente. Operations reject when it does not answer (supervisorClient.ts).
 */
export interface Supervisor {
  availability(): Promise<ToolAvailability>;
  list(): Promise<EnvironmentRecord[]>;
  register(input: RegisterInput): Promise<{ environment: EnvironmentRecord; created: boolean }>;
  launch(id: string): Promise<EnvironmentRecord>;
  terminate(id: string): Promise<EnvironmentRecord>;
  discard(id: string): Promise<void>;
  /** Every time the channel is established: the reconciliation runs then. */
  onConnected(listener: () => void): void;
  onEvent(listener: (event: SupervisorEvent) => void): void;
}
/**
 * Terminals inside the supervisor (node-pty 1.1.0, compiled on the Server). Every operation names the
 * device that asks; a terminal of another device is `not_found`. Input is base64 of raw bytes.
 */
export interface PtyHost {
  availability(): Promise<ToolAvailability>;
  shells(): Promise<TerminalShells>;
  attach(target: TerminalTarget, channel: string, after: number): Promise<void>;
  ack(target: TerminalTarget, channel: string, seq: number): Promise<void>;
  detach(target: TerminalTarget, channel: string): Promise<void>;
  input(target: TerminalTarget, seq: number, data: string): Promise<number>;
  resize(target: TerminalTarget, cols: number, rows: number, redraw: boolean): Promise<void>;
  /** Every attached channel's stream, in order. */
  onChannel(listener: (event: ChannelEvent) => void): void;
  /** The supervisor channel closed: the supervisor detached every channel. */
  onDisconnected(listener: () => void): void;
}
/** Who writes: `guard` is the revocation check, called right before each effect; `actor` goes to changes.jsonl. */
export interface FileWriteContext { guard: () => void; actor: ChangeRecord['actor']; deviceId: string }
/**
 * The Server's files with the Puente account's permissions: structured fs operations, never a shell
 * (files.ts). Bodies arrive unvalidated. Every write records remote.file.<action> before its effect.
 */
export interface RemoteFileSystem {
  availability(): Promise<ToolAvailability>;
  list(body: unknown): Promise<RemoteFileList>;
  read(body: unknown): RemoteFileText;
  /** #114: a regular file a Turno may name, by its real path; Puente data is refused. No byte is read. */
  reference(body: unknown): { path: string; realPath: string };
  create(body: unknown, context: FileWriteContext): Promise<RemoteFileEntry>;
  move(body: unknown, context: FileWriteContext): Promise<RemoteFileEntry>;
  delete(body: unknown, context: FileWriteContext): Promise<{ ok: true }>;
  startSave(body: unknown, context: FileWriteContext): RemoteFileSave;
  saveChunk(id: string, offset: string, bytes: Buffer, context: FileWriteContext): RemoteFileSave;
  commitSave(id: string, body: unknown, context: FileWriteContext): Promise<RemoteFileSaved>;
  startUpload(body: unknown, context: FileWriteContext): RemoteFileUpload;
  uploadChunk(id: string, offset: string, bytes: Buffer, context: FileWriteContext): RemoteFileUpload;
  commitUpload(id: string, body: unknown, context: FileWriteContext): Promise<RemoteFileEntry>;
  startDownload(body: unknown, context: FileWriteContext): RemoteFileDownload;
  /** Raw bytes: the server answers them as application/octet-stream. */
  downloadChunk(id: string, offset: string, context: FileWriteContext): Buffer;
  startSearch(body: unknown, context: FileWriteContext): RemoteOperation;
  events(id: string, lastEventId: unknown, context: FileWriteContext): RemoteStream<RemoteFileSearchEvent>;
  ack(id: string, body: unknown, context: FileWriteContext): { ok: true };
  /** POST /v1/remote/operations/:id/cancel for any file operation: idempotent, answers what really happened. */
  cancel(id: string, context: FileWriteContext): RemoteOperation;
  /** After every change of the device store: what a device outside `active` started ends, temporary files included. */
  retain(active: ReadonlySet<string>): void;
}
/** A TCP socket listening for the Puente's account, as the kernel reports it. */
export interface ListeningSocket {
  /** As bound: a loopback literal, a wildcard (`0.0.0.0`, `::`) or another address. */
  address: string;
  port: number;
  pid: number | null;
  /** Null when the owning process cannot be read: such a socket is never offered. */
  process: { name: string; exe: string; cwd: string } | null;
}
/**
 * Discovery of local web apps ("en Relay"): the account's listening sockets, read from the socket
 * table (linuxSockets.ts). It never connects to a port, so no protected endpoint is probed.
 */
export interface AppRegistry { availability(): Promise<ToolAvailability>; listening(): Promise<ListeningSocket[]> }
/** Why Tailscale cannot publish (docs/research/v3-proxy.md); CLI output is classified, never forwarded. */
export type PublishBlock = 'tailscale_unavailable' | 'serve_disabled' | 'host_not_tagged' | 'service_undefined' | 'host_not_approved';
export type Publication = { state: 'published'; origin: string } | { state: 'blocked'; reason: PublishBlock };
/**
 * One Tailscale Service per app, HTTPS 443, towards that app's Puente listener and never the app's
 * port. Production publishes by hand and only verifies (tailscaleServices.ts); tests simulate it.
 */
export interface ServicePublisher {
  availability(): Promise<ToolAvailability>;
  /** Idempotent. */
  publish(service: string, listenerPort: number): Promise<Publication>;
  /** Idempotent; removes only that Service. */
  unpublish(service: string): Promise<void>;
}
/**
 * A browser of the Server, the same operations for both modes: CDP for the dedicated one (in the
 * supervisor, #92), the extension for the habitual one (habitualBrowser.ts, #93). Every operation names
 * the device that asks: a browser of another device is `not_found`. Actions arrive already validated;
 * the controller never takes a CDP method.
 */
export interface BrowserController {
  availability(): Promise<ToolAvailability>;
  tabs(target: TerminalTarget): Promise<BrowserTab[]>;
  openTab(target: TerminalTarget, url: string | null): Promise<BrowserTab>;
  closeTab(target: TerminalTarget, tab: string): Promise<void>;
  act(target: TerminalTarget, tab: string, action: BrowserAction): Promise<BrowserActionResult>;
  /** Opens the browser's stream on `channel`, replacing its previous one. */
  attach(target: TerminalTarget, channel: string, after: number): Promise<void>;
  view(target: TerminalTarget, channel: string, view: BrowserView): Promise<void>;
  ack(target: TerminalTarget, channel: string, seq: number): Promise<void>;
  detach(target: TerminalTarget, channel: string): Promise<void>;
  onChannel(listener: (event: ChannelEvent) => void): void;
  onDisconnected(listener: () => void): void;
}
/**
 * The Relay extension in the habitual browser (habitualBrowser.ts): the tabs the person shared at the
 * computer and those Relay opened, never another, and it never closes one.
 */
export interface HabitualBrowser {
  availability(): Promise<ToolAvailability>;
  tabs(): Promise<BrowserTab[]>;
  /** A new background tab, shared and createdByRelay. */
  open(url: string): Promise<BrowserTab>;
  act(tab: string, action: BrowserAction): Promise<BrowserActionResult>;
  /** One JPEG of the tab's visible area, at most `maxWidth` pixels wide; `viewport` in CSS pixels. */
  frame(tab: string, maxWidth: number, quality: number): Promise<{ data: string; viewport: { width: number; height: number } }>;
  /** The shared tabs' finished downloads since the last call, each where the browser saved it: handed over once. */
  downloads(): Promise<{ name: string; path: string }[]>;
  /** Detaches every debugger the extension holds; every tab stays open. */
  release(): Promise<void>;
}
/** The `browser` tool: the dedicated browser in the supervisor and, when its extension is wired, the habitual one. */
export interface BrowserTool { dedicated: BrowserController; habitual: HabitualBrowser | null }

/** A tool this build implements: the contract version it serves and its boundary. */
export interface WiredTool<Port> { capability: CapabilityAdvertisement; port: Port }

/** Only implemented tools are wired; the advertisement is exactly what is wired here. */
export interface RemoteTools {
  environments?: WiredTool<Supervisor>;
  terminal?: WiredTool<PtyHost>;
  files?: WiredTool<RemoteFileSystem>;
  web?: WiredTool<{ apps: AppRegistry; publisher: ServicePublisher }>;
  browser?: WiredTool<BrowserTool>;
}
