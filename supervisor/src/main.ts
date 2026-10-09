// relay-supervisor: its own systemd user unit (#96 installs it), never a child of relay-bridge.service,
// whose KillMode=control-group would take every PTY with it. Exiting closes the PTY masters and the
// browsers' CDP pipes; what survives stays in its cgroup and is `lost` at the next start, never relaunched.
import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEDICATED_BROWSER_PROGRAMS } from '../../protocol/supervisor.ts';
import { RegistryError } from './registry.ts';
import { listenSupervisor } from './server.ts';
import { openSupervisor } from './supervisor.ts';
import { systemdHost } from './systemdHost.ts';

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const { values } = parseArgs({
  options: {
    runtime: { type: 'string' },
    state: { type: 'string' },
    'unit-prefix': { type: 'string', default: 'relay-env' },
    /** Installed shells a terminal may run; /etc/shells by default. */
    shells: { type: 'string' },
    /** The Chrome or Chromium of dedicated browsers; the first found on PATH by default. */
    browser: { type: 'string' },
    /** Where finished downloads stay; ~/Downloads by default. */
    downloads: { type: 'string' },
  },
});
const runtime = values.runtime ?? (process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'relay-supervisor') : null);
const state = values.state ?? path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'relay-supervisor');
if (!runtime) {
  console.error('relay-supervisor: XDG_RUNTIME_DIR is required; use a systemd user session.');
  process.exit(1);
}
if (!/^[A-Za-z0-9_-]{1,64}$/.test(values['unit-prefix'])) {
  console.error('relay-supervisor: invalid unit prefix.');
  process.exit(1);
}

/** The first dedicated browser program in PATH (docs/research/v3-cdp.md). */
function findBrowser(): string | undefined {
  for (const name of DEDICATED_BROWSER_PROGRAMS) {
    for (const directory of (process.env.PATH ?? '').split(':').filter((entry) => entry.startsWith('/'))) {
      try {
        accessSync(path.join(directory, name), constants.X_OK);
        return path.join(directory, name);
      } catch { /* not here */ }
    }
  }
  return undefined;
}

try {
  const supervisor = await openSupervisor({
    directory: state, host: await systemdHost(), unitPrefix: values['unit-prefix'], shellsFile: values.shells,
    browser: values.browser ?? findBrowser(), downloads: values.downloads,
  });
  const server = await listenSupervisor({ runtimeDirectory: runtime, supervisor });
  log('relay-supervisor listening');
  const stop = async () => {
    await server.close();
    await supervisor.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
} catch (error) {
  // Fixed texts: a file system error carries paths.
  console.error(error instanceof RegistryError ? `relay-supervisor: ${error.message}` : 'relay-supervisor: could not start.');
  process.exit(1);
}
