// Which remote tools of one Servidor can be used, in the fixed order of ADR 0006 «Estado de cada
// herramienta en la app»: no response, protocol, advertisement, authenticated status, available.
import { REMOTE_CAPABILITY_NAMES } from '../../../protocol/protocol.ts';
import type { CapabilityAdvertisement, RemoteCapabilityName, RemoteStatus, RemoteUnavailableReason, ToolAvailability } from '../../../protocol/protocol.ts';
import { checkProtocolVersion } from './protocolVersion.ts';

export interface AppCapability { version: number; minBridgeVersion: number }
export type AppRemoteCapabilities = Partial<Record<RemoteCapabilityName, AppCapability>>;
/**
 * The contract version of each capability this app implements: a code constant, never the APK
 * version. Each tool's task adds its entry together with its screens.
 */
export const APP_REMOTE_CAPABILITIES: AppRemoteCapabilities = {
  // #84: list, create and terminate the device's terminals, and the terminal channel itself.
  environments: { version: 1, minBridgeVersion: 1 },
  terminal: { version: 1, minBridgeVersion: 1 },
  // #88: the explorer, the editor, transfers and search.
  files: { version: 1, minBridgeVersion: 1 },
  // #91: local web apps in Relay's viewer and in the phone's browser, with the one-hour authorization.
  web: { version: 1, minBridgeVersion: 1 },
  // #94: the Navegador tool, dedicated and habitual. Its phone files go through the `files` transfer (#87, #88).
  browser: { version: 1, minBridgeVersion: 1 },
};

export type RemoteTool = 'terminal' | 'files' | 'webInRelay' | 'webExternal' | 'browserDedicated' | 'browserHabitual';
const TOOLS: Record<RemoteTool, [RemoteCapabilityName, (status: RemoteStatus) => unknown]> = {
  terminal: ['terminal', (s) => s.terminal],
  files: ['files', (s) => s.files],
  webInRelay: ['web', (s) => s.web?.inRelay],
  webExternal: ['web', (s) => s.web?.external],
  browserDedicated: ['browser', (s) => s.browser?.dedicated],
  browserHabitual: ['browser', (s) => s.browser?.habitual],
};

export interface NegotiatedCapability { name: RemoteCapabilityName; version: number }
export type RemoteToolState =
  | { state: 'no_response' }
  | { state: 'protocol'; message: string }
  | { state: 'update_bridge' }
  | { state: 'update_app' }
  /** Advertised, but the authenticated status is not known yet, or the advertisement is being re-read. */
  | { state: 'checking' }
  | { state: 'unavailable'; reason: RemoteUnavailableReason }
  | { state: 'available'; capability: NegotiatedCapability };

export interface RemoteInputs {
  /** The last /health body received from this Servidor and when; null if it never answered. */
  health: { body: unknown; at: number } | null;
  lastConnectionFailureAt: number | null;
  /** Last remote response that means "the Puente changed": 426 or a 404 other than remote_not_found. */
  bridgeChangedAt: number | null;
  status: { body: RemoteStatus; at: number } | null;
  app?: AppRemoteCapabilities;
}

export interface RemoteToolStates {
  tools: Partial<Record<RemoteTool, RemoteToolState>>;
  /** The capability to send GET /v1/remote/status with; null means the status must not be asked for. */
  status: NegotiatedCapability | null;
}

const REASONS: readonly RemoteUnavailableReason[] = ['helper_missing', 'helper_stopped', 'helper_incompatible', 'dependency_missing', 'not_configured', 'unsupported_platform', 'not_reported'];
const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** One capability of a /health body, by ADR 0006 «Anuncio»; a malformed entry counts as absent. */
function advertised(health: unknown, name: string): CapabilityAdvertisement | null {
  const capabilities = plain(health) ? health.capabilities : undefined;
  const entry = plain(capabilities) && Object.hasOwn(capabilities, name) ? capabilities[name] : undefined;
  return plain(entry) && count(entry.version) && count(entry.minAppVersion) && entry.minAppVersion <= entry.version
    ? { version: entry.version, minAppVersion: entry.minAppVersion } : null;
}

export type Negotiation = { state: 'update_bridge' } | { state: 'update_app' } | { state: 'available'; version: number };
/** This app's version of one capability against what a /health body advertises. Also used for `metrics`. */
export function negotiate(health: unknown, name: string, mine: AppCapability): Negotiation {
  const offer = advertised(health, name);
  return !offer || offer.version < mine.minBridgeVersion ? { state: 'update_bridge' }
    : offer.minAppVersion > mine.version ? { state: 'update_app' }
      : { state: 'available', version: Math.min(mine.version, offer.version) };
}

