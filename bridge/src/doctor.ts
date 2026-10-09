// relayd doctor: what this Server can run of V3, read-only. It runs version and status queries
// only, never opens the Puente's .env, the supervisor key or a browser profile, and never connects
// to a browser. Every missing piece names the step that provides it; the step itself is the person's.
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError, loadConfig } from './config.ts';
import type { Exec, ExecResult } from './exec.ts';
import { DEDICATED_BROWSER_PROGRAMS } from '../../protocol/supervisor.ts';
import { EXTENSION_DIRECTORY, NATIVE_HOST_BROWSERS, NATIVE_HOST_NAME, RELAY_EXTENSION_ID } from './remote/habitualBrowser.ts';
import { BRIDGE_UNIT, SUPERVISOR_UNIT, unitDropIns, unitEnvironment } from './setup.ts';

/**
 * What V3 was tested on (docs/v3-install.md). Anything else is reported as not certified, never as
 * compatible because a dependency claims support.
 */
export const TESTED = {
  arch: ['x64'],
  nodeMajor: 26,
  nodePty: '1.1.0',
  browsers: { 'google-chrome': ['154.0.8037.57'], 'chrome-for-testing': ['154.0.8037.92'], chromium: [] as string[] } as Record<string, string[]>,
  /** The dedicated browser (#92), as its program's --version names it. */
  dedicated: ['Chromium 152.0.7977.82', 'Google Chrome 154.0.8037.57'],
};
const MINIMUM_CHROME = Number((await fs.readFile(new URL('manifest.json', EXTENSION_DIRECTORY), 'utf8').then(JSON.parse)).minimum_chrome_version);
/** Programs to ask for a version; Chrome for Testing has no fixed path and is only checked by its host manifest. */
const BROWSER_PROGRAMS: Record<string, string[]> = { 'google-chrome': ['google-chrome-stable', 'google-chrome'], chromium: ['chromium', 'chromium-browser'] };
const RUNBOOK = 'docs/v3-install.md';

export type CheckState = 'ok' | 'aviso' | 'falta';
export interface Check { area: string; state: CheckState; detail: string; action?: string }
export interface DoctorDeps {
  platform: string; arch: string; nodeVersion: string; execPath: string; uid: number;
  home: string; configHome: string; runtimeDirectory: string | undefined;
  /** The Puente checkout (bridge/); the supervisor is its sibling. */
  directory: string;
  /** Prefix for /proc and /sys; tests point it at a fixture. */
  root?: string;
  exec: Exec;
}

