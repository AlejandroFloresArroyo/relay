import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

// Test program that runs inside the terminal under test. Modes:
//   tty            print what the program sees: isatty and window size
//   screen         full-screen program: alternate screen, raw input, redraw on SIGWINCH
//   utf8out        write UTF-8 text split in the middle of code points across separate writes
//   hold <log>     stay alive, logging ticks, stdout/stdin errors and SIGHUP to <log>
//   hold-nohup     like hold, but ignore SIGHUP
const [mode, log] = process.argv.slice(2);
const { stdin, stdout } = process;

if (mode === 'tty') {
  stdout.write(`${JSON.stringify({ stdin: stdin.isTTY === true, stdout: stdout.isTTY === true, cols: stdout.columns, rows: stdout.rows })}\n`);
} else if (mode === 'screen') {
  if (!stdout.isTTY || !stdin.isTTY) {
    stdout.write('NOTTY\n');
    process.exit(2);
  }
  const draw = () => stdout.write(`\x1b[2J\x1b[${Math.ceil(stdout.rows / 2)};1HSIZE ${stdout.columns}x${stdout.rows}\r\n`);
  stdout.write('\x1b[?1049h');
  draw();
  stdout.on('resize', draw);
  stdin.setRawMode(true);
  let line: Buffer[] = [];
  let reads = 0;
  stdin.on('data', (chunk: Buffer) => {
    if (line.length === 0 && chunk.toString() === 'q') {
      stdin.setRawMode(false);
      stdout.write('\x1b[?1049lBYE\r\n');
      process.exit(0);
    }
    const end = chunk.indexOf(0x0d);
    reads += 1;
    line.push(end === -1 ? chunk : chunk.subarray(0, end));
    if (end === -1) return;
    const bytes = Buffer.concat(line);
    stdout.write(`GOT ${bytes.toString('hex')} READS ${reads} TXT ${bytes.toString('utf8')}\r\n`);
    line = [];
    reads = 0;
  });
} else if (mode === 'utf8out') {
  // ñ = c3 b1, € = e2 82 ac, 😀 = f0 9f 98 80. Every write ends inside a code point.
  const bytes = Buffer.from('ñ€😀\n');
  for (const [start, end] of [[0, 1], [1, 4], [4, 7], [7, 10]]) {
    stdout.write(bytes.subarray(start, end));
    await sleep(100);
  }
} else if (mode === 'hold' || mode === 'hold-nohup') {
  const note = (line: string) => appendFileSync(log, `${line}\n`);
  if (mode === 'hold-nohup') process.on('SIGHUP', () => note('sighup'));
  stdout.on('error', (error: NodeJS.ErrnoException) => note(`stdout-error ${error.code}`));
  stdin.on('error', (error: NodeJS.ErrnoException) => note(`stdin-error ${error.code}`));
  stdin.on('end', () => note('stdin-end'));
  stdin.resume();
  note(`start ${process.pid}`);
  for (let tick = 1; ; tick += 1) {
    stdout.write(`tick ${tick}\n`);
    note(`tick ${tick}`);
    await sleep(100);
  }
} else {
  stdout.write(`unknown mode ${mode}\n`);
  process.exit(64);
}
