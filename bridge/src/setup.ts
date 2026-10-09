import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { checkStateDirectory } from './changeLog.ts';
import { loadConfig, readLocalTailscale } from './config.ts';
import type { Exec } from './exec.ts';
import { pairingOrigin } from './pairing.ts';

interface Output { write: (text: string) => unknown }
export interface SetupOptions extends Omit<UnitOptions, 'supervisorDirectory'> {
  replaceService?: boolean; restart?: boolean; port?: string;
  /** Installs relay-supervisor.service and points the Puente at it (RELAY_SUPERVISOR_DIR). */
  supervisor?: boolean;
  /** Restarts an active supervisor: its live terminals end up lost. Never implied by anything else. */
  restartSupervisor?: boolean;
  /** Checks and prints every file and command, writes and changes nothing. */
  dryRun?: boolean;
}
/** Public configuration the units carry; the private .env still overrides the Puente's. */
export interface UnitOptions {
  hermesHome?: string; hermesBin?: string; supervisorDirectory?: string;
  remoteFiles?: boolean; remoteWeb?: boolean; browserHabitual?: boolean;
}
export const SUPERVISOR_UNIT = 'relay-supervisor';
export const BRIDGE_UNIT = 'relay-bridge';
/** node-pty as tested (docs/v3-install.md); the supervisor is compiled with npm run setup, never by setup. */
const NODE_PTY = '1.1.0';
export interface SetupDeps {
  directory: string; home: string; runtimeDirectory: string | undefined; execPath: string;
  platform: string; nodeVersion: string; exec: Exec; stdout: Output; stderr: Output;
  ready: (remainingMs: number) => Promise<boolean>; pair: () => Promise<number>;
  now?: () => number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number;
}

class SetupError extends Error {}

function unitPath(value: string): string {
  if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new SetupError('Las rutas deben ser absolutas y no contener caracteres de control.');
  return value.replace(/%/g, '%%');
}

