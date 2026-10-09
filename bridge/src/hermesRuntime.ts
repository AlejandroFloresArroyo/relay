import fs from 'node:fs';
import path from 'node:path';
export const resolveHermesSource = (options: { home: string; source?: string }) => options.source ?? path.join(options.home, 'hermes-agent');
/** Hermes's install.sh creates source/venv; .venv is the supported alternate layout. */
export function resolveHermesPython(options: { home: string; source?: string; python?: string }): string {
  if (options.python) return options.python;
  const source = resolveHermesSource(options);
  return path.join(source, fs.existsSync(path.join(source, 'venv', 'bin', 'python')) ? 'venv' : '.venv', 'bin', 'python');
}
