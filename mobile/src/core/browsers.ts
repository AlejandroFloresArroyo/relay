// The device's browsers on one Servidor (protocol/remoteBrowser.ts, ADR 0006 «Lo que fijó la
// integración de #92 y #93»): environments of kind 'browser_dedicated', always the device's own, and
// 'browser_habitual', always shared with whoever is at the computer. What the Puente answers is checked
// here before it reaches a screen or a request path.
import type { EnvironmentState, RemoteEnvironment } from '../../../protocol/protocol.ts';
import type { BrowserAction, BrowserView } from '../../../protocol/remoteBrowser.ts';
import { BROWSER_TAB_PATTERN } from '../../../protocol/remoteBrowser.ts';
import { RemoteFailure, type RemoteClient } from './remoteClient.ts';

export type BrowserKind = 'browser_dedicated' | 'browser_habitual';
export interface BrowserEnvironment {
  id: string;
  kind: BrowserKind;
  /** Follows the kind: what «Terminar» ends and what a revocation keeps depend on it. */
  ownership: RemoteEnvironment['ownership'];
  state: EnvironmentState;
  createdAt: number;
  terminationError: RemoteEnvironment['terminationError'] | null;
}

const ID = /^env_[A-Za-z0-9_-]{22,64}$/;
const TAB = new RegExp(BROWSER_TAB_PATTERN);
const STATES: Record<EnvironmentState, true> = { starting: true, running: true, terminating: true, exited: true, lost: true };
/** The only pairs: a dedicated browser is the device's own, the habitual one is shared work. */
const OWNERSHIP: Record<BrowserKind, RemoteEnvironment['ownership']> = { browser_dedicated: 'own', browser_habitual: 'shared' };
const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A browser environment from the Puente, or null if it is anything else, malformed, or owned against its kind. */
export function readBrowser(value: unknown): BrowserEnvironment | null {
  if (!plain(value) || typeof value.id !== 'string' || !ID.test(value.id) || !Object.hasOwn(OWNERSHIP, value.kind as string)) return null;
  const kind = value.kind as BrowserKind;
  if (value.ownership !== OWNERSHIP[kind] || typeof value.state !== 'string' || !Object.hasOwn(STATES, value.state) || !Number.isSafeInteger(value.createdAt)) return null;
  return {
    id: value.id, kind, ownership: OWNERSHIP[kind], state: value.state as EnvironmentState, createdAt: value.createdAt as number,
    terminationError: value.terminationError === 'supervisor_unreachable' || value.terminationError === 'processes_remaining' ? value.terminationError : null,
  };
}

function required(value: unknown, kind?: BrowserKind): BrowserEnvironment {
  const browser = readBrowser(value);
  if (!browser || (kind && browser.kind !== kind)) throw new RemoteFailure('unexpected', { status: 200 });
  return browser;
}

const environmentPath = (id: string) => {
  if (!ID.test(id)) throw new Error('Not a browser ID.');
  return `/v1/remote/environments/${id}`;
};

export interface BrowsersApi {
  list(): Promise<BrowserEnvironment[]>;
  /** The same requestId answers the same browser: retry a lost answer with it. */
  create(requestId: string, kind: BrowserKind): Promise<BrowserEnvironment>;
  /** Ends a dedicated browser, or disconnects from the habitual one and keeps it. Idempotent. */
  terminate(id: string): Promise<BrowserEnvironment>;
  discard(id: string): Promise<void>;
}

export function browsersApi(environments: () => RemoteClient): BrowsersApi {
  return {
    async list() {
      const body = await environments().request('GET', '/v1/remote/environments');
      if (!plain(body) || !Array.isArray(body.environments)) throw new RemoteFailure('unexpected', { status: 200 });
      return body.environments.flatMap((each) => readBrowser(each) ?? []);
    },
    create: async (requestId, kind) => required(await environments().request('POST', '/v1/remote/environments', { requestId, kind }), kind),
    terminate: async (id) => required(await environments().request('POST', `${environmentPath(id)}/terminate`, { confirm: true })),
    async discard(id) { await environments().request('DELETE', environmentPath(id)); },
  };
}

/** The page requests of one browser. Answers are raw: the session checks them. */
export interface BrowserPort {
  frames(onData: (data: string) => void, signal: AbortSignal): Promise<void>;
  view(channel: string, view: BrowserView): Promise<unknown>;
  ack(channel: string, seq: number): Promise<unknown>;
  tabs(): Promise<unknown>;
  /** A new tab, blank or at `url`; the habitual browser needs a `url`. */
  open(url: string | null): Promise<unknown>;
  close(tab: string): Promise<unknown>;
  act(tab: string, action: BrowserAction): Promise<unknown>;
}

export function browserPort(client: () => RemoteClient, environmentId: string): BrowserPort {
  if (!ID.test(environmentId)) throw new Error('Not a browser ID.');
  const base = `/v1/remote/browsers/${environmentId}`;
  const tab = (id: string) => {
    if (!TAB.test(id)) throw new Error('Not a tab ID.');
    return `${base}/tabs/${id}`;
  };
  return {
    // Frames replace each other: there is nothing to resume, so every stream starts from 0.
    frames: (onData, signal) => client().stream(`${base}/frames`, 0, onData, signal),
    view: (channel, view) => client().request('POST', `${base}/view`, { channel, ...view }),
    ack: (channel, seq) => client().request('POST', `${base}/ack`, { channel, seq }),
    tabs: () => client().request('GET', `${base}/tabs`),
    open: (url) => client().request('POST', `${base}/tabs`, url === null ? {} : { url }),
    close: async (id) => client().request('DELETE', tab(id)),
    act: async (id, action) => client().request('POST', `${tab(id)}/action`, action),
  };
}
