// Tailscale Services for the `web` tool, published by hand (#96). The Puente never changes the
// Tailscale configuration: a person runs `tailscale serve --service=…` per app from the runbook
// (servePlan, `relayd web`), and the Puente only reads `tailscale status --json` and
// `tailscale serve status --json` to tell whether each app's Service points at its listener.
//
// The Services part of `serve status --json` follows Tailscale's ipn.ServeConfig as read in its
// source: Services map["svc:<name>"] → { TCP map[port]{ HTTPS bool }, Web map["<host>:<port>"]
// { Handlers map[path]{ Proxy string } }, Tun bool }, empty fields omitted. It has not been observed
// on a tailnet with Services enabled, so anything but exactly what servePlan creates counts as not
// published. CLI output may hold node ids, keys and the tailnet name: it is classified, never
// forwarded nor logged.
import { isDeepStrictEqual } from 'node:util';
import type { ToolAvailability } from '../../../protocol/protocol.ts';
import type { Exec } from '../exec.ts';
import type { Publication, PublishBlock, ServicePublisher } from './ports.ts';
import { readWebRegistry } from './web.ts';

const SERVICE = /^relay-[a-z0-9]{16}$/;
const SUFFIX = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/;

/** One read: the parsed JSON, or why it failed. An empty `serve status` means no configuration. */
async function read(exec: Exec, args: string[]): Promise<{ value: unknown } | { failure: 'missing' | 'failed' }> {
  let result;
  try { result = await exec('tailscale', args, { timeoutMs: 3000 }); } catch { return { failure: 'missing' }; }
  if (result.code !== 0) return { failure: 'failed' };
  try { return { value: result.stdout.trim() === '' ? {} : JSON.parse(result.stdout) }; } catch { return { failure: 'failed' }; }
}

/** `value[keys[0]][keys[1]]…` through own properties of objects only, else undefined. */
function at(value: unknown, ...keys: string[]): unknown {
  for (const key of keys) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

const nonEmpty = (value: unknown) => Array.isArray(value) && value.length > 0;

/** What blocks every Service on this machine, or the MagicDNS suffix and the serve Services. */
async function inspect(exec: Exec): Promise<{ block: PublishBlock } | { block: null; suffix: string; services: object }> {
  const status = await read(exec, ['status', '--json']);
  if (!('value' in status) || at(status.value, 'BackendState') !== 'Running') return { block: 'tailscale_unavailable' };
  const magic = at(status.value, 'MagicDNSSuffix');
  const suffix = typeof magic === 'string' ? magic.replace(/\.$/, '') : '';
  if (!SUFFIX.test(suffix)) return { block: 'tailscale_unavailable' };
  if (!nonEmpty(at(status.value, 'CertDomains'))) return { block: 'serve_disabled' };
  // Services only run on a tagged host. Its approval in the admin console is not visible locally.
  if (!nonEmpty(at(status.value, 'Self', 'Tags'))) return { block: 'host_not_tagged' };
  const serve = await read(exec, ['serve', 'status', '--json']);
  if (!('value' in serve) || typeof serve.value !== 'object' || serve.value === null) return { block: 'tailscale_unavailable' };
  const services = at(serve.value, 'Services');
  return { block: null, suffix, services: typeof services === 'object' && services !== null ? services : {} };
}

/**
 * Published only towards the app's listener: the Service must be exactly what servePlan creates.
 * Another target, the app's own port included, or anything more (another path, port, host name or
 * a whole-host tunnel) is not.
 */
function publication(services: object, suffix: string, service: string, listenerPort: number): Publication {
  const host = `${service}.${suffix}`;
  const expected = { TCP: { 443: { HTTPS: true } }, Web: { [`${host}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${listenerPort}` } } } } };
  if (!isDeepStrictEqual(at(services, `svc:${service}`), expected)) return { state: 'blocked', reason: 'service_undefined' };
  return { state: 'published', origin: `https://${host}` };
}