function quoted(value: string): string {
  return `"${unitPath(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function environmentFilePath(value: string): string {
  // This directive preserves backslashes, then passes the path to libc glob().
  return unitPath(value).replace(/[\\\[\]*?]/g, character => `\\${character}`);
}

/**
 * systemd syntax, not shell syntax: escape specifiers and ExecStart variable substitution.
 * It names no other unit: restarting the Puente to update it never reaches the supervisor, whose
 * environments live in their own scopes.
 */
export function serviceUnit(directory: string, execPath: string, host: string, port: number, options: UnitOptions = {}): string {
  // Validated numeric IP/port values contain no systemd quoting or expansion syntax.
  const bind = loadConfig({ RELAY_HOST: host, RELAY_PORT: String(port) });
  // WorkingDirectory takes a raw path, not a quoted argv item. A trailing
  // slash prevents whitespace trimming or continuation for unusual directory names.
  // The ':' command prefix disables environment expansion for executable and argv.
  const environmentPath = (name: 'HERMES_HOME' | 'HERMES_BIN' | 'RELAY_SUPERVISOR_DIR', value: string | undefined) =>
    value === undefined ? '' : `Environment="${name}=${quoted(value).slice(1, -1)}"\n`;
  const flag = (name: string, on: boolean | undefined) => on ? `Environment=${name}=1\n` : '';
  const environment = environmentPath('HERMES_HOME', options.hermesHome) + environmentPath('HERMES_BIN', options.hermesBin)
    + environmentPath('RELAY_SUPERVISOR_DIR', options.supervisorDirectory) + flag('RELAY_REMOTE_FILES', options.remoteFiles)
    + flag('RELAY_REMOTE_WEB', options.remoteWeb) + flag('RELAY_BROWSER_HABITUAL', options.browserHabitual);
  const workingDirectory = unitPath(directory) + (/[\s\\]$/.test(directory) ? '/' : '');
  return `[Unit]\nDescription=Relay bridge (relayd)\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nWorkingDirectory=${workingDirectory}\nEnvironment=RELAY_HOST=${bind.host}\nEnvironment=RELAY_PORT=${bind.port}\n${environment}EnvironmentFile=${environmentFilePath(path.join(directory, '.env'))}\nExecStart=:${quoted(execPath)} ${quoted(path.join(directory, 'src/main.ts'))} serve\nUMask=0077\nRestart=always\nRestartSec=5\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=default.target\n`;
}

/**
 * The supervisor's own user unit, never tied to the Puente's (supervisor/src/main.ts). Terminals
 * inherit its environment, so it loads no EnvironmentFile and keeps the default umask: the Puente's
 * private settings and UMask=0077 stay out of the person's shells.
 */
export function supervisorUnit(directory: string, execPath: string, runtimeDirectory: string): string {
  const workingDirectory = unitPath(directory) + (/[\s\\]$/.test(directory) ? '/' : '');
  return `[Unit]\nDescription=Relay supervisor (relay-supervisor)\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nWorkingDirectory=${workingDirectory}\nExecStart=:${quoted(execPath)} ${quoted(path.join(directory, 'src/main.ts'))} --runtime ${quoted(runtimeDirectory)}\nRestart=on-failure\nRestartSec=5\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=default.target\n`;
}

async function existingFile(file: string, owned = true): Promise<boolean> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || (owned && stat.uid !== process.getuid?.())) throw new SetupError('Un archivo existente no es regular o no pertenece al usuario.');
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

// Check every existing ancestor before mkdir; do not traverse symlinked configuration directories.
async function checkParents(directory: string): Promise<void> {
  let cursor = directory;
  while (true) {
    try { await fs.lstat(cursor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      cursor = path.dirname(cursor); continue;
    }
    await checkStateDirectory(cursor); return;
  }
}

async function writeUnit(file: string, content: string): Promise<void> {
  // Atomic: an interrupted update leaves the previous unit whole, and the next run compares against it.
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  await fs.rm(temporary, { force: true });
  await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, file);
}

/** Environment= lines of a unit, as systemd reads them: quoted or bare, `%%` for a literal percent. */
export function unitEnvironment(unit: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of unit.split('\n')) {
    if (!line.startsWith('Environment=')) continue;
    let assignment = line.slice('Environment='.length);
    if (assignment.startsWith('"') && assignment.endsWith('"')) assignment = assignment.slice(1, -1).replace(/\\(.)/g, '$1');
    assignment = assignment.replace(/%%/g, '%');
    const equals = assignment.indexOf('=');
    if (equals > 0) env[assignment.slice(0, equals)] = assignment.slice(equals + 1);
  }
  return env;
}

/**
 * Drop-ins systemd applies on top of a unit (`<unit>.service.d/*.conf` next to it), by name only:
 * they may replace ExecStart or Environment, and setup and doctor never read nor change them.
 * ponytail: only the user unit directory setup writes to; /etc/systemd/user and prefix drop-ins
 * (`relay-.service.d`) are not listed. `systemctl --user show -p DropInPaths` covers them if needed.
 */
export async function unitDropIns(userDirectory: string, unit: string): Promise<string[]> {
  try { return (await fs.readdir(path.join(userDirectory, `${unit}.service.d`))).filter(name => name.endsWith('.conf')).sort(); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return []; throw error; }
}

export async function runSetup(options: SetupOptions, deps: SetupDeps): Promise<number> {
  const completed: number[] = [];
  type ServiceAction = 'recargar las unidades' | 'habilitar el servicio' | 'iniciar el servicio' | 'reiniciar el servicio'
    | 'habilitar el supervisor' | 'iniciar el supervisor' | 'reiniciar el supervisor';
  const serviceActions: ServiceAction[] = [];
  let failedAction: ServiceAction | undefined;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  async function command(file: string, args: string[]) {
    try { return await deps.exec(file, args, { timeoutMs: 5000 }); }
    catch { throw new SetupError('No se pudo consultar o ejecutar un requisito del sistema.'); }
  }
  async function checked(file: string, args: string[]) {
    if ((await command(file, args)).code !== 0) throw new SetupError('Un paso del sistema falló; comprueba los requisitos y el servicio de usuario.');
  }
  async function serviceAction(action: ServiceAction, args: string[]) {
    failedAction = action;
    if (options.dryRun) deps.stdout.write(`  systemctl ${args.join(' ')}\n`);
    else await checked('systemctl', args);
    serviceActions.push(action); failedAction = undefined;
  }
  async function isActive(unit: string): Promise<boolean> {
    const active = await command('systemctl', ['--user', 'is-active', unit]);
    // Exit 4 is a unit systemd does not know yet; systemd 261 prints `inactive` for it, older ones `unknown`.
    if (!(active.code === 0 && active.stdout.trim() === 'active') && !(active.code === 3 && ['inactive', 'failed', 'unknown'].includes(active.stdout.trim())) && !(active.code === 4 && ['inactive', 'unknown'].includes(active.stdout.trim()))) throw new SetupError('No se pudo determinar el estado del servicio.');
    return active.code === 0;
  }
  try {
    if (options.browserHabitual && !options.supervisor) throw new SetupError('--browser-habitual necesita --supervisor: el navegador habitual se sirve junto a los entornos.');
    if (options.restartSupervisor && !options.supervisor) throw new SetupError('--restart-supervisor solo se usa junto a --supervisor.');
    if (deps.platform !== 'linux' || !/^\d+\./.test(deps.nodeVersion) || Number(deps.nodeVersion.split('.')[0]) < 26) throw new SetupError('Se necesitan Linux y Node 26 o superior.');
    if (!deps.runtimeDirectory) throw new SetupError('XDG_RUNTIME_DIR es obligatorio; usa una sesión systemd de usuario.');
    await checkStateDirectory(deps.runtimeDirectory); await checkStateDirectory(deps.directory); await checkStateDirectory(deps.home);
    const directory = await fs.realpath(deps.directory);
    if (!await existingFile(path.join(directory, 'src/main.ts'))) throw new SetupError('No se encontró el checkout del Puente.');
    if (!await existingFile(deps.execPath, false)) throw new SetupError('No se encontró el ejecutable de Node.');
    await fs.access(deps.execPath, constants.X_OK);
    let supervisor: { directory: string; runtime: string } | null = null;
    if (options.supervisor) {
      const checkout = await fs.realpath(path.join(directory, '../supervisor')).catch(() => null);
      if (!checkout || !await existingFile(path.join(checkout, 'src/main.ts'))) throw new SetupError('No se encontró el checkout del supervisor junto al Puente.');
      const pty = path.join(checkout, 'node_modules/node-pty');
      const version = await fs.readFile(path.join(pty, 'package.json'), 'utf8').then(text => JSON.parse(text).version, () => null);
      if (version !== NODE_PTY || !await existingFile(path.join(pty, 'build/Release/pty.node'))) {
        throw new SetupError(`El supervisor necesita node-pty ${NODE_PTY} compilado: ejecuta npm run setup en supervisor/ (relayd doctor indica qué falta).`);
      }
      supervisor = { directory: checkout, runtime: path.join(await fs.realpath(deps.runtimeDirectory), 'relay-supervisor') };
    }
    const userDirectory = path.join(deps.home, '.config/systemd/user'); await checkParents(userDirectory);
    await checked('systemctl', ['--user', 'show-environment']);
    const local = await readLocalTailscale(deps.exec);
    completed.push(1);
    const rawPort = options.port ?? '8650'; const port = Number(rawPort);
    if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) throw new SetupError('RELAY_PORT debe ser un puerto entre 1 y 65535.');
    const host = local.ips.find(ip => !ip.includes(':')) ?? local.ips[0];
    pairingOrigin(local.dnsName, port);
    // The supervisor first: written, enabled and started before the Puente that connects to it.
    const units = [
      ...(supervisor ? [{ name: SUPERVISOR_UNIT, content: supervisorUnit(supervisor.directory, deps.execPath, supervisor.runtime) }] : []),
      { name: BRIDGE_UNIT, content: serviceUnit(directory, deps.execPath, host, port, { ...options, supervisorDirectory: supervisor?.runtime }) },
    ].map(unit => ({ ...unit, file: path.join(userDirectory, `${unit.name}.service`) }));
    const envFile = path.join(directory, '.env');
    const hasEnv = await existingFile(envFile);
    const previous = new Map<string, string | null>();
    const warnings: string[] = [];
    for (const unit of units) {
      const old = await existingFile(unit.file) ? await fs.readFile(unit.file, 'utf8') : null;
      if (old !== null && old !== unit.content && !options.replaceService) throw new SetupError(`La unidad existente ${unit.name} es diferente; usa --replace-service para sustituirla.`);
      previous.set(unit.name, old);
      // Each run writes the whole unit: settings of an earlier run that this one omits are lost.
      const kept = unitEnvironment(unit.content);
      const dropped = old === null ? [] : Object.keys(unitEnvironment(old)).filter(key => !Object.hasOwn(kept, key));
      if (dropped.length) warnings.push(`Aviso: ${unit.name}.service ya no tendría ${dropped.join(', ')}; repite las opciones que usas para conservarlas.\n`);
      const dropIns = await unitDropIns(userDirectory, unit.name);
      if (dropIns.length) warnings.push(`Aviso: ${unit.name}.service.d: ${dropIns.join(', ')} se aplican encima de la unidad y pueden sustituir ExecStart o Environment; setup no los lee ni los cambia: revísalos.\n`);
    }
    const bridgeActive = await isActive(BRIDGE_UNIT);
    const supervisorActive = supervisor ? await isActive(SUPERVISOR_UNIT) : false;
    completed.push(2);
    if (options.dryRun) {
      deps.stdout.write('Simulación (--dry-run): no se escribe ningún archivo ni se cambia ningún servicio.\n');
      deps.stdout.write(hasEnv ? `${envFile}: existente; se conserva sin abrirlo.\n` : `${envFile}: se crearía (0600) con RELAY_HOST=${host} y RELAY_PORT=${port}.\n`);
      for (const unit of units) {
        const old = previous.get(unit.name);
        deps.stdout.write(`${unit.file}: ${old === unit.content ? 'sin cambios' : old === null ? 'se crearía' : 'se sustituiría'}.\n${unit.content.replace(/^/gm, '  | ')}\n`);
      }
    }
    for (const warning of warnings) deps.stdout.write(warning);
    if (options.dryRun) deps.stdout.write('Órdenes:\n');
    if (!hasEnv && !options.dryRun) await fs.writeFile(envFile, `RELAY_HOST=${host}\nRELAY_PORT=${port}\n`, { flag: 'wx', mode: 0o600 });
    completed.push(3);
    for (const unit of units) {
      if (previous.get(unit.name) === unit.content || options.dryRun) continue;
      await fs.mkdir(userDirectory, { recursive: true, mode: 0o700 });
      await writeUnit(unit.file, unit.content);
    }
    completed.push(4);
    await serviceAction('recargar las unidades', ['--user', 'daemon-reload']);
    if (supervisor) {
      await serviceAction('habilitar el supervisor', ['--user', 'enable', SUPERVISOR_UNIT]);
      if (!supervisorActive) await serviceAction('iniciar el supervisor', ['--user', 'start', SUPERVISOR_UNIT]);
      else if (options.restartSupervisor) {
        const live = await command('systemctl', ['--user', 'list-units', '--plain', '--no-legend', '--state=active', 'relay-env-*.scope']);
        const count = live.code === 0 ? live.stdout.split('\n').filter(line => line.trim()).length : null;
        deps.stdout.write(`Aviso: reiniciar el supervisor cierra sus terminales; ${count === null ? 'las que sigan vivas' : `${count} entorno(s) vivo(s)`} quedarán perdidos (lost) en Relay.\n`);
        await serviceAction('reiniciar el supervisor', ['--user', 'restart', SUPERVISOR_UNIT]);
      } else if (previous.get(SUPERVISOR_UNIT) !== units[0]!.content) {
        deps.stdout.write('El supervisor activo sigue con su configuración y sus terminales; la unidad nueva se aplica en su próximo arranque (--restart-supervisor lo fuerza).\n');
      }
    }
    await serviceAction('habilitar el servicio', ['--user', 'enable', BRIDGE_UNIT]);
    if (!bridgeActive) await serviceAction('iniciar el servicio', ['--user', 'start', BRIDGE_UNIT]);
    else if (options.restart) await serviceAction('reiniciar el servicio', ['--user', 'restart', BRIDGE_UNIT]);
    if (options.dryRun) { deps.stdout.write('Después mostraría el emparejamiento (relayd pair). Nada se ha cambiado.\n'); return 0; }
    completed.push(5);
    const linger = await command('loginctl', ['show-user', String(process.getuid?.()), '--property=Linger', '--value']);
    if (linger.code !== 0 || linger.stdout.trim() !== 'yes') deps.stdout.write('Para iniciar sin sesión, puedes decidir ejecutar: loginctl enable-linger\n');
    const deadline = now() + (deps.timeoutMs ?? 10_000);
    let ready = false;
    do {
      const remaining = deadline - now(); if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { ready = await Promise.race([deps.ready(remaining), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), remaining); })]); }
      catch { ready = false; }
      finally { clearTimeout(timer); }
      if (!ready) await sleep(Math.min(100, Math.max(0, deadline - now())));
    } while (!ready && now() < deadline);
    if (!ready) throw new SetupError('El socket del Puente no está listo; instala primero la app nueva y luego reinicia el Puente explícitamente con --restart.');
    if (await deps.pair() !== 0) throw new SetupError('El servicio está instalado, pero no se pudo mostrar el emparejamiento; vuelve a ejecutar relayd pair.');
    completed.push(6); deps.stdout.write('Instalación del Puente completada.\n'); return 0;
  } catch (error) {
    const message = error instanceof SetupError ? error.message : 'Comprueba Tailscale, las rutas y los permisos; no se pudo completar la instalación.';
    const actions = !completed.includes(5) && serviceActions.length ? `Acciones completadas del paso 5: ${serviceActions.join('; ')}.\n` : '';
    deps.stderr.write(`${message}\nPasos completados: ${completed.length ? completed.join(', ') : 'ninguno'}.\n${actions}${failedAction ? `Acción fallida: ${failedAction}.\n` : ''}`); return 1;
  }
}
