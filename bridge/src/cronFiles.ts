import fs from 'node:fs';
import path from 'node:path';

interface Pin { fd: number; parent: number | null; name: string; stat: fs.BigIntStats; limit?: number }
const DIRECTORY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const FILE_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
function unavailable(): never { throw new Error('Cron files unavailable.'); }
function same(a: fs.BigIntStats, b: fs.BigIntStats) { return a.dev === b.dev && a.ino === b.ino; }
function unchanged(a: fs.BigIntStats, b: fs.BigIntStats) {
  return same(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
/** Linux openat via pinned /proc fds: each ancestor and final entry rejects links. */
export class CronFiles {
  private pins: Pin[] = [];
  private directory = -1;
  private missingCron = false;
  private missing = new Set<string>();
  constructor(home: string) {
    try {
      if (process.platform !== 'linux' || !path.isAbsolute(home) || path.resolve(home) !== home) unavailable();
      let fd = fs.openSync('/', DIRECTORY_FLAGS);
      this.pins.push({ fd, parent: null, name: '/', stat: fs.fstatSync(fd, { bigint: true }) });
      const components = [...home.split('/').filter(Boolean), 'cron'];
      for (let i = 0; i < components.length; i++) {
        const parent = fd, name = components[i];
        try { fd = fs.openSync(`/proc/self/fd/${parent}/${name}`, DIRECTORY_FLAGS); }
        catch (error) {
          if (i === components.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            this.directory = parent; this.missingCron = true; this.verify(); return;
          }
          unavailable();
        }
        this.pins.push({ fd, parent, name, stat: fs.fstatSync(fd, { bigint: true }) });
      }
      this.directory = fd;
    } catch { this.close(); unavailable(); }
  }
  open(name: string, limit: number, optional = false): Pin | null {
    if (!/^[a-z.\-]+$/.test(name)) unavailable();
    if (this.missingCron) { this.verify(); if (optional) return null; unavailable(); }
    let fd: number;
    try { fd = fs.openSync(`/proc/self/fd/${this.directory}/${name}`, FILE_FLAGS); }
    catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') { this.missing.add(name); this.verify(); return null; }
      unavailable();
    }
    const pin = { fd, parent: this.directory, name, stat: fs.fstatSync(fd, { bigint: true }), limit };
    this.pins.push(pin);
    if (!pin.stat.isFile() || pin.stat.nlink !== 1n || pin.stat.size > BigInt(limit)) unavailable();
    return pin;
  }
  private consume(pin: Pin, accept: (chunk: Buffer) => void) {
    const maximum = pin.limit!; let total = 0;
    const chunk = Buffer.allocUnsafe(Math.min(65536, maximum + 1));
    while (total <= maximum) {
      const count = fs.readSync(pin.fd, chunk, 0, Math.min(chunk.length, maximum + 1 - total), total);
      if (!count) break;
      total += count;
      if (total > maximum) unavailable();
      accept(chunk.subarray(0, count));
    }
    if (!unchanged(pin.stat, fs.fstatSync(pin.fd, { bigint: true }))) unavailable();
  }
  read(pin: Pin): Buffer {
    const chunks: Buffer[] = [];
    this.consume(pin, chunk => chunks.push(Buffer.from(chunk)));
    return Buffer.concat(chunks);
  }
  copy(pin: Pin, destination: string) {
    const fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      this.consume(pin, chunk => {
        let offset = 0;
        while (offset < chunk.length) {
          const written = fs.writeSync(fd, chunk, offset, chunk.length - offset);
          if (!written) unavailable();
          offset += written;
        }
      });
    } finally { fs.closeSync(fd); }
  }
  verify() {
    for (const pin of this.pins) {
      const flags = pin.stat.isDirectory() ? DIRECTORY_FLAGS : FILE_FLAGS;
      const fd = fs.openSync(pin.parent === null ? '/' : `/proc/self/fd/${pin.parent}/${pin.name}`, flags);
      try {
        const stat = fs.fstatSync(fd, { bigint: true });
        if (!same(pin.stat, stat) || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n || !unchanged(pin.stat, stat)))) unavailable();
      } finally { fs.closeSync(fd); }
    }
    for (const name of this.missing) {
      try { const fd = fs.openSync(`/proc/self/fd/${this.directory}/${name}`, FILE_FLAGS); fs.closeSync(fd); unavailable(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (this.missingCron) {
      try { const fd = fs.openSync(`/proc/self/fd/${this.directory}/cron`, DIRECTORY_FLAGS); fs.closeSync(fd); unavailable(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  close() { for (const pin of this.pins.reverse()) fs.closeSync(pin.fd); this.pins = []; }
}
