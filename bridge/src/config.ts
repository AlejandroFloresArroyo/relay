import os from 'node:os';
import path from 'node:path';

import { normalizePeerIp } from './auth.ts';
import type { Exec } from './exec.ts';
import { isTailscaleIp } from './tailnet.ts';
import { notificationOrigin } from './notifications.ts';

export interface Config {
  port: number;
  host: string;
  corsOrigins: string[];
  hermesHome: string;
  hermesBin: string;
  hermesMediaSource?: string;
  hermesMediaPython?: string;
  ntfyUrl: string | null;
  ntfyOrigin?: string | null;
  appUpdateRoot?: string;
  /** The supervisor's private runtime directory. Unset: environments are neither advertised nor served. */
  supervisorDirectory?: string;
  /** RELAY_REMOTE_FILES=1. Off: files are neither advertised nor served (#85). */
  remoteFiles?: boolean;
  /** RELAY_REMOTE_WEB=1. Off: web is neither advertised nor served (#96). */
  remoteWeb?: boolean;
  /** RELAY_BROWSER_HABITUAL=1, with the supervisor: the extension socket listens and `browser` is wired (#93). */
  browserHabitual?: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const host = normalizePeerIp(env.RELAY_HOST?.trim());
  if (!host || !isTailscaleIp(host)) throw new ConfigError('RELAY_HOST must be a local Tailscale IP; no fallback is allowed.');
  const rawPort = env.RELAY_PORT ?? '8650';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
    throw new ConfigError('RELAY_PORT must be a TCP port between 1 and 65535.');
  }

  const corsOrigins = (env.RELAY_CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (corsOrigins.includes('*')) {
    throw new ConfigError('RELAY_CORS_ORIGINS must list explicit origins; "*" is not allowed.');
  }

  const ntfyUrl = env.RELAY_NTFY_URL?.trim() || null;
  if (ntfyUrl && !/^https?:\/\//i.test(ntfyUrl)) {
    throw new ConfigError('RELAY_NTFY_URL must be an http(s) URL.');
  }

  let ntfyOrigin: string | null = null;
  if (env.RELAY_NTFY_ORIGIN) {
    try { ntfyOrigin = notificationOrigin(env.RELAY_NTFY_ORIGIN); }
    catch { throw new ConfigError('RELAY_NTFY_ORIGIN debe ser un origen privado Tailnet sin credenciales ni ruta.'); }
  }
  const canonical = (value: string) => path.isAbsolute(value) && value !== '/' && path.resolve(value) === value && value.length <= 4096
    && value.split('/').length <= 64 && !/[\x00-\x1f\x7f]/.test(value);
  const appUpdateRoot = env.RELAY_APP_UPDATE_ROOT;
  if (appUpdateRoot !== undefined && !canonical(appUpdateRoot)) {
    throw new ConfigError('RELAY_APP_UPDATE_ROOT must be a canonical private absolute directory.');
  }
  const supervisorDirectory = env.RELAY_SUPERVISOR_DIR || undefined;
  if (supervisorDirectory !== undefined && !canonical(supervisorDirectory)) {
    throw new ConfigError('RELAY_SUPERVISOR_DIR must be the canonical absolute runtime directory of the supervisor.');
  }
  const remoteFiles = env.RELAY_REMOTE_FILES ?? '';
  if (remoteFiles !== '' && remoteFiles !== '1') throw new ConfigError('RELAY_REMOTE_FILES must be 1 or unset.');
  const remoteWeb = env.RELAY_REMOTE_WEB ?? '';
  if (remoteWeb !== '' && remoteWeb !== '1') throw new ConfigError('RELAY_REMOTE_WEB must be 1 or unset.');
  const browserHabitual = env.RELAY_BROWSER_HABITUAL ?? '';
  if (browserHabitual !== '' && browserHabitual !== '1') throw new ConfigError('RELAY_BROWSER_HABITUAL must be 1 or unset.');

  return {
    appUpdateRoot,
    supervisorDirectory,
    remoteFiles: remoteFiles === '1',
    remoteWeb: remoteWeb === '1',
    browserHabitual: browserHabitual === '1',
    port,
    host,
    corsOrigins,
    hermesHome: env.HERMES_HOME?.trim() || path.join(os.homedir(), '.hermes'),
    hermesBin: env.HERMES_BIN?.trim() || 'hermes',
    hermesMediaSource: env.HERMES_MEDIA_SOURCE?.trim() || undefined,
    hermesMediaPython: env.HERMES_MEDIA_PYTHON?.trim() || undefined,
    ntfyUrl,
    ntfyOrigin,
  };
}

/** Read only local Tailscale metadata through fixed argument vectors. Never echo subprocess data. */
export async function readLocalTailscale(exec: Exec): Promise<{ ips: string[]; dnsName: string }> {
  try {
    const status = await exec('tailscale', ['status', '--json'], { timeoutMs: 3000 });
    const addresses = await exec('tailscale', ['ip'], { timeoutMs: 3000 });
    if (status.code !== 0 || addresses.code !== 0) throw new Error();
    const parsed = JSON.parse(status.stdout);
    if (parsed?.BackendState !== 'Running' || typeof parsed?.Self?.DNSName !== 'string') throw new Error();
    const ips = addresses.stdout.trim().split(/\s+/).map(normalizePeerIp);
    if (!ips.length || ips.some(ip => !ip || !isTailscaleIp(ip))) throw new Error();
    return { ips: ips as string[], dnsName: parsed.Self.DNSName };
  } catch { throw new ConfigError('Tailscale must be running with a local tailnet address.'); }
}

export async function loadServeConfig(env: Record<string, string | undefined>, exec: Exec, warn: (line: string) => void): Promise<Config> {
  if (Object.hasOwn(env, 'RELAY_KEY')) warn('warning: RELAY_KEY is obsolete and ignored; pair each device with relayd pair.');
  const config = loadConfig(env);
  if (config.ntfyUrl) warn('aviso: RELAY_NTFY_URL se ignora; configura RELAY_NTFY_ORIGIN privado e inscribe cada dispositivo.');
  const local = await readLocalTailscale(exec);
  if (!local.ips.includes(config.host)) throw new ConfigError('RELAY_HOST must be a local Tailscale IP; no fallback is allowed.');
  return config;
}
