import { open } from './backend.ts';

// Stand-in for the process that owns the PTY master (the Puente, if it held terminals itself).
// Runs the probe in hold mode and reports its pid on stdout; the test then kills this process.
const [mode, log, cwd] = process.argv.slice(2);
const term = open(process.execPath, [new URL('probe.ts', import.meta.url).pathname, mode, log], {
  cols: 80,
  rows: 24,
  cwd,
  env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', HOME: cwd },
});
term.onData(() => {});
process.stdout.write(`PTY_PID ${term.pid}\n`);
