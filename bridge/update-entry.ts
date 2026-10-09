import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './src/main.ts';
import { startService } from './src/control.ts';
import { realExec } from './src/exec.ts';
import type { Exec } from './src/exec.ts';

type Dependencies = { env: Record<string, string | undefined>; exec: Exec; start: typeof startService };

export async function serveExistingState(directory: string, dependencies?: Dependencies): Promise<void> {
  const start = dependencies?.start ?? startService;
  await serve({
    env: dependencies?.env ?? process.env,
    exec: dependencies?.exec ?? realExec,
    start: options => start({ ...options, directory }),
  });
}

export async function startExistingState(directory: string, dependencies?: Dependencies, report: (message: string) => void = console.error): Promise<number> {
  try { await serveExistingState(directory, dependencies); return 0; }
  catch { report('relayd: service could not start; check configuration and the systemd user session.'); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Deployment metadata is public. Keep device identities and local state at the existing service path.
  process.exitCode = await startExistingState('/home/user/dev/relay-app/bridge');
}