async function stat(file: string) {
  try { return await fs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
const exists = async (file: string) => (await stat(file).catch(() => null)) !== null;

export async function runDoctor(deps: DoctorDeps): Promise<Check[]> {
  const root = deps.root ?? '/';
  const checks: Check[] = [];
  const add = (area: string, state: CheckState, detail: string, action?: string) => { checks.push(action ? { area, state, detail, action } : { area, state, detail }); };
  const run = async (file: string, args: string[]): Promise<ExecResult | null> => {
    try { return await deps.exec(file, args, { timeoutMs: 5000 }); } catch { return null; }
  };
  const succeeded = async (file: string, args: string[]) => (await run(file, args))?.code === 0;

  // Base: the Server V3 targets.
  if (deps.platform !== 'linux') add('Sistema', 'falta', `${deps.platform} no está soportado`, 'V3 solo admite Servidores Linux con systemd y cgroup v2.');
  else if (TESTED.arch.includes(deps.arch)) add('Sistema', 'ok', `Linux ${deps.arch} (probado)`);
  else add('Sistema', 'aviso', `Linux ${deps.arch}: arquitectura no certificada`, 'Solo x86_64 está probado; registra el resultado antes de darla por compatible.');
  const major = Number(/^(\d+)\./.exec(deps.nodeVersion)?.[1] ?? 0);
  if (major < TESTED.nodeMajor) add('Node', 'falta', `${deps.nodeVersion}: se necesita Node ${TESTED.nodeMajor}`, `Instala Node ${TESTED.nodeMajor} y vuelve a ejecutar relayd doctor.`);
  else if (major === TESTED.nodeMajor) add('Node', 'ok', `${deps.nodeVersion} (probado: ${TESTED.nodeMajor})`);
  else add('Node', 'aviso', `${deps.nodeVersion}: versión no certificada (probado: ${TESTED.nodeMajor})`, 'Recompila node-pty con npm run setup en supervisor/ y comprueba las terminales.');

  // Supervision: the user manager, cgroup v2 and the delegated subtree where environments live.
  const systemd = await run('systemctl', ['--user', 'show-environment']);
  const systemdRun = (await run('systemd-run', ['--version']))?.stdout.split('\n')[0]?.match(/^systemd \d+/)?.[0];
  if (systemd?.code !== 0) add('systemd de usuario', 'falta', 'no hay gestor de usuario de systemd en esta sesión', 'Ejecuta Relay desde una sesión del usuario con systemd y XDG_RUNTIME_DIR.');
  else if (!systemdRun) add('systemd de usuario', 'falta', 'systemd-run no responde', 'Instala systemd completo: el supervisor abre cada entorno con systemd-run --user --scope.');
  else add('systemd de usuario', 'ok', `${systemdRun}, gestor de usuario activo`);
  if (!await exists(path.join(root, 'sys/fs/cgroup/cgroup.controllers'))) add('cgroup v2', 'falta', 'no hay jerarquía cgroup v2 unificada', 'Arranca el sistema con cgroup v2 (systemd.unified_cgroup_hierarchy=1).');
  else add('cgroup v2', 'ok', 'jerarquía unificada');
  const slice = path.join(root, `sys/fs/cgroup/user.slice/user-${deps.uid}.slice/user@${deps.uid}.service/app.slice`);
  if (!await exists(slice)) add('Permisos de supervisión', 'falta', 'el gestor de usuario no tiene subárbol delegado (app.slice)', 'Usa el gestor de usuario de systemd con delegación por defecto (user@.service).');
  else if (!await exists(path.join(slice, 'cgroup.kill'))) add('Permisos de supervisión', 'falta', 'el núcleo no ofrece cgroup.kill', 'Se necesita Linux 5.14 o posterior para terminar un entorno completo.');
  else if (!await fs.access(path.join(slice, 'cgroup.kill'), constants.W_OK).then(() => true, () => false)) add('Permisos de supervisión', 'falta', 'sin permiso de escritura en cgroup.kill del subárbol del usuario', 'Revisa la delegación de user@.service; Relay no la cambia.');
  else add('Permisos de supervisión', 'ok', 'subárbol delegado con cgroup.kill');
  const linger = await run('loginctl', ['show-user', String(deps.uid), '--property=Linger', '--value']);
  if (linger?.code === 0 && linger.stdout.trim() === 'yes') add('Linger', 'ok', 'el gestor de usuario sigue activo sin sesión abierta');
  else add('Linger', 'aviso', 'sin linger, cerrar la última sesión termina el supervisor y sus terminales', 'Si lo quieres, decídelo tú: loginctl enable-linger');

  // PTY: node-pty compiled inside the supervisor package against this Node.
  const supervisor = path.resolve(deps.directory, '../supervisor');
  const pty = path.join(supervisor, 'node_modules/node-pty');
  const ptyVersion = await fs.readFile(path.join(pty, 'package.json'), 'utf8').then((text) => String(JSON.parse(text).version), () => null);
  const loads = ptyVersion === TESTED.nodePty && await exists(path.join(pty, 'build/Release/pty.node'))
    && await succeeded(deps.execPath, ['-e', 'require(process.argv[1])', pty]);
  if (loads) add('PTY (node-pty)', 'ok', `node-pty ${TESTED.nodePty} compilado y cargado con este Node`);
  else if (ptyVersion !== null && ptyVersion !== TESTED.nodePty) add('PTY (node-pty)', 'falta', `node-pty ${ptyVersion} instalado; se espera ${TESTED.nodePty} (probado)`, 'Restaura el lockfile de supervisor/ y ejecuta npm run setup allí.');
  else {
    const absent = [];
    for (const tool of ['c++', 'make', 'python3']) if (!await succeeded(tool, ['--version'])) absent.push(tool);
    if (!await exists(path.join(path.dirname(path.dirname(deps.execPath)), 'include/node/node.h'))) absent.push('cabeceras de Node (include/node)');
    add('PTY (node-pty)', 'falta', `node-pty ${TESTED.nodePty} no está compilado o no carga${absent.length ? `; faltan: ${absent.join(', ')}` : ''}`,
      `${absent.length ? 'Instálalos con el gestor de paquetes del sistema y después ' : ''}ejecuta: cd supervisor && npm run setup`);
  }

  // The supervisor service: its unit, its state and its private directory (the key is never read).
  // Where relayd setup writes them (setup.ts), not XDG_CONFIG_HOME.
  const units = path.join(deps.home, '.config/systemd/user');
  const supervisorRuntime = deps.runtimeDirectory ? path.join(deps.runtimeDirectory, 'relay-supervisor') : null;
  const runtimeStat = supervisorRuntime ? await stat(supervisorRuntime).catch(() => null) : null;
  if (!await exists(path.join(units, 'relay-supervisor.service'))) add('Supervisor', 'falta', 'su servicio de usuario no está instalado', 'relayd setup --supervisor (consulta antes relayd setup --supervisor --dry-run).');
  else if (runtimeStat && (!runtimeStat.isDirectory() || runtimeStat.uid !== deps.uid || (runtimeStat.mode & 0o077) !== 0)) add('Supervisor', 'falta', `${supervisorRuntime} tiene permisos inseguros o no es del usuario`, 'Detén relay-supervisor, borra esa carpeta y vuelve a iniciarlo: la crea con 0700.');
  else if ((await run('systemctl', ['--user', 'is-active', 'relay-supervisor']))?.stdout.trim() !== 'active') add('Supervisor', 'falta', 'instalado pero detenido', 'systemctl --user start relay-supervisor');
  else if (!runtimeStat || !await exists(path.join(supervisorRuntime!, 'supervisor.sock'))) add('Supervisor', 'falta', 'activo pero sin socket', 'Revisa journalctl --user -u relay-supervisor.');
  else add('Supervisor', 'ok', 'activo, separado del Puente; el estado de cada terminal se ve en Relay');

  // The Puente's public configuration in its unit. The private .env may override it and is not read.
  const bridgeUnit = await fs.readFile(path.join(units, 'relay-bridge.service'), 'utf8').catch(() => null);
  if (bridgeUnit === null) add('Puente', 'aviso', 'sin unidad de usuario instalada', 'relayd setup (o scripts/bridge-wizard.sh).');
  else {
    try {
      const config = loadConfig(unitEnvironment(bridgeUnit));
      const tools = [config.supervisorDirectory && 'terminal', config.remoteFiles && 'archivos', config.remoteWeb && 'web', config.supervisorDirectory && config.browserHabitual && 'navegador habitual'].filter(Boolean);
      if (config.supervisorDirectory && supervisorRuntime && config.supervisorDirectory !== supervisorRuntime) {
        add('Puente', 'falta', `RELAY_SUPERVISOR_DIR apunta a otro directorio que el del supervisor (${supervisorRuntime})`, 'relayd setup --supervisor --replace-service --restart');
      } else if (config.browserHabitual && !config.supervisorDirectory) {
        add('Puente', 'falta', 'RELAY_BROWSER_HABITUAL necesita el supervisor', 'relayd setup --supervisor --browser-habitual --replace-service --restart');
      } else add('Puente', 'ok', `${tools.length ? `unidad con ${tools.join(', ')}` : 'unidad sin herramientas V3'}; .env puede cambiarlo y no se lee`);
    } catch (error) {
      add('Puente', 'falta', error instanceof ConfigError ? `configuración inválida en la unidad: ${error.message}` : 'unidad ilegible', 'relayd setup --dry-run muestra la unidad correcta; aplícala con --replace-service.');
    }
  }
  // Drop-ins override the units above (ExecStart, Environment): named, never read.
  for (const [area, unit] of [['Puente', BRIDGE_UNIT], ['Supervisor', SUPERVISOR_UNIT]] as const) {
    const names = await unitDropIns(units, unit).catch(() => null);
    if (names === null) add(`${area}: drop-ins`, 'aviso', `no se puede listar ${unit}.service.d`, 'Revisa sus permisos: systemd aplica lo que contenga encima de la unidad.');
    else if (names.length) add(`${area}: drop-ins`, 'aviso', `${unit}.service.d: ${names.join(', ')} se aplican encima de la unidad y pueden sustituir ExecStart o Environment; doctor no los lee`, 'Revísalos antes de relayd setup: setup no los cambia.');
  }

  // Files and web discovery only need the account's own /proc.
  if (deps.platform === 'linux' && await exists(path.join(root, 'proc/self/fd'))) add('Archivos', 'ok', '/proc/self/fd accesible');
  else add('Archivos', 'falta', '/proc/self/fd no accesible', 'Monta /proc sin hidepid para el usuario del Puente.');
  if (await fs.access(path.join(root, 'proc/net/tcp'), constants.R_OK).then(() => true, () => false)) add('Web: descubrimiento', 'ok', '/proc/net/tcp legible');
  else add('Web: descubrimiento', 'falta', '/proc/net/tcp no legible', 'Monta /proc sin restricciones de red para el usuario del Puente.');

  // Web publication: HTTPS certificates and a tagged host are tailnet console steps.
  const tailscale = await run('tailscale', ['status', '--json']);
  let status: { BackendState?: unknown; CertDomains?: unknown; Self?: { Tags?: unknown } } | null = null;
  try { status = tailscale?.code === 0 ? JSON.parse(tailscale.stdout) : null; } catch { status = null; }
  if (status?.BackendState !== 'Running') add('Web: Tailscale HTTPS/Services', 'falta', 'Tailscale no responde o no está conectado', 'Instala y conecta tailscale en el Servidor.');
  else {
    const missing = [];
    if (!Array.isArray(status.CertDomains) || status.CertDomains.length === 0) missing.push('certificados HTTPS no habilitados en la tailnet');
    if (!Array.isArray(status.Self?.Tags) || status.Self.Tags.length === 0) missing.push('el anfitrión no tiene tag (Services lo exige)');
    if (missing.length) add('Web: Tailscale HTTPS/Services', 'falta', missing.join('; '), `Pasos de consola en ${RUNBOOK} («Publicar una web»); la validación real de Services sigue pendiente.`);
    else add('Web: Tailscale HTTPS/Services', 'ok', 'HTTPS y tag presentes; cada Service se define, aprueba y publica a mano', 'relayd web lista las órdenes por aplicación.');
  }

  // The dedicated browser (#92): the program the supervisor would launch, looked for as it does (the
  // first of DEDICATED_BROWSER_PROGRAMS in the user manager's PATH), and the controllers its scope's
  // MemoryMax and TasksMax need in the delegated subtree.
  const managerPath = systemd?.code === 0 ? /^PATH=(.*)$/m.exec(systemd.stdout)?.[1] ?? '' : '';
  let dedicated: string | null = null;
  search: for (const name of DEDICATED_BROWSER_PROGRAMS) {
    for (const folder of managerPath.split(':').filter((entry) => entry.startsWith('/'))) {
      if (await fs.access(path.join(folder, name), constants.X_OK).then(() => true, () => false)) { dedicated = path.join(folder, name); break search; }
    }
  }
  if (!dedicated) {
    add('Navegador dedicado', 'aviso', 'no hay Chromium ni Google Chrome en el PATH del supervisor: Relay lo mostrará como no disponible',
      `Instala Chromium o Google Chrome; el supervisor usa el primero de ${DEDICATED_BROWSER_PROGRAMS.join(', ')} en su PATH.`);
  } else {
    const version = /^(?:Chromium|Google Chrome) \d+\.\d+\.\d+\.\d+/.exec((await run(dedicated, ['--version']))?.stdout.trim() ?? '')?.[0];
    if (!version) add('Navegador dedicado', 'aviso', `${dedicated} no da su versión`, 'Comprueba que arranca con --version antes de usar el navegador dedicado.');
    else if (TESTED.dedicated.includes(version)) add('Navegador dedicado', 'ok', `${version} (probado), ${dedicated}`);
    else add('Navegador dedicado', 'aviso', `${version}: versión no certificada, ${dedicated}`, `Prueba el navegador dedicado antes de darlo por compatible (${RUNBOOK}).`);
  }
  const controllers = (await fs.readFile(path.join(slice, 'cgroup.controllers'), 'utf8').catch(() => '')).split(/\s+/);
  const undelegated = ['memory', 'pids'].filter((controller) => !controllers.includes(controller));
  if (undelegated.length) {
    add('Navegador dedicado: topes', 'falta', `el subárbol del usuario no delega ${undelegated.join(' ni ')}: MemoryMax y TasksMax del navegador no se aplicarían`, 'Revisa la delegación de user@.service; Relay no la cambia.');
  } else add('Navegador dedicado: topes', 'ok', 'memory y pids delegados: MemoryMax y TasksMax se aplican');

  // Browsers: versions from --version only; host manifests from the browser's config, never a profile.
  let found = 0;
  for (const browser of Object.keys(NATIVE_HOST_BROWSERS)) {
    let version: string | null = null;
    for (const program of BROWSER_PROGRAMS[browser] ?? []) {
      const result = await run(program, ['--version']);
      version = result?.code === 0 ? /\d+\.\d+\.\d+\.\d+/.exec(result.stdout)?.[0] ?? null : null;
      if (version) break;
    }
    const manifest = path.join(deps.configHome, NATIVE_HOST_BROWSERS[browser]!, 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`);
    const registered = await stat(manifest).catch(() => null);
    if (version) {
      found++;
      const chromeMajor = Number(version.split('.')[0]);
      if (chromeMajor < MINIMUM_CHROME) {
        add(`Navegador ${browser}`, 'aviso', `${browser} ${version}: la extensión de Relay exige ${MINIMUM_CHROME}`, 'Usa Google Chrome para el navegador habitual.');
        if (!registered) continue;
      } else if (TESTED.browsers[browser]?.includes(version)) add(`Navegador ${browser}`, 'ok', `${version} (probado)`);
      else add(`Navegador ${browser}`, 'aviso', `${version}: versión no certificada`, 'Prueba el control del habitual antes de darla por compatible.');
    }
    if (!registered) {
      if (version) add(`Adaptador ${browser}`, 'aviso', 'adaptador de la extensión no registrado', `Para usar el habitual en ${browser}: relayd browser ${browser}`);
      continue;
    }
    const register = `relayd browser ${browser}`;
    let host: { name?: unknown; type?: unknown; path?: unknown; allowed_origins?: unknown };
    if (!registered.isFile()) { add(`Adaptador ${browser}`, 'falta', 'el manifiesto no es un archivo regular', `Bórralo y ejecuta ${register}`); continue; }
    try { host = JSON.parse(await fs.readFile(manifest, 'utf8')); }
    catch (error) {
      const denied = (error as NodeJS.ErrnoException).code === 'EACCES';
      add(`Adaptador ${browser}`, 'falta', denied ? 'sin permiso para leer el manifiesto del adaptador' : 'manifiesto del adaptador malformado', `${denied ? 'Corrige sus permisos o ' : ''}${register}`);
      continue;
    }
    const origins = Array.isArray(host.allowed_origins) ? host.allowed_origins : [];
    const wrapper = typeof host.path === 'string' ? host.path : '';
    if (host.name !== NATIVE_HOST_NAME || host.type !== 'stdio' || origins.length !== 1 || origins[0] !== `chrome-extension://${RELAY_EXTENSION_ID}/`) {
      add(`Adaptador ${browser}`, 'falta', 'el manifiesto no corresponde a la extensión de Relay (otra extensión)', register);
    } else if (!path.isAbsolute(wrapper) || !await fs.access(wrapper, constants.X_OK).then(() => true, () => false)) {
      add(`Adaptador ${browser}`, 'falta', 'el adaptador al que apunta no existe o no es ejecutable', register);
    } else {
      add(`Adaptador ${browser}`, 'ok', 'registrado', `Cargar la extensión es un paso tuyo: chrome://extensions → Modo de desarrollador → Cargar descomprimida (${EXTENSION_DIRECTORY.pathname}).`);
    }
  }
  if (found === 0) add('Navegador', 'aviso', 'no se encontró Google Chrome ni Chromium', 'Instala Google Chrome para el navegador habitual.');
  return checks;
}

export function formatChecks(checks: Check[]): string {
  return checks.map((check) => `${check.state.padEnd(6)} ${check.area.padEnd(30)} ${check.detail}\n${check.action ? `${' '.repeat(7)}→ ${check.action}\n` : ''}`).join('');
}
