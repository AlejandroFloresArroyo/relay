import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DecisionRecord } from '../../protocol/protocol.ts';
import { checkStateDirectory, exactObject, isTimestamp, openPrivateFile, syncStateDirectory } from './changeLog.ts';
import type { StateIO } from './changeLog.ts';
import { HermesError } from './hermes.ts';

export interface DecisionStore { list(): DecisionRecord[]; pending(): DecisionRecord[]; discard(id: string): Promise<void>; append(record: DecisionRecord): Promise<void>; prepare(record: DecisionRecord): Promise<void>; ready(): Promise<void>; }
/** Adapt asynchronous private recovery to the synchronous HTTP app factory. */
export function deferredDecisionStore(initialization: Promise<DecisionStore>): DecisionStore {
 let recovered: DecisionStore | null = null;
 void initialization.then(store => { recovered = store; }, () => {});
 return { list: () => { if (!recovered) throw unavailable(); return recovered.list(); },
  pending: () => { if (!recovered) throw unavailable(); return recovered.pending(); },
  discard: async id => (await initialization).discard(id), append: async record => (await initialization).append(record),
  prepare: async record => (await initialization).prepare(record), ready: async () => { await (await initialization).ready(); } };
}
export const DECISION_STORE_MAX_BYTES = 16 * 1024 * 1024;
const full = () => new HermesError('decision_store_full','El registro de Decisiones está lleno; no se borró el historial.');
const unavailable = () => new HermesError('decision_store_unavailable', 'El registro de Decisiones de Relay no está disponible.');
function validate(record: unknown): asserts record is DecisionRecord {
 if (!exactObject(record, ['id','agentId','agentName','sessionId','runId','approvalId','toolCallId','command','actor','outcome','choice','at','timeKind','origin','source','originLabel'])
  || !['id','agentId','agentName','sessionId','command','source','originLabel'].every(key => typeof record[key] === 'string' && (record[key] as string).length > 0 && (record[key] as string).length <= 65536)
  || !['runId','approvalId','toolCallId'].every(key => record[key] === null || typeof record[key] === 'string' && (record[key] as string).length > 0)
  || !['person','guardian','unknown','expired'].includes(String(record.actor)) || !['approved','rejected','expired','executed'].includes(String(record.outcome))
  || (record.actor === 'unknown') !== (record.outcome === 'executed') || (record.actor === 'expired') !== (record.outcome === 'expired') || record.actor === 'guardian' && record.outcome !== 'approved'
  || !['decision','result'].includes(String(record.timeKind)) || !['relay','other'].includes(String(record.origin)) || !isTimestamp(record.at)
  || !(record.choice === null || ['once','session','always','deny'].includes(String(record.choice)))) throw unavailable();
}
export function memoryDecisionStore(): DecisionStore {
 const records = new Map<string,DecisionRecord>(); const intents = new Map<string,DecisionRecord>();
 return { list: () => structuredClone([...records.values()]), pending: () => structuredClone([...intents.values()]), discard: async (id) => { intents.delete(id); }, ready: async () => {}, async prepare(record) {
  validate(record); if (intents.has(record.id)) throw new HermesError('decision_uncertain','La Decisión anterior quedó sin confirmar.'); intents.set(record.id,structuredClone(record));
 }, async append(record) {
  validate(record); const previous = records.get(record.id);
  if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw unavailable();
  records.set(record.id,structuredClone(record)); intents.delete(record.id);
 } };
}
/** Private, atomically replaced ledger. No commands or state contents appear in failures. */
export async function createDecisionStore(options: { directory: string; io?: StateIO }): Promise<DecisionStore> {
 const directory = path.resolve(options.directory); const file = path.join(directory,'decisions.json'); const io = options.io ?? fs;
 let records: DecisionRecord[] = []; let intents: DecisionRecord[] = []; let fatal = false; let queue: Promise<void> = Promise.resolve();
 async function commit(next: DecisionRecord[]) {
  const encoded = JSON.stringify({schemaVersion:1,decisions:next,intents})+'\n';
  if (Buffer.byteLength(encoded,'utf8') > DECISION_STORE_MAX_BYTES) throw full();
  const temporary = path.join(directory,`.decisions.${randomBytes(16).toString('hex')}.tmp`); let renamed = false;
  try {
   await checkStateDirectory(directory,io);
   const existing = await openPrivateFile(file,constants.O_RDONLY,false,io).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
   await existing?.handle.close();
   const handle = await io.open(temporary, constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try { await handle.writeFile(encoded,'utf8'); await handle.sync(); } finally { await handle.close(); }
   renamed = true; await io.rename(temporary,file); await syncStateDirectory(directory,io);
  } catch { if (renamed) fatal = true; throw unavailable(); } finally { await io.unlink(temporary).catch(() => {}); }
 }
 try {
  await checkStateDirectory(directory,io);
  const opened = await openPrivateFile(file,constants.O_RDONLY,false,io).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
  if (opened) {
   try {
    if ((await opened.handle.stat()).size > DECISION_STORE_MAX_BYTES) throw full();
    const chunks: Buffer[] = []; let total = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(65536,DECISION_STORE_MAX_BYTES+1-total));
      const {bytesRead} = await opened.handle.read(buffer,0,buffer.length,total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > DECISION_STORE_MAX_BYTES) throw full();
      chunks.push(buffer.subarray(0,bytesRead));
    }
    const value: unknown = JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks,total)));
    if (!exactObject(value,['schemaVersion','decisions','intents']) || value.schemaVersion !== 1 || !Array.isArray(value.decisions)) throw unavailable();
    value.decisions.forEach(validate); records = value.decisions;
    if (!Array.isArray(value.intents)) throw unavailable(); value.intents.forEach(validate); intents = value.intents;
    if (new Set(records.map(record => record.id)).size !== records.length || new Set(intents.map(record => record.id)).size !== intents.length || intents.some(intent => records.some(record => record.id === intent.id))) throw unavailable();
   } finally { await opened.handle.close(); }
  } else await commit(records);
 } catch (error) { if (error instanceof HermesError && error.code === 'decision_store_full') throw error; throw unavailable(); }
 return { list() { if (fatal) throw unavailable(); return structuredClone(records); }, pending() { if (fatal) throw unavailable(); return structuredClone(intents); }, discard(id) {
  const operation = queue.then(async () => { if (fatal) throw unavailable(); const previousIntents = intents; intents = intents.filter(record => record.id !== id);
    try { await commit(records); } catch(error) { intents = previousIntents; throw error; }
  }); queue = operation.then(() => {}, () => {}); return operation;
 }, async ready() { await queue; if (fatal) throw unavailable(); }, prepare(record) {
  const operation = queue.then(async () => { if (fatal) throw unavailable(); validate(record);
   if (intents.some(candidate => candidate.id === record.id)) throw new HermesError('decision_uncertain','La Decisión anterior quedó sin confirmar. No se enviará otra vez.');
   intents = [...intents,structuredClone(record)];
   try { await commit(records); } catch (error) { intents = intents.filter(candidate => candidate.id !== record.id); throw error; }
  }); queue = operation.then(() => {}, () => {}); return operation;
 }, append(record) {
  const operation = queue.then(async () => {
   if (fatal) throw unavailable(); validate(record);
   const previous = records.find(candidate => candidate.id === record.id);
   if (previous) { if (JSON.stringify(previous) !== JSON.stringify(record)) throw unavailable(); return; }
   const next = [...records,structuredClone(record)]; const previousIntents = intents; intents = intents.filter(candidate => candidate.id !== record.id);
   try { await commit(next); records = next; } catch (error) { intents = previousIntents; fatal = true; throw error; }
  }); queue = operation.then(() => {}, () => {}); return operation;
 } };
}
