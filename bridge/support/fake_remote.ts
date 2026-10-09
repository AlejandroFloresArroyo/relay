// Doubles for the remote tool boundaries (bridge/src/remote/ports.ts). Each answers a fixed
// availability so tests choose what the machine has without a supervisor, PTY, fs or browser.
import type { CapabilityAdvertisement, ToolAvailability } from '../../protocol/protocol.ts';
import type { BrowserTool, PtyHost, RemoteFileSystem, RemoteTools, Supervisor } from '../src/remote/ports.ts';
import { RemoteError } from '../src/remote/routes.ts';
import { SupervisorUnreachable } from '../src/remote/supervisorClient.ts';
import { fakeSockets, simulatedPublisher } from './fake_web.ts';

export const AVAILABLE: ToolAvailability = { state: 'available' };

export function fixedPort(availability: ToolAvailability = AVAILABLE) {
  return { availability: async () => availability };
}


const unreachable = async (): Promise<never> => { throw new SupervisorUnreachable(); };

type Availability = () => Promise<ToolAvailability>;

/** Both browser modes answering only their availability. Browser tests use the real supervisor and extension link. */
export function fixedBrowser(dedicated: Availability = async () => AVAILABLE, habitual: Availability = async () => AVAILABLE): BrowserTool {
  return {
    dedicated: {
      availability: dedicated,
      tabs: unreachable, openTab: unreachable, closeTab: unreachable, act: unreachable, attach: unreachable, view: unreachable, ack: unreachable, detach: unreachable,
      onChannel() {}, onDisconnected() {},
    },
    habitual: { availability: habitual, tabs: unreachable, open: unreachable, act: unreachable, frame: unreachable, downloads: unreachable, release: unreachable },
  };
}

/** A supervisor with no environment that answers only its availability. Environment tests use the real one. */
export function fixedSupervisor(availability: () => Promise<ToolAvailability> = async () => AVAILABLE): Supervisor {
  return { availability, list: async () => [], register: unreachable, launch: unreachable, terminate: unreachable, discard: unreachable, onConnected() {}, onEvent() {} };
}

/** Terminals that answer only their availability. Terminal tests use the real supervisor. */
export function fixedPty(availability: () => Promise<ToolAvailability> = async () => AVAILABLE): PtyHost {
  return {
    availability, shells: unreachable, attach: unreachable, ack: unreachable, detach: unreachable, input: unreachable, resize: unreachable,
    onChannel() {}, onDisconnected() {},
  };
}

/** A file explorer that answers only its availability. File tests use the real one on a temporary disk. */
export function fixedFiles(availability: () => Promise<ToolAvailability> = async () => AVAILABLE): RemoteFileSystem {
  const unavailable = (): never => { throw new RemoteError('remote_unavailable'); };
  return {
    availability, list: unavailable, read: unavailable, reference: unavailable, create: unavailable, move: unavailable, delete: unavailable,
    startSave: unavailable, saveChunk: unavailable, commitSave: unavailable, startUpload: unavailable, uploadChunk: unavailable,
    commitUpload: unavailable, startDownload: unavailable, downloadChunk: unavailable, startSearch: unavailable, events: unavailable,
    ack: unavailable, cancel: unavailable, retain() {},
  };
}

const V1: CapabilityAdvertisement = { version: 1, minAppVersion: 1 };

/** Every tool wired at version 1 and available, unless overridden. */
export function fakeRemoteTools(overrides: Partial<RemoteTools> = {}): RemoteTools {
  return {
    environments: { capability: V1, port: fixedSupervisor() },
    terminal: { capability: V1, port: fixedPty() },
    files: { capability: V1, port: fixedFiles() },
    web: { capability: V1, port: { apps: fakeSockets(), publisher: simulatedPublisher() } },
    browser: { capability: V1, port: fixedBrowser() },
    ...overrides,
  };
}
