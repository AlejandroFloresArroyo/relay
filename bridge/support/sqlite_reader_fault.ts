import fs from 'node:fs';
import path from 'node:path';
import sqlite from 'node:sqlite';

export interface ReaderFault { home: string; outside: string; log: string; mode: 'database' | 'database_copy' | 'wal' | 'wal_copy' | 'shm' | 'shm_copy' | 'ancestor' | 'shm_open_hardlink' }
// OS boundary faults: change a source name between directory pinning and opening its fd.
// SQLite itself stays real; prepare instrumentation proves unsafe sources never reach tables.
export function installReaderFault(fault: ReaderFault) {
  const Original = sqlite.DatabaseSync, open = fs.openSync;
  let pending: (() => void) | undefined;
  const swap = () => {
    fs.appendFileSync(`${fault.log}.fault`, `${fault.mode}\n`);
    const name = fault.mode.startsWith('database') ? 'state.db' : fault.mode.startsWith('wal') ? 'state.db-wal' : 'state.db-shm';
    const target = fault.mode === 'ancestor' ? fault.home : path.join(fault.home, name);
    const outside = fault.mode === 'ancestor' ? fault.outside : path.join(fault.outside, name);
    fs.renameSync(target, `${target}.held`);
    if (fault.mode.endsWith('_copy')) fs.copyFileSync(outside, target);
    else if (fault.mode === 'shm_open_hardlink') fs.linkSync(outside, target);
    else fs.symlinkSync(outside, target);
    return () => { fs.unlinkSync(target); fs.renameSync(`${target}.held`, target); };
  };
  fs.openSync = ((file: fs.PathLike, ...args: [fs.OpenMode, fs.Mode?]) => {
    if (fault.mode === 'shm_open_hardlink' || typeof file !== 'string' || !file.startsWith('/proc/self/fd/')) return open(file, ...args);
    const parent = fs.realpathSync(path.dirname(file)), name = path.basename(file);
    const selected = fault.mode === 'ancestor' ? parent === path.dirname(fault.home) && name === path.basename(fault.home)
      : parent === fault.home && name === (fault.mode.startsWith('database') ? 'state.db' : fault.mode.startsWith('wal') ? 'state.db-wal' : 'state.db-shm');
    if (!selected) return open(file, ...args);
    const restore = swap();
    try { return open(file, ...args); } finally { restore(); }
  }) as typeof fs.openSync;
  sqlite.DatabaseSync = class extends Original {
    constructor(...args: ConstructorParameters<typeof Original>) {
      if (fault.mode === 'shm_open_hardlink') pending = swap();
      try { super(...args); } catch (error) { pending?.(); pending=undefined; throw error; }
    }
    prepare(sql: string) {
      if (/\bFROM\s+(sessions|messages)\b/i.test(sql)) fs.appendFileSync(fault.log, 'table read\n');
      return super.prepare(sql);
    }
    close() { try { return super.close(); } finally { pending?.(); pending=undefined; } }
  };
  return () => { pending?.(); fs.openSync=open; sqlite.DatabaseSync=Original; };
}