export function createManualPublisher(options: { exec: Exec }): ServicePublisher {
  const { exec } = options;
  return {
    async availability(): Promise<ToolAvailability> {
      const status = await read(exec, ['status', '--json']);
      if (!('value' in status)) return { state: 'unavailable', reason: status.failure === 'missing' ? 'dependency_missing' : 'helper_stopped' };
      if (at(status.value, 'BackendState') !== 'Running') return { state: 'unavailable', reason: 'helper_stopped' };
      if (!nonEmpty(at(status.value, 'CertDomains'))) return { state: 'unavailable', reason: 'not_configured' };
      return { state: 'available' };
    },
    async publish(service, listenerPort) {
      const found = await inspect(exec);
      return found.block ? { state: 'blocked', reason: found.block } : publication(found.services, found.suffix, service, listenerPort);
    },
    // A person runs servePlan(...).clear: the Puente never changes the Tailscale configuration.
    async unpublish() {},
  };
}

const clearArgv = (service: string) => ['tailscale', 'serve', 'clear', `svc:${service}`];

/** The commands a person runs for one app's Service: HTTPS 443 towards its Puente listener. */
export function servePlan(service: string, listenerPort: number): { publish: string[]; clear: string[] } {
  if (!SERVICE.test(service)) throw new Error('Invalid Relay Service name.');
  if (!Number.isInteger(listenerPort) || listenerPort < 1 || listenerPort > 65535) throw new Error('Invalid listener port.');
  return { publish: ['tailscale', 'serve', `--service=svc:${service}`, '--https=443', `http://127.0.0.1:${listenerPort}`], clear: clearArgv(service) };
}

const shell = (argv: string[]) => argv.map((arg) => /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`).join(' ');

const BLOCKED: Record<PublishBlock, string> = {
  tailscale_unavailable: 'Tailscale no está disponible o no está conectado; arráncalo e inicia sesión.',
  serve_disabled: 'la tailnet no tiene activados los certificados HTTPS; actívalos en la consola de administración de Tailscale (DNS).',
  host_not_tagged: 'este equipo no tiene etiqueta; los Services de Tailscale solo funcionan en equipos etiquetados (asígnale una en la consola).',
  service_undefined: 'el Service no está publicado hacia su escucha; ejecuta la orden de publicación.',
  host_not_approved: 'el equipo no está aprobado para este Service; apruébalo en la consola de administración (Services).',
};

/** `relayd web`: each registered app, its Service and the command to publish it, plus Services left behind. */
export async function webPublicationReport(options: { exec: Exec; stateDirectory: string }): Promise<string> {
  let apps;
  try { apps = await readWebRegistry(options.stateDirectory); } catch {
    return 'No se puede leer el registro de aplicaciones (web-apps.json): debe ser un archivo tuyo, con permisos 0600 y contenido válido; repáralo o retíralo y vuelve a registrar las aplicaciones desde Relay.\n';
  }
  const found = await inspect(options.exec);
  const lines = apps.length ? [] : ['No hay aplicaciones registradas.'];
  for (const app of apps) {
    const state = found.block ? { state: 'blocked' as const, reason: found.block } : publication(found.services, found.suffix, app.service, app.listenerPort);
    lines.push(`${app.name}: svc:${app.service}, escucha 127.0.0.1:${app.listenerPort}`);
    if (state.state === 'published') { lines.push(`  publicada en ${state.origin}`); continue; }
    lines.push(`  sin publicar: ${BLOCKED[state.reason]}`);
    // Publishing again only replaces `/`: a Service that also forwards elsewhere is cleared first.
    if (!found.block && at(found.services, `svc:${app.service}`) !== undefined) lines.push(`  retirar antes: ${shell(servePlan(app.service, app.listenerPort).clear)}`);
    lines.push(`  publicar: ${shell(servePlan(app.service, app.listenerPort).publish)}`);
  }
  if (apps.length) lines.push('Tras publicar, aprueba este equipo para cada Service en la consola de Tailscale si aún no lo está.');
  if (found.block) {
    lines.push('No se pueden comprobar los Services obsoletos hasta que Tailscale sirva Services en este equipo.');
  } else {
    // A forgotten app's Service would still forward to a loopback port that is closed or reused.
    const registered = new Set(apps.map((app) => `svc:${app.service}`));
    const stale = Object.keys(found.services).filter((name) => SERVICE.test(name.slice(4)) && name.startsWith('svc:') && !registered.has(name));
    if (stale.length) lines.push('Services obsoletos (ninguna aplicación registrada los usa); retíralos:', ...stale.map((name) => `  ${shell(clearArgv(name.slice(4)))}`));
  }
  return `${lines.join('\n')}\n`;
}
