import { fetch as expoFetch } from 'expo/fetch';
import { useEffect, useLayoutEffect, useState } from 'react';

import type { RemoteStatus } from '../../../protocol/protocol';
import { browserPort, browsersApi, type BrowserPort, type BrowsersApi } from '@/core/browsers';
import { createDemoBrowsers } from '@/core/demoBrowser';
import { createDemoTerminals } from '@/core/demoTerminal';
import { createDemoServerFiles } from '@/core/demoServerFiles';
import { createDemoWeb } from '@/core/demoWeb';
import { DEMO_REMOTE_TOOLS } from '@/core/demoRemote';
import { remoteToolStates, type RemoteToolState, type RemoteToolStates } from '@/core/remoteCapabilities';
import { createRemoteClient, fetchRemoteStatus, RemoteFailure, type RemoteClient, type RemoteTransport } from '@/core/remoteClient';
import { terminalPort, type TerminalPort } from '@/core/terminalSession';
import { terminalsApi, type TerminalsApi } from '@/core/terminals';
import { webApi, type WebApi } from '@/core/remoteWeb';
import { DEMO, useApp } from './app';

export interface RemoteTerminals { api: TerminalsApi; port: (environmentId: string) => TerminalPort }
export interface RemoteBrowsers { api: BrowsersApi; port: (environmentId: string) => BrowserPort }
export interface RemoteTools {
  tools: RemoteToolStates['tools'];
  /** Present while the terminal is available. */
  terminals: RemoteTerminals | null;
  /** The same function for the life of the screen: each call gives a client while `files` is available, and throws `not_offered` otherwise. */
  files: () => RemoteClient;
  /** Present while the web tool is available in Relay or in the phone's browser. */
  web: WebApi | null;
  /** Present while either browser mode is available: both share the `browser` capability. */
  browsers: RemoteBrowsers | null;
}

const demoTerminals = DEMO ? createDemoTerminals() : null;
const demoFiles = DEMO ? createDemoServerFiles() : null;
const demoWeb = DEMO ? createDemoWeb() : null;
const demoBrowsers = DEMO ? createDemoBrowsers() : null;
const browserAvailable = (tools: RemoteToolStates['tools']) => tools.browserDedicated?.state === 'available' || tools.browserHabitual?.state === 'available';

/** What each request reads at the moment it leaves: the latest tool states and transport. */
class LiveTools {
  states: RemoteToolStates;
  transport: RemoteTransport | null;
  readonly terminals: RemoteTerminals;
  readonly files: () => RemoteClient;
  readonly web: WebApi;
  readonly browsers: RemoteBrowsers;
  constructor(states: RemoteToolStates, transport: RemoteTransport | null, changed: () => void) {
    this.states = states;
    this.transport = transport;
    // A client per call, from the state of that moment: one that stopped answering is never reused.
    const client = (pick: (s: RemoteToolStates) => RemoteToolState): RemoteClient => {
      const built = pick(this.states);
      if (built.state !== 'available' || !this.transport) throw new RemoteFailure('not_offered');
      const inner = createRemoteClient(this.transport, built, () => pick(this.states));
      const noticed = (error: unknown) => {
        if (error instanceof RemoteFailure && error.kind === 'bridge_changed') changed();
        return error;
      };
      return {
        request: (method, path, body) => inner.request(method, path, body).catch((error: unknown) => { throw noticed(error); }),
        chunk: (method, path, body, signal) => inner.chunk(method, path, body, signal).catch((error: unknown) => { throw noticed(error); }),
        stream: (path, lastEventId, onData, signal, idleMs) => inner.stream(path, lastEventId, onData, signal, idleMs).catch((error: unknown) => { throw noticed(error); }),
      };
    };
    const terminal = () => client((s) => s.tools.terminal ?? { state: 'checking' });
    // While a tool of environments is available, `status` is the negotiated environments capability.
    const environments = (open: (s: RemoteToolStates) => boolean) => () => client((s) => open(s) && s.status?.name === 'environments'
      ? { state: 'available', capability: s.status } : { state: 'checking' });
    this.terminals = { api: terminalsApi(environments((s) => s.tools.terminal?.state === 'available'), terminal), port: (id) => terminalPort(terminal, id) };
    // Both modes are the one `web` capability; each screen still checks the mode it uses.
    this.web = webApi(() => client((s) => s.tools.webInRelay?.state === 'available' ? s.tools.webInRelay : s.tools.webExternal ?? { state: 'checking' }));
    // Either mode negotiates the same `browser` capability.
    const browser = () => client((s) => [s.tools.browserDedicated, s.tools.browserHabitual].find((tool) => tool?.state === 'available') ?? { state: 'checking' });
    this.browsers = { api: browsersApi(environments((s) => browserAvailable(s.tools))), port: (id) => browserPort(browser, id) };
    this.files = () => client((s) => s.tools.files ?? { state: 'checking' });
  }

  update(states: RemoteToolStates, transport: RemoteTransport | null) {
    this.states = states;
    this.transport = transport;
  }
}

/**
 * The remote tools of one Servidor (ADR 0006 «Estado de cada herramienta en la app»): the last /health
 * of the shared poll, plus GET /v1/remote/status asked again after each /health that arrives. The key
 * stays in native code.
 */
export function useRemoteTools(serverId: string): RemoteTools {
  const { servers, snapshot } = useApp();
  const server = servers.find((s) => s.id === serverId);
  const snap = snapshot(serverId);
  const [status, setStatus] = useState<{ body: RemoteStatus; at: number } | null>(null);
  const [changedAt, setChangedAt] = useState<number | null>(null);
  const states = remoteToolStates({ health: snap.health, lastConnectionFailureAt: snap.healthFailedAt, bridgeChangedAt: changedAt, status });
  const transport: RemoteTransport | null = server ? { baseUrl: server.url, key: server.key, fetch: expoFetch as unknown as typeof fetch } : null;
  // Built once, so the terminals keep their identity while the Servidor's answers change.
  const [live] = useState(() => new LiveTools(states, transport, () => setChangedAt(Date.now())));
  useLayoutEffect(() => { live.update(states, transport); });
  const terminals = live.terminals;

  const asks = states.status ? `${states.status.name}/${states.status.version}` : null;
  const healthAt = snap.health?.at ?? null;
  useEffect(() => {
    if (DEMO || !asks || !live.transport) return;
    let current = true;
    fetchRemoteStatus(live.transport, () => live.states.status).then((body) => {
      if (current) setStatus({ body, at: Date.now() });
    }, (error: unknown) => {
      if (current && error instanceof RemoteFailure && error.kind === 'bridge_changed') setChangedAt(Date.now());
    });
    return () => { current = false; };
  }, [asks, healthAt, live]);

  if (DEMO) return { tools: DEMO_REMOTE_TOOLS, terminals: demoTerminals, files: demoFiles!, web: demoWeb, browsers: demoBrowsers };
  const webOffered = states.tools.webInRelay?.state === 'available' || states.tools.webExternal?.state === 'available';
  return {
    tools: states.tools,
    terminals: states.tools.terminal?.state === 'available' && transport ? terminals : null,
    files: live.files,
    web: webOffered && transport ? live.web : null,
    browsers: browserAvailable(states.tools) && transport ? live.browsers : null,
  };
}
