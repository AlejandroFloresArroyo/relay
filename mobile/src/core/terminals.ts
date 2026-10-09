// The device's terminals on one Servidor: the environments of kind 'terminal' (#81, #83). What the
// Puente answers is checked here before any of it reaches a screen or a request path.
import type { EnvironmentState, RemoteEnvironment } from '../../../protocol/protocol.ts';
import type { TerminalShells } from '../../../protocol/remoteTerminal.ts';
import { TERMINAL_PATH_BYTES } from '../../../protocol/remoteTerminal.ts';
import { RemoteFailure, type RemoteClient } from './remoteClient.ts';

export interface Terminal {
  id: string;
  state: EnvironmentState;
  ownership: RemoteEnvironment['ownership'];
  shell: string;
  cwd: string;
  createdAt: number;
  exitCode: number | null;
  terminationError: RemoteEnvironment['terminationError'] | null;
}

const ID = /^env_[A-Za-z0-9_-]{22,64}$/;
const STATES: Record<EnvironmentState, true> = { starting: true, running: true, terminating: true, exited: true, lost: true };
const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const path = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/') && !value.includes('\0') && value.length <= TERMINAL_PATH_BYTES;

/** A terminal environment from the Puente, or null if it is anything else or malformed. */
export function readTerminal(value: unknown): Terminal | null {
  if (!plain(value) || value.kind !== 'terminal' || typeof value.id !== 'string' || !ID.test(value.id)) return null;
  if (typeof value.state !== 'string' || !Object.hasOwn(STATES, value.state) || (value.ownership !== 'own' && value.ownership !== 'shared')) return null;
  if (!plain(value.terminal) || !path(value.terminal.shell) || !path(value.terminal.cwd) || !Number.isSafeInteger(value.createdAt)) return null;
  return {
    id: value.id, state: value.state as EnvironmentState, ownership: value.ownership, shell: value.terminal.shell, cwd: value.terminal.cwd,
    createdAt: value.createdAt as number, exitCode: Number.isSafeInteger(value.exitCode) ? value.exitCode as number : null,
    terminationError: value.terminationError === 'supervisor_unreachable' || value.terminationError === 'processes_remaining' ? value.terminationError : null,
  };
}

function required(value: unknown): Terminal {
  const terminal = readTerminal(value);
  if (!terminal) throw new RemoteFailure('unexpected', { status: 200 });
  return terminal;
}

/** «zsh» for /usr/bin/zsh. */
export const shellName = (shell: string) => shell.slice(shell.lastIndexOf('/') + 1) || shell;

/** The folder as the person reads it: their home folder as «~». */
export function folderLabel(cwd: string, home: string | null): string {
  if (!home || home === '/') return cwd;
  return cwd === home ? '~' : cwd.startsWith(home + '/') ? '~' + cwd.slice(home.length) : cwd;
}

export interface TerminalsApi {
  list(): Promise<Terminal[]>;
  shells(): Promise<TerminalShells>;
  /** The same requestId answers the same terminal: retry a lost answer with it. */
  create(requestId: string, shell: string, cwd: string): Promise<Terminal>;
  /** Idempotent; answers the real final state. */
  terminate(id: string): Promise<Terminal>;
  /** Removes an ended terminal from the list. */
  discard(id: string): Promise<void>;
}

/** `environments` and `terminal` give a client of each capability, built right before each call. */
export function terminalsApi(environments: () => RemoteClient, terminal: () => RemoteClient): TerminalsApi {
  const at = (id: string) => {
    if (!ID.test(id)) throw new Error('Not a terminal ID.');
    return `/v1/remote/environments/${id}`;
  };
  return {
    async list() {
      const body = await environments().request('GET', '/v1/remote/environments');
      if (!plain(body) || !Array.isArray(body.environments)) throw new RemoteFailure('unexpected', { status: 200 });
      return body.environments.flatMap((each) => readTerminal(each) ?? []);
    },
    async shells() {
      const body = await terminal().request('GET', '/v1/remote/shells');
      if (!plain(body) || !Array.isArray(body.shells) || !body.shells.every(path) || !(body.defaultShell === null || path(body.defaultShell)) || !path(body.home)) {
        throw new RemoteFailure('unexpected', { status: 200 });
      }
      return { shells: body.shells, defaultShell: body.defaultShell, home: body.home };
    },
    create: async (requestId, shell, cwd) => required(await environments().request('POST', '/v1/remote/environments', { requestId, kind: 'terminal', shell, cwd })),
    terminate: async (id) => required(await environments().request('POST', `${at(id)}/terminate`, { confirm: true })),
    async discard(id) { await environments().request('DELETE', at(id)); },
  };
}
