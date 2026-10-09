import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sqlite, { type DatabaseSync } from 'node:sqlite';
import { CronFiles } from './cronFiles.ts';

const STORE_LIMIT = 64 * 1024 * 1024;
/** SQLite only opens a private copy: its WAL/SHM activity cannot modify Hermes files.
 * Copy stable pinned DB + WAL bytes together; never use immutable on a live store.
 * A concurrent write or entry replacement makes the read unavailable, not stale success.
 */
export function readCronStore<T>(home: string, read: (db: DatabaseSync) => T): T {
  const files = new CronFiles(home);
  let directory: string | undefined;
  let db: DatabaseSync | undefined;
  try {
    const main = files.open('executions.db', STORE_LIMIT)!;
    const wal = files.open('executions.db-wal', STORE_LIMIT, true);
    // Pin and reject unsafe sidecars even though SQLite never opens their original paths.
    files.open('executions.db-shm', STORE_LIMIT, true);
    const journal = files.open('executions.db-journal', STORE_LIMIT, true);
    files.verify();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cron-read-'));
    fs.chmodSync(directory, 0o700);
    const database = path.join(directory, 'executions.db');
    files.copy(main, database);
    if (wal) files.copy(wal, database + '-wal');
    if (journal) files.copy(journal, database + '-journal');
    files.verify();
    db = new sqlite.DatabaseSync(database, { readOnly: true, allowExtension: false, timeout: 100,
      enableDoubleQuotedStringLiterals: false, limits: { length: 65536, sqlLength: 65536 } });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    const result = read(db);
    files.verify();
    db.exec('COMMIT');
    return result;
  } finally {
    try { db?.close(); }
    finally { try { if (directory) fs.rmSync(directory, { recursive: true, force: true }); } finally { files.close(); } }
  }
}
