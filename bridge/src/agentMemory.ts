import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_MEMORY_ERROR_STATUS, AGENT_MEMORY_MESSAGES, AGENT_MEMORY_MAX_BYTES } from '../../protocol/agentMemory.ts';
import type { AgentMemory, AgentSoul, MemoryBucket, MemoryBucketSnapshot, MemoryChange, SoulChange, AgentMemoryErrorCode } from '../../protocol/agentMemory.ts';
import { execExchange } from './exec.ts';
import { commitMemoryFile, MemoryFileError, type PreparedSnapshot } from './memoryFileCommit.ts';
import { resolveHermesPython } from './hermesRuntime.ts';
import { changeMemoryNote, memoryCharacters, memoryNotes } from './memoryNotes.ts';
import { exactObject, makeChangeRecord, openPrivateFile, syncStateDirectory } from './changeLog.ts';
import type { ChangeLog, ChangeInput } from './changeLog.ts';

export class AgentMemoryError extends Error {
  code: AgentMemoryErrorCode;
  constructor(code: AgentMemoryErrorCode) { super(AGENT_MEMORY_MESSAGES[code]); this.code = code; }
}
export interface MemoryWriteContext {
  directory: string; signal: AbortSignal; changeLog: ChangeLog; actor: ChangeInput['actor']; guard: () => void;
}
export interface HermesMemory {
  readMemory(profile: string): Promise<AgentMemory>;
  changeMemory(profile: string, request: unknown, context: MemoryWriteContext): Promise<AgentMemory>;
  readSoul(profile: string): Promise<AgentSoul>;
  changeSoul(profile: string, request: unknown, context: MemoryWriteContext): Promise<AgentSoul>;
}
interface Snapshot extends PreparedSnapshot {
  bytes: string; exists: boolean; revision: string;
  limits: { memory: number | null; user: number | null; context: number | null; writable: boolean };
}
interface Options { home: string; source?: string; python?: string; managedFile?: string; env?: Record<string,string|undefined>; now?: () => number }
const revision = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const validText = (v: unknown): v is string => typeof v === 'string' && Buffer.byteLength(v) <= AGENT_MEMORY_MAX_BYTES && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v);
const rawText = (s: Snapshot) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(s.bytes,'base64'));
const reason = 'No se puede verificar la configuración efectiva del Agente.';

