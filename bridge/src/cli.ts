import { isUuid } from './changeLog.ts';
import type { SetupOptions } from './setup.ts';
import type { ControlRequest, ControlResponse } from './control.ts';
import { renderQrToTerminal } from './qr.ts';
import { NATIVE_HOST_BROWSERS } from './remote/habitualBrowser.ts';

interface Output { write: (text: string) => unknown }
interface CliDeps {
  stdout: Output & { isTTY?: boolean; columns?: number };
  stderr: Output;
  serve: () => Promise<void>;
  setup?: (options: Required<Pick<SetupOptions, SetupFlag>>) => Promise<number>;
  request: (request: ControlRequest) => Promise<ControlResponse>;
  renderQr?: (text: string, columns: number) => string | null;
  /** Registers the native messaging host of the Relay extension for one browser (habitualBrowser.ts). */
  registerBrowser?: (browser: string) => Promise<{ manifest: string; extensionDirectory: string; extensionId: string }>;
  /** relayd doctor: the capability checks (doctor.ts), already formatted. */
  doctor?: () => Promise<{ text: string; ok: boolean }>;
  /** relayd web: registered apps and their manual publication (tailscaleServices.ts). */
  webReport?: () => Promise<string>;
}

type SetupFlag = 'replaceService' | 'restart' | 'supervisor' | 'restartSupervisor' | 'remoteFiles' | 'remoteWeb' | 'browserHabitual' | 'dryRun';
const SETUP_FLAGS: Record<string, SetupFlag> = {
  '--replace-service': 'replaceService', '--restart': 'restart', '--supervisor': 'supervisor', '--restart-supervisor': 'restartSupervisor',
  '--files': 'remoteFiles', '--web': 'remoteWeb', '--browser-habitual': 'browserHabitual', '--dry-run': 'dryRun',
};

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command = 'serve', argument] = argv;
  if (command === '--help' && argv.length === 1) {
    deps.stdout.write('relayd serve\nrelayd pair\nrelayd devices\nrelayd revoke <device-id>\n'
      + 'relayd setup [--replace-service] [--restart] [--supervisor] [--restart-supervisor] [--files] [--web] [--browser-habitual] [--dry-run]\n'
      + 'relayd doctor\nrelayd web\nrelayd browser <google-chrome|chromium|chrome-for-testing>\nrelayd --help\n');
    return 0;
  }
  if ((command === 'serve' && argv.length <= 1)) { await deps.serve(); return 0; }
  const flags = argv.slice(1);
  if (command === 'setup' && flags.every(flag => Object.hasOwn(SETUP_FLAGS, flag)) && new Set(flags).size === flags.length) {
    const options = Object.fromEntries(Object.entries(SETUP_FLAGS).map(([flag, key]) => [key, flags.includes(flag)])) as Record<SetupFlag, boolean>;
    // A dry run only prints: it needs no terminal for the pairing QR.
    if (!deps.stdout.isTTY && !options.dryRun) { deps.stderr.write('Ejecuta relayd setup en una terminal interactiva (o usa --dry-run).\n'); return 1; }
    if (!deps.setup) { deps.stderr.write('La instalación del Puente no está disponible.\n'); return 1; }
    return deps.setup(options);
  }
  if (command === 'doctor' && argv.length === 1 && deps.doctor) {
    const { text, ok } = await deps.doctor();
    deps.stdout.write(`Diagnóstico de Relay V3, solo lectura: no cambia servicios ni lee secretos.\n${text}`);
    return ok ? 0 : 1;
  }
  if (command === 'web' && argv.length === 1 && deps.webReport) {
    try { deps.stdout.write(await deps.webReport()); return 0; }
    catch { deps.stderr.write('No se pudo leer el registro de aplicaciones web; comprueba los permisos del Puente.\n'); return 1; }
  }
  if (command === 'browser') {
    if (argv.length !== 2 || !Object.hasOwn(NATIVE_HOST_BROWSERS, argument!) || !deps.registerBrowser) { deps.stderr.write('Comando inválido. Consulta relayd --help.\n'); return 1; }
    try {
      const { manifest, extensionDirectory, extensionId } = await deps.registerBrowser(argument!);
      deps.stdout.write(`Adaptador de Relay registrado para ${argument}: ${manifest}\nFalta cargar la extensión en ese navegador, en la computadora:\n`
        + `  1. Abre chrome://extensions y activa el «Modo de desarrollador».\n  2. Pulsa «Cargar descomprimida» y elige ${extensionDirectory}\n`
        + `  3. Comprueba que su ID es ${extensionId}.\nDespués actívalo en el Puente: relayd setup --supervisor --browser-habitual --replace-service --restart\n`);
      return 0;
    } catch {
      deps.stderr.write('No se pudo registrar el adaptador del navegador; comprueba los permisos de la carpeta de configuración y del Puente.\n'); return 1;
    }
  }
  if (!((command === 'pair' || command === 'devices') && argv.length === 1)
    && !(command === 'revoke' && argv.length === 2 && isUuid(argument))) {
    deps.stderr.write('Comando inválido. Consulta relayd --help.\n'); return 1;
  }
  if (command === 'pair' && !deps.stdout.isTTY) {
    deps.stderr.write('Ejecuta relayd pair en una terminal interactiva.\n'); return 1;
  }
  try {
    const response = await deps.request(command === 'revoke' ? { command, deviceId: argument } : { command: command as 'pair' | 'devices' });
    if (!response.ok) {
      deps.stderr.write(response.error.code === 'device_not_found' ? 'No se encontró el dispositivo.\n' : response.error.code === 'invalid_command' ? 'Comando inválido.\n' : 'El Puente no está disponible; comprueba su servicio de usuario y la sesión systemd.\n');
      return 1;
    }
    const result = response.result;
    if (command === 'pair' && 'payload' in result) {
      const { payload, expiresAt } = result;
      const renderer = deps.renderQr ?? renderQrToTerminal;
      const qr = renderer(JSON.stringify(payload), deps.stdout.columns ?? 0);
      deps.stdout.write(`Dirección del Puente: ${payload.url}\nCódigo: ${payload.code.slice(0, 5)}-${payload.code.slice(5)}\nCaduca: ${new Date(expiresAt).toISOString()} (5 minutos)\n`);
      deps.stdout.write(qr ?? 'Agranda la terminal para ver el QR o usa la dirección y el código para escribir a mano.\n');
    } else if (command === 'devices' && 'devices' in result) {
      if (result.devices.length === 0) deps.stdout.write('No hay dispositivos emparejados.\n');
      for (const device of result.devices) {
        deps.stdout.write(`${device.id}\t${device.name}\t${new Date(device.pairedAt).toISOString()}\t${device.revokedAt === null ? 'activo' : `revocado ${new Date(device.revokedAt).toISOString()}`}\n`);
      }
    } else if (command === 'revoke' && 'device' in result) {
      deps.stdout.write(`Dispositivo revocado: ${result.device.id}\n`);
    } else { throw new Error('Invalid control response.'); }
    return 0;
  } catch {
    deps.stderr.write('El Puente no está disponible; comprueba su servicio de usuario y la sesión systemd.\n'); return 1;
  }
}