/** A leaf the app cannot read is never available. */
function availability(value: unknown): ToolAvailability {
  if (plain(value) && value.state === 'available') return { state: 'available' };
  if (plain(value) && value.state === 'unavailable' && REASONS.includes(value.reason as RemoteUnavailableReason)) {
    return { state: 'unavailable', reason: value.reason as RemoteUnavailableReason };
  }
  return { state: 'unavailable', reason: 'not_reported' };
}

export function remoteToolStates(inputs: RemoteInputs): RemoteToolStates {
  const app = inputs.app ?? APP_REMOTE_CAPABILITIES;
  const offered = (Object.keys(TOOLS) as RemoteTool[]).filter((tool) => {
    const name = TOOLS[tool][0];
    return app[name] && (name === 'terminal' || name === 'browser' ? app.environments : true);
  });
  const all = (state: RemoteToolState): RemoteToolStates => ({ tools: Object.fromEntries(offered.map((tool) => [tool, state])), status: null });
  const { health, lastConnectionFailureAt: failedAt, bridgeChangedAt: changedAt } = inputs;

  // 1. A network failure is never shown as a missing capability nor as an old version.
  if (!health || (failedAt !== null && health.at <= failedAt)) return all({ state: 'no_response' });
  // 2. ADR 0002 decides first; the advertisement cannot change its verdict.
  const protocol = checkProtocolVersion(health.body);
  if (protocol.kind !== 'compatible') return all({ state: 'protocol', message: protocol.message });
  if (changedAt !== null && health.at <= changedAt) return all({ state: 'checking' });

  // 3. Advertisement, per capability.
  const negotiated: Partial<Record<RemoteCapabilityName, RemoteToolState>> = {};
  for (const name of REMOTE_CAPABILITY_NAMES) {
    const mine = app[name];
    if (!mine) continue;
    const result = negotiate(health.body, name, mine);
    negotiated[name] = result.state === 'available' ? { state: 'available', capability: { name, version: result.version } } : result;
  }
  const environments = negotiated.environments;
  for (const name of ['terminal', 'browser'] as const) {
    if (negotiated[name] && environments?.state !== 'available') negotiated[name] = environments ?? { state: 'update_bridge' };
  }
  const passed = REMOTE_CAPABILITY_NAMES.map((name) => negotiated[name]).find((state) => state?.state === 'available');
  const status = passed?.state === 'available' ? passed.capability : null;

  // 4. Authenticated status, asked for only when something passed 3, and only if still current: read
  // after the last connection failure and after the last "the Puente changed".
  const current = inputs.status && inputs.status.at > Math.max(failedAt ?? -Infinity, changedAt ?? -Infinity) ? inputs.status.body : null;
  const tools: Partial<Record<RemoteTool, RemoteToolState>> = {};
  for (const tool of offered) {
    const [name, read] = TOOLS[tool];
    const state = negotiated[name]!;
    if (state.state !== 'available') tools[tool] = state;
    else if (!current) tools[tool] = { state: 'checking' };
    else {
      const leaf = availability(read(current));
      // 5. Only this opens the tool.
      tools[tool] = leaf.state === 'available' ? state : leaf;
    }
  }
  return { tools, status };
}

const HINTS: Record<RemoteUnavailableReason, string> = {
  helper_missing: 'Falta el supervisor de Relay en el Servidor. Instálalo con el instalador del Puente en esa computadora.',
  helper_stopped: 'El supervisor de Relay está detenido en el Servidor. Inícialo en esa computadora.',
  helper_incompatible: 'El supervisor de Relay no es compatible con este Puente. Actualízalo con el instalador del Puente.',
  dependency_missing: 'Falta un requisito en el Servidor. El instalador del Puente indica cuál y cómo instalarlo.',
  not_configured: 'Esta función no está configurada en el Servidor. Configúrala con el instalador del Puente.',
  unsupported_platform: 'Este Servidor no admite esta herramienta.',
  not_reported: 'El Puente anuncia la herramienta pero no informa su estado. Actualiza el Puente.',
};

export function describeRemoteToolState(state: RemoteToolState): { label: string; hint: string | null } {
  switch (state.state) {
    case 'no_response': return { label: 'Sin respuesta', hint: null };
    case 'protocol': return { label: state.message, hint: null };
    case 'update_bridge': return { label: 'Actualiza el Puente', hint: 'Este Puente no tiene esta herramienta o tiene una versión anterior.' };
    case 'update_app': return { label: 'Actualiza Relay', hint: 'Este Puente necesita una versión más reciente de Relay para esta herramienta.' };
    case 'checking': return { label: 'Comprobando…', hint: null };
    case 'unavailable': return { label: 'No disponible en este Servidor', hint: HINTS[state.reason] };
    case 'available': return { label: 'Disponible', hint: null };
  }
}
