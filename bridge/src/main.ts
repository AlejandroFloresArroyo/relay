import { createDecisionStore, deferredDecisionStore } from './decisionStore.ts';
import os from 'node:os';
import { createDiscovery } from './discovery.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadServeConfig } from './config.ts';
import { runCli } from './cli.ts';
import { sendControlRequest, startService } from './control.ts';
import { realExec } from './exec.ts';
import type { Exec } from './exec.ts';
import { pairingOrigin } from './pairing.ts';
import type { RemoteTools } from './remote/ports.ts';
import type { ExtensionLink } from './remote/habitualBrowser.ts';
import type { SetupOptions } from './setup.ts';

const directory = fileURLToPath(new URL('../', import.meta.url));
function log(line: string): void { console.log(`${new Date().toISOString()} ${line}`); }

export function runFailureLogger(write: (line: string) => void): (untrusted: string) => void {
  return () => write('Run processing failed.');
}

export async function serve(deps?: { env: Record<string, string | undefined>; exec: Exec; start: typeof startService }): Promise<void> {
  const env = deps?.env ?? process.env; const exec = deps?.exec ?? realExec;
  const config = await loadServeConfig(env, exec, log);
  // Administrative commands never instantiate Hermes or RunManager.
  const [{ RealHermes }, { RunManager }, { createNotifier }, { createApp, RELAYD_VERSION }, { createTailnet }, { createSupervisorClient }, { ENVIRONMENTS_CAPABILITY }, { TERMINAL_CAPABILITY }, { createRemoteFileSystem, FILES_CAPABILITY }, { BROWSER_CAPABILITY }, { listenExtension }, { WEB_CAPABILITY }, { createLinuxSockets }, { createManualPublisher }, { createMetrics, createSystemReader }] = await Promise.all([
    import('./hermes_real.ts'), import('./runs.ts'), import('./notify.ts'), import('./server.ts'), import('./tailnet.ts'),
    import('./remote/supervisorClient.ts'), import('./remote/environments.ts'), import('./remote/terminals.ts'), import('./remote/files.ts'), import('./remote/browsers.ts'),
    import('./remote/habitualBrowser.ts'), import('./remote/web.ts'), import('./remote/linuxSockets.ts'), import('./remote/tailscaleServices.ts'), import('./metrics.ts'),
  ]);
  let runs: InstanceType<typeof RunManager> | null = null;
  const service = await (deps?.start ?? startService)({
    directory, runtimeDirectory: env.XDG_RUNTIME_DIR, host: config.host, port: config.port, serverName: os.hostname(),
    origin: async () => {
      const result = await exec('tailscale', ['status', '--json'], { timeoutMs: 3000 });
      if (result.code !== 0) throw new Error('Tailscale status is unavailable.');
      const status = JSON.parse(result.stdout);
      if (typeof status?.Self?.DNSName !== 'string') throw new Error('Tailscale name is unavailable.');
      return pairingOrigin(status.Self.DNSName, config.port);
    },
    createHttpApp: async (security) => {
      // createApp initializes private conversation receipts with security.store/changeLog.
      // BEGIN IMAGES (#39): MessageReceipts injection.
      // END IMAGES
      // BEGIN FILES (#40): HermesMedia injection.
      // END FILES
      const hermes = new RealHermes({ home: config.hermesHome, bin: config.hermesBin, mediaSource: config.hermesMediaSource, mediaPython: config.hermesMediaPython, exec });
      const decisions = deferredDecisionStore(createDecisionStore({ directory: security.store.directory }));
      runs = new RunManager({ hermes, decisionStore: decisions, notifier: createNotifier(null), log: runFailureLogger(log) });
      const remote: RemoteTools = {};
      // Files need nothing installed, only the Puente account's own permissions on Linux. Off unless
      // RELAY_REMOTE_FILES=1 (#85): every write is recorded since #86; until #88 uses them, production does not change.
      if (config.remoteFiles) remote.files = { capability: FILES_CAPABILITY, port: createRemoteFileSystem({ home: os.homedir(), hermesHome: config.hermesHome, stateDirectory: security.store.directory, changeLog: security.store.changeLog }) };
      // Local web apps (#89/#90) through one listener and one Tailscale Service each. Off unless
      // RELAY_REMOTE_WEB=1 (#96): a person publishes each Service by hand (`relayd web` prints the
      // command); the Puente only reads Tailscale's state and never changes its configuration.
      if (config.remoteWeb) remote.web = { capability: WEB_CAPABILITY, port: { apps: createLinuxSockets(), publisher: createManualPublisher({ exec }) } };
      // The supervisor runs in its own user unit (#96 installs it); this only connects to it. It holds
      // the environments, their terminals and their dedicated browsers; whether a browser is installed
      // is RemoteStatus.browser.dedicated, never the advertisement.
      let extension: ExtensionLink | null = null;
      if (config.supervisorDirectory) {
        const supervisor = createSupervisorClient({ runtimeDirectory: config.supervisorDirectory });
        remote.environments = { capability: ENVIRONMENTS_CAPABILITY, port: supervisor };
        remote.terminal = { capability: TERMINAL_CAPABILITY, port: supervisor };
        // The habitual browser through the Relay extension (#93): its host reaches this socket in the
        // Puente's state. Off unless RELAY_BROWSER_HABITUAL=1; while off, RemoteStatus.browser.habitual is not_configured.
        if (config.browserHabitual) {
          extension = await listenExtension({ stateDirectory: security.store.directory, log }).catch(() => {
            log('The browser extension socket could not be opened; the habitual browser is off.');
            return null;
          });
        }
        remote.browser = { capability: BROWSER_CAPABILITY, port: { dedicated: supervisor.browser, habitual: extension } };
      }
      // CPU, memory and the Hermes disk; not advertised where the system reader cannot work.
      const metrics = createMetrics({ reader: createSystemReader(), hermesHome: config.hermesHome });
      const app = createApp({ ...security, config, hermes, runs, tailnet: createTailnet(exec), discovery: createDiscovery({ exec, port: config.port }), log, remote, metrics });
      app.on('close', () => { void extension?.close(); });
      return app;
    },
  });
  log(`relayd ${RELAYD_VERSION} listening on http://${config.host}:${config.port}`);
  service.server.on('close', () => runs?.close());
  async function shutdown(): Promise<void> { runs?.close(); await service.close(); }
  process.once('SIGINT', () => { void shutdown(); }); process.once('SIGTERM', () => { void shutdown(); });
}

