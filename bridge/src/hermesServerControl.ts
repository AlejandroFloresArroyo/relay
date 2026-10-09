import fs from 'node:fs/promises';
import path from 'node:path';
import type { HermesServerControl } from '../../protocol/serverControl.ts';
import type { Exec } from './exec.ts';
import { HermesError } from './hermes.ts';

export function createHermesServerControl(options: { home: string; bin: string; exec: Exec }): HermesServerControl {
  // The host/default root is explicit, independent of Hermes's sticky active profile.
  const sentinel = path.join(options.home, 'ESTOP');
  const paused = async () => {
    try { await fs.lstat(sentinel); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new HermesError('unavailable', 'No se pudo leer el estado de Pausa general. Reintenta.'); }
  };
  const change = async (action: 'pause' | 'resume') => {
    try {
      const result = await options.exec(options.bin, ['-p', 'default', action], { timeoutMs: 30_000, env: { NO_COLOR: '1', HERMES_HOME: options.home } });
      // Hermes deliberately swallows filesystem errors and may still exit zero.
      if (result.code !== 0 || await paused() !== (action === 'pause')) throw new Error();
    } catch { throw new HermesError('upstream', 'Hermes no confirmó el cambio de Pausa general.'); }
  };
  return { paused, pause: () => change('pause'), resume: () => change('resume') };
}
