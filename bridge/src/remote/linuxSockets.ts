// AppRegistry on Linux: the account's listening TCP sockets from /proc/net/tcp{,6}, and the program
// owning each from /proc/<pid>/fd, exe, cwd and comm. Reading files only: no port is connected to,
// so no service (protected or not) is probed. Other accounts' processes are not readable and their
// sockets are left out. The command line is never read: it can carry secrets.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppRegistry, ListeningSocket } from './ports.ts';

const LISTEN = '0A';

/** /proc prints each 32-bit word of the address in host byte order. */
function address(hex: string): string {
  const bytes = Buffer.from(hex, 'hex');
  if (os.endianness() === 'LE') for (let i = 0; i < bytes.length; i += 4) bytes.subarray(i, i + 4).reverse();
  if (bytes.length === 4) return bytes.join('.');
  // IPv4-mapped: the socket takes IPv4 connections to that address.
  if (bytes.subarray(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.subarray(12).join('.');
  const groups = Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16));
  return new URL(`http://[${groups.join(':')}]/`).hostname.slice(1, -1);
}

async function table(file: string, uid: number, required: boolean): Promise<{ address: string; port: number; inode: string }[]> {
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').slice(1).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== LISTEN || Number(fields[7]) !== uid) return [];
    const [hex, port] = fields[1]!.split(':');
    return [{ address: address(hex!), port: parseInt(port!, 16), inode: fields[9]! }];
  });
}

export function createLinuxSockets(options: { proc?: string; uid?: number } = {}): AppRegistry {
  const proc = options.proc ?? '/proc';
  const uid = options.uid ?? process.getuid!();
  return {
    async availability() {
      try { await fs.access(path.join(proc, 'net', 'tcp'), fs.constants.R_OK); return { state: 'available' }; }
      catch { return { state: 'unavailable', reason: 'unsupported_platform' }; }
    },
    async listening() {
      const sockets = [...await table(path.join(proc, 'net', 'tcp'), uid, true), ...await table(path.join(proc, 'net', 'tcp6'), uid, false)];
      const wanted = new Set(sockets.map((socket) => `socket:[${socket.inode}]`));
      const owners = new Map<string, number>();
      for (const entry of await fs.readdir(proc)) {
        if (!/^\d+$/.test(entry)) continue;
        const fds = await fs.readdir(path.join(proc, entry, 'fd')).catch(() => [] as string[]);
        for (const fd of fds) {
          const link = await fs.readlink(path.join(proc, entry, 'fd', fd)).catch(() => '');
          if (wanted.has(link) && !owners.has(link)) owners.set(link, Number(entry));
        }
      }
      const programs = new Map<number, ListeningSocket['process']>();
      for (const pid of new Set(owners.values())) {
        const dir = path.join(proc, String(pid));
        programs.set(pid, await Promise.all([fs.readFile(path.join(dir, 'comm'), 'utf8'), fs.readlink(path.join(dir, 'exe')), fs.readlink(path.join(dir, 'cwd'))])
          .then(([comm, exe, cwd]) => ({ name: comm.trim(), exe, cwd }), () => null));
      }
      return sockets.map(({ address: bound, port, inode }) => {
        const pid = owners.get(`socket:[${inode}]`) ?? null;
        return { address: bound, port, pid, process: pid === null ? null : programs.get(pid)! };
      });
    },
  };
}
