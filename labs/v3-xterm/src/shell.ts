// Synthetic shell behind the lab terminal. It stands in for a PTY: echo, a line discipline,
// a few commands that exercise the terminal, and a flood that respects backpressure.

export type Size = { cols: number; rows: number };

const PROMPT = '$ ';

export function fnv1a(hash: number, text: string): number {
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// Output waiting for the terminal. Producers that can wait (the flood) stop at `highWater`;
// echo and short replies always go in, so the bound is highWater plus one producer step.
export class OutputQueue {
  private chunks: string[] = [];
  size = 0;
  max = 0;
  // Everything ever queued, so the terminal side can prove it received all of it.
  total = 0;
  hash = 0x811c9dc5;

  readonly highWater: number;

  constructor(highWater: number) {
    this.highWater = highWater;
  }

  push(text: string) {
    if (!text) return;
    this.chunks.push(text);
    this.size += text.length;
    this.total += text.length;
    this.hash = fnv1a(this.hash, text);
    if (this.size > this.max) this.max = this.size;
  }

  take(limit: number): string {
    let out = '';
    while (this.chunks.length && out.length < limit) {
      const head = this.chunks[0];
      const room = limit - out.length;
      if (head.length <= room) {
        out += head;
        this.chunks.shift();
      } else {
        out += head.slice(0, room);
        this.chunks[0] = head.slice(room);
      }
    }
    this.size -= out.length;
    return out;
  }
}

type Flood = { next: number; total: number; bytes: number; hash: number };

export class FakeShell {
  line = '';
  interrupts = 0;
  onLine: (line: string) => void = () => {};
  private flood: Flood | null = null;
  private alternate = false;

  private queue: OutputQueue;
  private size: Size;

  constructor(queue: OutputQueue, size: Size) {
    this.queue = queue;
    this.size = size;
    queue.push(PROMPT);
  }

  input(data: string) {
    for (const ch of data) {
      if (ch === '\r') {
        const line = this.line;
        this.line = '';
        this.queue.push('\r\n');
        this.onLine(line);
        this.run(line.trim());
      } else if (ch === '\x7f') {
        if (!this.line) continue;
        this.line = [...this.line].slice(0, -1).join('');
        this.queue.push('\b \b');
      } else if (ch === '\x03') {
        this.interrupts++;
        this.flood = null;
        this.line = '';
        this.queue.push('^C\r\n' + PROMPT);
      } else if (ch < ' ') {
        this.queue.push('^' + String.fromCharCode(ch.charCodeAt(0) + 64));
      } else {
        this.line += ch;
        this.queue.push(ch);
      }
    }
  }

  resize(size: Size) {
    this.size = size;
    if (this.alternate) this.queue.push(this.screen());
  }

  // Produces flood output until the queue is full; call again after the terminal drains it.
  pump() {
    const flood = this.flood;
    if (!flood) return;
    while (this.queue.size < this.queue.highWater && flood.next < flood.total) {
      const line = `${String(flood.next).padStart(6, '0')} ${'x'.repeat(64)}\r\n`;
      flood.hash = fnv1a(flood.hash, line);
      flood.bytes += line.length;
      flood.next++;
      this.queue.push(line);
    }
    if (flood.next < flood.total) return;
    this.flood = null;
    this.queue.push(
      `END lines=${flood.total} bytes=${flood.bytes} hash=${flood.hash.toString(16)}\r\n${PROMPT}`,
    );
  }

  private run(command: string) {
    const [name, arg] = command.split(/\s+/);
    switch (name) {
      case 'flood':
        this.flood = { next: 0, total: Number(arg) || 1000, bytes: 0, hash: 0x811c9dc5 };
        return;
      case 'size':
        this.queue.push(`SIZE cols=${this.size.cols} rows=${this.size.rows}\r\n`);
        break;
      case 'alt':
        this.alternate = true;
        this.queue.push('\x1b[?1049h' + this.screen());
        return;
      case 'noalt':
        this.alternate = false;
        this.queue.push('\x1b[?1049l');
        break;
      case 'bpon':
        this.queue.push('\x1b[?2004h');
        break;
      case 'bpoff':
        this.queue.push('\x1b[?2004l');
        break;
      case '':
        break;
      default:
        this.queue.push(`${name}: orden desconocida\r\n`);
    }
    this.queue.push(PROMPT);
  }

  // A full-screen program: a box on every row, redrawn on resize like a SIGWINCH handler.
  private screen() {
    const { cols, rows } = this.size;
    const label = `ALT cols=${cols} rows=${rows}`;
    let out = '\x1b[H\x1b[2J';
    for (let row = 1; row <= rows; row++) {
      out += `\x1b[${row};1H`;
      if (row === 1) out += '┌' + '─'.repeat(cols - 2) + '┐';
      else if (row === rows) out += '└' + '─'.repeat(cols - 2) + '┘';
      else if (row === 2) out += '│' + label.padEnd(cols - 2).slice(0, cols - 2) + '│';
      else out += '│' + ' '.repeat(cols - 2) + '│';
    }
    return out;
  }
}
