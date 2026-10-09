// Extracted from hermes_conversations: the sole Hermes sessions/messages SQL boundary.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import sqlite, { type DatabaseSync, type SQLOutputValue, type SQLInputValue, type StatementSync } from 'node:sqlite';

type Row = Record<string, SQLOutputValue>;
type Projection = 'conversations' | 'conversation_revision' | 'agent_usage' | 'server_usage';
interface Request { home: string; projection: Projection; first?: number; end?: number; purpose?: 'index' | 'transcript' | 'decisions'; sessionIds?: string[] }
export interface ConversationRows { sessions: Row[]; messages: Row[] }
export interface UsageSession {
  startedAt: SQLOutputValue; inputTokens: SQLOutputValue; outputTokens: SQLOutputValue;
  cacheReadTokens: SQLOutputValue; estimatedCostUsd: SQLOutputValue; costStatus: SQLOutputValue; model: SQLOutputValue;
}
interface Pin { fd: number; stat: fs.BigIntStats; file: string }
const STORE_LIMIT = 64 * 1024 * 1024;
function same(a: fs.BigIntStats, b: fs.BigIntStats) { return a.dev === b.dev && a.ino === b.ino; }
function unavailable(): never { throw new Error('Hermes store unavailable.'); }

// SQLite never opens an original profile path: even readonly WAL can initialize SHM.
// Copy through held no-follow descriptors and reject changes across the copy interval.
function openStore(request: Request, read: (db: DatabaseSync) => unknown): unknown {
  const pins: Pin[] = [];
  let db: DatabaseSync | undefined, privateHome: string | undefined;
  let mainPinned = false;
  const stat = (fd: number) => fs.fstatSync(fd, { bigint: true });
  const version = (a: fs.BigIntStats, b: fs.BigIntStats) => same(a, b) && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode && a.nlink === b.nlink;
  try {
    if (process.platform !== 'linux' || !path.isAbsolute(request.home) || path.resolve(request.home) !== request.home) unavailable();
    const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
    const fileFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    let directory = fs.openSync('/', directoryFlags);
    pins.push({ fd: directory, stat: stat(directory), file: '/' });
    let current = '';
    for (const component of request.home.split('/').filter(Boolean)) {
      current += `/${component}`;
      directory = fs.openSync(`/proc/self/fd/${directory}/${component}`, directoryFlags);
      pins.push({ fd: directory, stat: stat(directory), file: current });
    }
    const files = new Map<string, Pin>();
    const limit = request.projection === 'agent_usage' ? 512 * 1024 * 1024 : STORE_LIMIT;
    for (const name of ['state.db', 'state.db-wal', 'state.db-shm', 'state.db-journal']) {
      let fd: number;
      try { fd = fs.openSync(`/proc/self/fd/${directory}/${name}`, fileFlags); }
      catch (error) {
        if (name !== 'state.db' && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const pin = { fd, stat: stat(fd), file: path.join(request.home, name) };
      pins.push(pin); mainPinned = true;
      if (!pin.stat.isFile() || pin.stat.size > BigInt(name === 'state.db' ? limit : STORE_LIMIT) || pin.stat.nlink !== 1n) unavailable();
      files.set(name, pin);
    }
    const verify = () => {
      for (const pin of pins) {
        const fd = fs.openSync(pin.file, pin.stat.isDirectory() ? directoryFlags : fileFlags);
        try {
          const entry = stat(fd), held = stat(pin.fd);
          if (!same(entry, pin.stat) || !same(held, pin.stat)) unavailable();
          if (!pin.stat.isDirectory() && (!version(entry, pin.stat) || !version(held, pin.stat))) unavailable();
        } finally { fs.closeSync(fd); }
      }
      // Absence is checked on both sides; a new WAL/journal cannot be silently omitted.
      for (const name of ['state.db-wal', 'state.db-shm', 'state.db-journal']) {
        if (files.has(name)) continue;
        try { const fd = fs.openSync(`/proc/self/fd/${directory}/${name}`, fileFlags); fs.closeSync(fd); unavailable(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    };
    verify();
    privateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hermes-read-'));
    fs.chmodSync(privateHome, 0o700);
    const buffer = Buffer.alloc(64 * 1024);
    for (const [name, pin] of files) {
      // SHM is an ephemeral index, never trusted as a portable snapshot. SQLite rebuilds
      // its own private SHM from the copied committed WAL using its normal WAL protocol.
      if (name === 'state.db-shm') continue;
      const fd = fs.openSync(path.join(privateHome, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        for (let position = 0; position < Number(pin.stat.size);) {
          const length = fs.readSync(pin.fd, buffer, 0, Math.min(buffer.length, Number(pin.stat.size) - position), position);
          if (length === 0) unavailable();
          for (let written = 0; written < length;) {
            const count = fs.writeSync(fd, buffer, written, length - written, position + written);
            if (count === 0) unavailable(); written += count;
          }
          position += length;
        }
      } finally { fs.closeSync(fd); }
    }
    verify();
    const uri = pathToFileURL(path.join(privateHome, 'state.db')); uri.searchParams.set('mode', 'ro');
    db = new sqlite.DatabaseSync(uri.href, { readOnly: true, enableDoubleQuotedStringLiterals: false, timeout: 100, limits: { length: 1024 * 1024, sqlLength: 65536 } });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN');
    const result = read(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    // Disappearance after pinning is a failed snapshot, never an empty/missing store.
    if (mainPinned) unavailable();
    throw error;
  } finally {
    try { db?.close(); } finally {
      try { if (privateHome) fs.rmSync(privateHome, { recursive: true, force: true }); }
      finally { for (const pin of pins.reverse()) fs.closeSync(pin.fd); }
    }
  }
}
function table(db: DatabaseSync, name: 'sessions' | 'messages') {
  const row = db.prepare('SELECT type, sql FROM sqlite_schema WHERE name=?').get(name);
  if (row?.type !== 'table' || typeof row.sql !== 'string' || !/^CREATE\s+TABLE\b/i.test(row.sql)) unavailable();
}
function bounded(statement: StatementSync, parameters: SQLInputValue[], maximum: number, budget: { remaining: number }): Row[] {
  const rows: Row[] = [];
  for (const row of statement.iterate(...parameters)) {
    if (rows.length >= maximum) unavailable();
    budget.remaining -= 64 + Object.values(row).reduce((size: number, value) => size +
      (typeof value === 'string' ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : 8), 0);
    if (budget.remaining < 0) unavailable();
    rows.push(row);
  }
  return rows;
}
function projection(db: DatabaseSync, request: Request): ConversationRows | UsageSession[] {
  const budget = { remaining: 12 * 1024 * 1024 };
  table(db, 'sessions');
  if (request.projection === 'conversations' || request.projection === 'conversation_revision') {
    table(db, 'messages');
    db.prepare('SELECT id, source, parent_session_id, started_at, last_activity_at, ended_at, end_reason, model_config, title, archived, hidden FROM sessions LIMIT 0').all();
    db.prepare('SELECT id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, active, compacted, _compressed_summary, display_metadata, display_identity FROM messages LIMIT 0').all();
    // Display/history never materialize unrelated context, reasoning or API payloads.
    // Deletion revisions retain every column so a private-field change invalidates confirmation.
    const sessions = request.projection === 'conversation_revision' ? '*' :
      'id, source, session_key, parent_session_id, started_at, last_activity_at, ended_at, end_reason, model_config, title, archived, hidden';
    const messageColumns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(row => row.name));
    db.function('relay_content_identity', { deterministic: true }, value => typeof value === 'string' ? createHash('sha256').update(value).digest('hex') : null);
    const content = request.purpose === 'index' ? "CASE WHEN role IN ('user','assistant') THEN content ELSE NULL END" : request.purpose === 'decisions' ? `
      CASE WHEN role='tool' AND json_valid(content) AND json_type(content)='object' THEN
        json_object('exit_code',CASE WHEN json_type(content,'$.exit_code') IN ('integer','real') THEN json_extract(content,'$.exit_code') ELSE NULL END,
          'output',CASE WHEN json_type(content,'$.output')='text' THEN '' ELSE NULL END,
          'status',json_extract(content,'$.status'),'approval',json_extract(content,'$.approval'))
        ELSE NULL END` : 'content';
    const messages = request.projection === 'conversation_revision' ? '*' :
      `id, session_id, role, ${content} AS content, relay_content_identity(content) AS content_identity, tool_call_id, tool_calls, tool_name, timestamp, active, compacted, _compressed_summary, display_kind, display_metadata, display_identity, ` +
      (messageColumns.has('message_uid') ? 'message_uid' : 'NULL AS message_uid');
    const filter = request.sessionIds ? ` WHERE session_id IN (${request.sessionIds.map(() => '?').join(',')})` :
      request.purpose === 'decisions' ? " WHERE (role='assistant' AND tool_calls IS NOT NULL) OR (role='tool' AND tool_name='terminal' AND tool_call_id IS NOT NULL)" : '';
    return { sessions: bounded(db.prepare(`SELECT ${sessions} FROM sessions ORDER BY id LIMIT 50001`), [], 50000, budget),
      messages: bounded(db.prepare(`SELECT ${messages} FROM messages${filter} ORDER BY timestamp, id LIMIT 200001`), request.sessionIds ?? [], 200000, budget) };
  }
  const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map(row => row.name));
  if (!columns.has('started_at')) unavailable();
  const names = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'estimated_cost_usd', 'cost_status', 'model'];
  if (request.projection === 'agent_usage' && ['input_tokens', 'output_tokens', 'estimated_cost_usd'].some(name => !columns.has(name))) unavailable();
  const selection = names.map(name => columns.has(name) ? name : `NULL AS ${name}`).join(',');
  const filter = request.projection === 'agent_usage' ? ' WHERE started_at >= ? AND started_at <= ?' : '';
  const statement = db.prepare(`SELECT started_at,${selection} FROM sessions${filter} LIMIT 50001`);
  const rows = bounded(statement, request.projection === 'agent_usage' ? [request.first!, request.end!] : [], 50000, budget);
  return rows.map(row => ({ startedAt: row.started_at, inputTokens: row.input_tokens, outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens, estimatedCostUsd: row.estimated_cost_usd, costStatus: row.cost_status, model: row.model }));
}
export function readConversationRows(home: string, purpose: 'index' | 'transcript' | 'decisions' = 'index', sessionIds?: string[]): ConversationRows {
  const request: Request = { home, projection: 'conversations', purpose, sessionIds };
  return openStore(request, db => projection(db, request)) as ConversationRows;
}
export function readUsageSessions(home: string, window?: { first: number; end: number }): UsageSession[] {
  const request: Request = { home, projection: window ? 'agent_usage' : 'server_usage', ...window };
  return openStore(request, db => projection(db, request)) as UsageSession[];
}

export function readDeletionRows(home: string): ConversationRows {
  return openStore({ home, projection: 'conversation_revision' }, db => projection(db, { home, projection: 'conversation_revision' })) as ConversationRows;
}