export function createAgentMemory(options: Options): HermesMemory {
  const secret = randomBytes(32);
  const noteId = (profile: string, bucket: string, rev: string, index: number) => createHmac('sha256',secret).update(JSON.stringify([profile,bucket,rev,index])).digest('hex');
  const now = options.now ?? Date.now;
  async function exchange(profile: string, bucket: MemoryBucket | 'soul', expected?: string,
    retain?: (snapshot: Snapshot) => Promise<unknown>, context?: MemoryWriteContext): Promise<Snapshot> {
    const env = options.env ?? process.env;
    let commitAttempted = false;
    try {
      if (retain && !context?.signal) throw new AgentMemoryError('agent_memory_unavailable');
      let retained: Snapshot | undefined, replacement: Buffer | undefined;
      const response: any = await execExchange(resolveHermesPython(options), ['-I',fileURLToPath(new URL('./agent_memory.py',import.meta.url))], {
        home:path.resolve(options.home), profile, bucket, write:!!retain, revision:expected,
        external:!!(env.HERMES_IGNORE_USER_CONFIG === '1' || env.HERMES_MANAGED || env.HERMES_MANAGED_DIR || env.HERMES_CONFIG || env.HERMES_CONFIG_PATH || env.HERMES_ENV || env.HERMES_ENV_PATH || env.HERMES_MEMORY_DIR),
        managedFile:options.managedFile ?? '/etc/hermes',
      }, async message => {
        if (!retain) throw new AgentMemoryError('agent_memory_unavailable');
        retained=message as Snapshot;
        const reply=await retain(retained) as { bytes: string };
        replacement=Buffer.from(reply.bytes,'base64');
        return reply;
      }, { signal:context?.signal, commitPrepared:context ? (prepared,pid) => {
        if (!retained || !replacement) throw new AgentMemoryError('agent_memory_unavailable');
        return commitMemoryFile({home:options.home,managedFile:options.managedFile ?? '/etc/hermes',profile,bucket,previous:retained,replacement,prepared,pid,guard:context.guard,onCommitAttempt:()=>{commitAttempted=true;}});
      } : undefined });
      if (response?.error && Object.hasOwn(AGENT_MEMORY_ERROR_STATUS,response.error)) throw new AgentMemoryError(response.error);
      if (!response?.snapshot || !revision(response.snapshot.revision)) throw new AgentMemoryError('agent_memory_unavailable');
      return response.snapshot;
    } catch (error) {
      // A native response or cleanup failure cannot undo an attempted synchronous replacement.
      if (commitAttempted) throw new AgentMemoryError('agent_memory_uncertain');
      if (error instanceof MemoryFileError) throw new AgentMemoryError(error.code);
      if (error instanceof AgentMemoryError || error instanceof Error && error.name === 'AuthorizationError') throw error;
      throw new AgentMemoryError(retain ? 'agent_memory_uncertain' : 'agent_memory_unavailable');
    }
  }
  function bucketView(profile: string, bucket: MemoryBucket, snapshot: Snapshot): MemoryBucketSnapshot {
    const text=rawText(snapshot);
    return { exists:snapshot.exists, revision:snapshot.revision,
      notes:memoryNotes(text).map(n=>({id:noteId(profile,bucket,snapshot.revision,n.index),text:n.text})),
      characters:memoryCharacters(text), limit:snapshot.limits[bucket], writable:snapshot.exists && snapshot.limits.writable,
      reason:!snapshot.exists?'El archivo todavía no existe. Relay no añade notas.':snapshot.limits.writable?null:reason };
  }
  async function retain(profile: string, bucket: MemoryBucket | 'soul', snapshot: Snapshot, action: string, context: MemoryWriteContext) {
    context.guard();
    const record = makeChangeRecord({ actor:context.actor, action, target:{kind:'agent',id:profile}, details:{file:bucket,previous:snapshot.exists} }, now(), randomUUID);
    // An absent SOUL has no previous bytes to retain; the requested audit still precedes creation.
    if (snapshot.exists) {
      const file=path.join(context.directory,`memory-${record.id}.previous`);
      const {handle,created}=await openPrivateFile(file,constants.O_WRONLY|constants.O_EXCL,true);
      try {
        if(!created || (await handle.stat()).nlink!==1) throw new Error();
        await handle.writeFile(Buffer.from(snapshot.bytes,'base64')); await handle.sync();
      } finally { await handle.close(); }
      await syncStateDirectory(context.directory);
    }
    context.guard();
    await context.changeLog.appendCommitted(record);
    context.guard();
  }
  async function recordSuccess(profile: string, action: string, context: MemoryWriteContext) {
    try {
      context.guard();
      await context.changeLog.appendChange({ actor:context.actor, action, target:{kind:'agent',id:profile} });
      context.guard();
    } catch { throw new AgentMemoryError('agent_memory_uncertain'); }
  }
  const api: HermesMemory = {
    async readMemory(profile) {
      const memory=await exchange(profile,'memory'), user=await exchange(profile,'user');
      return {agentId:profile,capturedAt:now(),buckets:{memory:bucketView(profile,'memory',memory),user:bucketView(profile,'user',user)}};
    },
    async changeMemory(profile, value, context) {
      if(!exactObject(value,['bucket','revision','noteId','content']) || !['memory','user'].includes(String(value.bucket))
        || !revision(value.revision) || !revision(value.noteId) || value.content!==null&&!validText(value.content)) throw new AgentMemoryError('agent_memory_invalid');
      const request=value as unknown as MemoryChange;
      await exchange(profile,request.bucket,request.revision,async snapshot=>{
        context.guard();
        const text=rawText(snapshot);
        const note=memoryNotes(text).find(n=>noteId(profile,request.bucket,snapshot.revision,n.index)===request.noteId);
        if(!note) throw new AgentMemoryError('agent_memory_conflict');
        if(snapshot.limits[request.bucket]===null) throw new AgentMemoryError('agent_memory_read_only');
        let replacement: string;
        try { replacement=changeMemoryNote(text,{index:note.index,previous:note.text,content:request.content},snapshot.limits[request.bucket]!); }
        catch(error) { throw new AgentMemoryError(error instanceof Error && error.message==='memory_limit_exceeded'?'agent_memory_limit':'agent_memory_invalid'); }
        if(!validText(replacement)) throw new AgentMemoryError('agent_memory_invalid');
        await retain(profile,request.bucket,snapshot,request.content===null?'agent.memory.delete.requested':'agent.memory.edit.requested',context);
        return {bytes:Buffer.from(replacement).toString('base64')};
      },context);
      await recordSuccess(profile, request.content===null?'agent.memory.delete.succeeded':'agent.memory.edit.succeeded', context);
      try { const result=await api.readMemory(profile); context.guard(); return result; }
      catch { throw new AgentMemoryError('agent_memory_uncertain'); }
    },
    async readSoul(profile) {
      const snapshot=await exchange(profile,'soul'), content=rawText(snapshot);
      return {agentId:profile,capturedAt:now(),exists:snapshot.exists,revision:snapshot.revision,content,characters:[...content].length,
        contextLimit:snapshot.limits.context,writable:snapshot.limits.writable,reason:snapshot.limits.writable?null:reason};
    },
    async changeSoul(profile,value,context) {
      if(!exactObject(value,['revision','content']) || !revision(value.revision) || !validText(value.content)) throw new AgentMemoryError('agent_memory_invalid');
      const request=value as unknown as SoulChange;
      await exchange(profile,'soul',request.revision,async snapshot=>{
        await retain(profile,'soul',snapshot,'agent.soul.edit.requested',context);
        return {bytes:Buffer.from(request.content).toString('base64')};
      },context);
      await recordSuccess(profile, 'agent.soul.edit.succeeded', context);
      try { const result=await api.readSoul(profile); context.guard(); return result; }
      catch { throw new AgentMemoryError('agent_memory_uncertain'); }
    },
  };
  return api;
}