const cliDeps = {
  stdout: process.stdout, stderr: process.stderr, serve,
  request: (request: import('./control.ts').ControlRequest) => sendControlRequest({ directory, runtimeDirectory: process.env.XDG_RUNTIME_DIR, request }),
  setup: async (options: Omit<SetupOptions, 'port' | 'hermesHome' | 'hermesBin'>) => {
    const { runSetup } = await import('./setup.ts');
    return runSetup({ ...options, port: process.env.RELAY_PORT, hermesHome: process.env.HERMES_HOME?.trim() || undefined, hermesBin: process.env.HERMES_BIN?.trim() || undefined }, {
      directory, home: os.homedir(), runtimeDirectory: process.env.XDG_RUNTIME_DIR, execPath: process.execPath,
      platform: process.platform, nodeVersion: process.versions.node, exec: realExec, stdout: process.stdout, stderr: process.stderr,
      ready: async (remainingMs) => {
        const response = await sendControlRequest({ directory, runtimeDirectory: process.env.XDG_RUNTIME_DIR, request: { command: 'devices' }, timeoutMs: Math.min(remainingMs, 1000) });
        return response.ok;
      },
      pair: () => runCli(['pair'], cliDeps),
    });
  },
  registerBrowser: async (browser: string) => {
    const { registerNativeHost } = await import('./remote/habitualBrowser.ts');
    return registerNativeHost({ stateDirectory: directory, configHome: process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'), browser, nodePath: process.execPath });
  },
  doctor: async () => {
    const { formatChecks, runDoctor } = await import('./doctor.ts');
    const checks = await runDoctor({
      platform: process.platform, arch: process.arch, nodeVersion: process.versions.node, execPath: process.execPath, uid: process.getuid?.() ?? -1,
      home: os.homedir(), configHome: process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'), runtimeDirectory: process.env.XDG_RUNTIME_DIR,
      directory, exec: realExec,
    });
    return { text: formatChecks(checks), ok: checks.every((check) => check.state !== 'falta') };
  },
  webReport: async () => {
    const { webPublicationReport } = await import('./remote/tailscaleServices.ts');
    return webPublicationReport({ exec: realExec, stateDirectory: directory });
  },
};
export async function main(argv = process.argv.slice(2)): Promise<number> {
  try { return await runCli(argv, cliDeps); }
  catch (error) {
    console.error(error instanceof ConfigError ? `relayd: ${error.message}` : 'relayd: service could not start; check configuration and the systemd user session.');
    return 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
