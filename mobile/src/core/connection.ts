import { normalizeBaseUrl } from './bridgeClient.ts';
import { RelayError, type RelayClient } from './client.ts';
import { ms } from './format.ts';
import type { Agent, Approval } from '../../../protocol/protocol.ts';
import type { ServerControlStatus } from '../../../protocol/serverControl.ts';
import { classifyConnectionError, type ConnectionDiagnosis } from './connectionStatus.ts';
import { checkProtocolVersion, type ProtocolCompatibility } from './protocolVersion.ts';

export interface ConnectionSnapshot {
  connectionUrl: string;
  reachable: boolean | null;
  latencyMs: number | null;
  agents: Agent[];
  approvals: Approval[];
  lastContactAt: number | null;
  down: ConnectionDiagnosis | null;
  protocol: ProtocolCompatibility | null;
  protocolStale: boolean;
  approvalClockOffsetMs?: number;
  /** Pausa general as last read; null when this Puente has no control or it was never read. */
  serverControl: ServerControlStatus | null;
  /** The last /health body that arrived, and when; the remote tools read their advertisement here. */
  health: { body: unknown; at: number } | null;
  /** When /health last failed, for ADR 0006 «Sin respuesta». */
  healthFailedAt: number | null;
}

/** Public health is independent of private authorization, including on legacy bridges. */
export async function pollConnection(
  client: RelayClient,
  url: string,
  previous?: ConnectionSnapshot,
  now: () => number = Date.now,
): Promise<ConnectionSnapshot> {
  const old = previous?.connectionUrl === url ? previous : undefined;
  const started = now();
  const [health, data] = await Promise.allSettled([
    client.health(),
    (async () => {
      const agents = await client.agents();
      // Asked only of a Puente that answered. Only a missing route (404) means "no pause control";
      // any other failure keeps the last known pause rather than claiming the Servidor resumed.
      const [approvals, serverControl] = await Promise.all([
        client.approvals(),
        (async () => client.serverControl())().catch((e: unknown) =>
          e instanceof RelayError && e.status === 404 ? null : old?.serverControl ?? null),
      ]);
      return { agents, approvals, serverControl };
    })(),
  ]);
  const protocol = health.status === 'fulfilled' ? checkProtocolVersion(health.value) : old?.protocol ?? null;
  const protocolStale = health.status === 'rejected';
  const failure = data.status === 'rejected' ? data.reason : health.status === 'rejected' ? health.reason : null;
  const down = failure === null ? null : classifyConnectionError(failure);
  return {
    connectionUrl: url, reachable: down === null, latencyMs: down ? null : now() - started,
    agents: data.status === 'fulfilled' ? data.value.agents : old?.agents ?? [],
    approvals: down || data.status === 'rejected' ? [] : data.value.approvals,
    lastContactAt: down ? old?.lastContactAt ?? null : now(),
    down, protocol, protocolStale, approvalClockOffsetMs: client.serverClockOffsetMs?.() ?? 0,
    // An unreachable Servidor keeps its last known pause instead of claiming it resumed.
    serverControl: down ? old?.serverControl ?? null : data.status === 'fulfilled' ? data.value.serverControl : null,
    health: health.status === 'fulfilled' ? { body: health.value, at: now() } : old?.health ?? null,
    healthFailedAt: health.status === 'rejected' ? now() : old?.healthFailedAt ?? null,
  };
}

/**
 * The installed Android app only allows http:// to this domain and its subdomains. The rule itself is
 * the network security config written by `plugins/withTailnetCleartext.js`; keep the two in step.
 */
export const CLEARTEXT_DOMAIN = 'ts.net';

/**
 * True when the URL is http:// and its host is not under `ts.net`: the installed Android app will
 * refuse it before sending anything. Expo Go and the browser do not apply that rule.
 */
export function cleartextWillBeBlocked(url: string): boolean {
  const host = /^http:\/\/(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]*)/i.exec(normalizeBaseUrl(url))?.[1]?.toLowerCase();
  if (!host) return false;
  return host !== CLEARTEXT_DOMAIN && !host.endsWith(`.${CLEARTEXT_DOMAIN}`);
}

export type ConnectionResult =
  | { kind: 'ok'; latencyMs: number; hermesVersion: string; profiles: number }
  | { kind: 'bad_key'; status: number }
  | { kind: 'cleartext_blocked' }
  | { kind: 'unreachable'; timeoutSeconds: number };

/** "Probar conexión": one authenticated call, classified into the outcomes the result panel shows. */
export async function testConnection(
  client: RelayClient,
  now: () => number = Date.now,
  timeoutSeconds = 5,
): Promise<ConnectionResult> {
  const started = now();
  try {
    const info = await client.server();
    return { kind: 'ok', latencyMs: now() - started, hermesVersion: info.hermesVersion, profiles: info.profiles };
  } catch (e) {
    if (e instanceof RelayError && e.code === 'unauthorized') return { kind: 'bad_key', status: e.status ?? 401 };
    if (e instanceof RelayError && e.code === 'cleartext_blocked') return { kind: 'cleartext_blocked' };
    return { kind: 'unreachable', timeoutSeconds };
  }
}

export type Tone = 'green' | 'red' | 'off';

export function describeConnection(r: ConnectionResult): { title: string; sub: string; tone: Tone } {
  switch (r.kind) {
    case 'ok':
      return {
        title: 'CONEXIÓN OK',
        sub: `${ms(r.latencyMs)} · HERMES ${r.hermesVersion} · ${r.profiles} ${r.profiles === 1 ? 'PERFIL' : 'PERFILES'}`,
        tone: 'green',
      };
    case 'bad_key':
      return { title: 'API KEY INVÁLIDA', sub: `${r.status} · REVISA RELAY_KEY EN EL SERVIDOR`, tone: 'red' };
    case 'cleartext_blocked':
      return {
        title: 'HTTP BLOQUEADO POR ANDROID',
        sub: 'LA APP SOLO ADMITE HTTP:// PARA NOMBRES *.TS.NET · USA EL NOMBRE DE TAILNET O HTTPS://',
        tone: 'red',
      };
    case 'unreachable':
      return {
        title: 'SERVIDOR INALCANZABLE',
        sub: `TIMEOUT ${r.timeoutSeconds} S · ¿RELAYD ACTIVO Y TAILSCALE ENCENDIDO?`,
        tone: 'off',
      };
  }
}

/**
 * Why a saved server is down, in the words the agents screen shows. Only the causes the app can
 * actually tell apart get a hint; everything else stays "SIN RESPUESTA". The hints state the cause
 * and stop there: the app cannot edit or remove a saved server yet, so they must not tell the
 * user to.
 */
export function describeDown(error: unknown): { label: string; hint: string | null } {
  if (error instanceof RelayError) {
    if (error.code === 'cleartext_blocked') {
      return {
        label: 'HTTP BLOQUEADO',
        hint: `Android solo admite http:// para nombres *.${CLEARTEXT_DOMAIN}.`,
      };
    }
    if (error.code === 'unauthorized') {
      return {
        label: 'LLAVE RECHAZADA',
        hint: 'El servidor ya no acepta la API key guardada.',
      };
    }
  }
  return { label: 'SIN RESPUESTA', hint: null };
}
