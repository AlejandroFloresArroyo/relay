import { randomBytes, randomUUID } from 'node:crypto';
import nativeFs, { constants } from 'node:fs';
import { openPersonalityDirectory, PersonalityError } from './personalityCatalog.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModelSelection } from '../../protocol/protocol.ts';
import type { ConversationState, ConversationStore } from './chatPorts.ts';
import { checkStateDirectory, exactObject, isDeviceName, isTimestamp, isUuid, makeChangeRecord, openPrivateFile, StateError, syncStateDirectory, validateChangeRecord } from './changeLog.ts';
import type { ChangeInput, ChangeLog, ChangeRecord, StateIO } from './changeLog.ts';
import { validatePersonalitySelection } from './personalitySelection.ts';
import { HermesError } from './hermes.ts';

export interface ConversationActor { kind: 'device'; id: string; name: string }
export interface ConversationDeletion {
  agentId: string; id: string; revision: string; messageCount: number;
  sessionIds: string[]; remainingSessionIds: string[]; actor: ConversationActor;
  sessionRevisions: Record<string, string>;
}
export interface DurableConversationState extends ConversationState { deletions: ConversationDeletion[] }
export interface DurableConversationStore extends ConversationStore {
  snapshot(): DurableConversationState;
  mutate<T>(fn: (draft: DurableConversationState, addChange: (input: ChangeInput) => ChangeRecord) => T, guard?:()=>void): Promise<T>;
}

export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value !== '.' && value !== '..' && !/[\x00-\x1f\x7f/\\]/.test(value);
}
export function isConversationRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
export function isModelSelection(value: unknown): value is ModelSelection {
  return exactObject(value, ['provider', 'model']) && [value.provider, value.model].every((part) => typeof part === 'string' && part.trim() === part && part.length > 0 && part.length <= 512 && !/[\x00-\x1f\x7f]/.test(part));
}
function validateState(value: unknown): asserts value is DurableConversationState {
  if (!exactObject(value, ['schemaVersion', 'conversations', 'deletedRequests', 'auditOutbox', 'deletions']) || value.schemaVersion !== 1
    || !Array.isArray(value.conversations) || !Array.isArray(value.deletedRequests) || !Array.isArray(value.auditOutbox) || !Array.isArray(value.deletions)) throw new StateError();
  const ids = new Set<string>(); const requests = new Set<string>();
  for (const receipt of value.conversations) {
    if (!exactObject(receipt, ['agentId', 'id', 'createdAt', 'createdByDeviceId', 'createRequestId', 'state', 'sessionIds', 'model'], ['deletePlan','personality'])
      || !isConversationId(receipt.agentId) || !isConversationId(receipt.id) || !isTimestamp(receipt.createdAt) || !isUuid(receipt.createdByDeviceId)
      || !isConversationRequestId(receipt.createRequestId) || !['creating', 'ready', 'deleting'].includes(String(receipt.state))
      || !Array.isArray(receipt.sessionIds) || receipt.sessionIds.length === 0 || !receipt.sessionIds.every(isConversationId)
      || new Set(receipt.sessionIds).size !== receipt.sessionIds.length || !receipt.sessionIds.includes(receipt.id)
      || (receipt.model !== null && !isModelSelection(receipt.model))) throw new StateError();
    if (receipt.personality !== undefined) validatePersonalitySelection(receipt.personality,receipt.agentId,receipt.id);
    const key = JSON.stringify([receipt.agentId, receipt.id]);
    const request = JSON.stringify([receipt.agentId, receipt.createdByDeviceId, receipt.createRequestId]);
    if (ids.has(key) || requests.has(request)) throw new StateError();
    ids.add(key); requests.add(request);
    if (receipt.deletePlan !== undefined && (!exactObject(receipt.deletePlan, ['revision', 'remainingSessionIds'])
      || typeof receipt.deletePlan.revision !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.deletePlan.revision)
      || !Array.isArray(receipt.deletePlan.remainingSessionIds) || !receipt.deletePlan.remainingSessionIds.every(isConversationId))) throw new StateError();
  }
  for (const tombstone of value.deletedRequests) {
    if (!exactObject(tombstone, ['agentId', 'deviceId', 'requestId', 'conversationId']) || !isConversationId(tombstone.agentId)
      || !isUuid(tombstone.deviceId) || !isConversationRequestId(tombstone.requestId) || !isConversationId(tombstone.conversationId)) throw new StateError();
    const request = JSON.stringify([tombstone.agentId, tombstone.deviceId, tombstone.requestId]);
    if (requests.has(request)) throw new StateError();
    requests.add(request);
  }
  const deletionIds = new Set<string>();
  for (const deletion of value.deletions) {
    if (!exactObject(deletion, ['agentId', 'id', 'revision', 'messageCount', 'sessionIds', 'remainingSessionIds', 'actor', 'sessionRevisions'])
      || !isConversationId(deletion.agentId) || !isConversationId(deletion.id) || typeof deletion.revision !== 'string' || !/^[a-f0-9]{64}$/.test(deletion.revision)
      || !Number.isSafeInteger(deletion.messageCount) || Number(deletion.messageCount) < 0
      || !Array.isArray(deletion.sessionIds) || deletion.sessionIds.length === 0 || !deletion.sessionIds.every(isConversationId)
      || !Array.isArray(deletion.remainingSessionIds) || !deletion.remainingSessionIds.every(isConversationId)
      || !exactObject(deletion.actor, ['kind', 'id', 'name']) || deletion.actor.kind !== 'device' || !isUuid(deletion.actor.id) || !isDeviceName(deletion.actor.name)) throw new StateError();
    const sessionIds: string[] = deletion.sessionIds;
    if (!deletion.remainingSessionIds.every((id: string) => sessionIds.includes(id))
      || typeof deletion.sessionRevisions !== 'object' || deletion.sessionRevisions === null || Array.isArray(deletion.sessionRevisions)
      || !Object.entries(deletion.sessionRevisions).every(([id, revision]) => sessionIds.includes(id) && typeof revision === 'string' && /^[a-f0-9]{64}$/.test(revision))) throw new StateError();
    const key = JSON.stringify([deletion.agentId, deletion.id]);
    if (deletionIds.has(key) || new Set(deletion.sessionIds).size !== deletion.sessionIds.length || new Set(deletion.remainingSessionIds).size !== deletion.remainingSessionIds.length) throw new StateError();
    deletionIds.add(key);
  }
  const auditIds = new Set<string>();
  for (const record of value.auditOutbox) {
    validateChangeRecord(record);
    if (auditIds.has(record.id)) throw new StateError();
    auditIds.add(record.id);
  }
}

function verifyConversationTemp(file:string,expected:nativeFs.BigIntStats,bytes:Buffer):void {
  const identity=(stat:nativeFs.BigIntStats)=>[stat.dev,stat.ino,stat.uid,stat.mode,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs].map(String).join(':');
  let fd:number;
  try {fd=nativeFs.openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
  catch {throw new PersonalityError('personality_conflict');}
  try {
    const before=nativeFs.fstatSync(fd,{bigint:true});
    if(!before.isFile()||before.uid!==BigInt(process.getuid!())||before.nlink!==1n||before.mode&0o7177n||before.size!==BigInt(bytes.length)||identity(before)!==identity(expected))throw new PersonalityError('personality_conflict');
    const buffer=Buffer.alloc(bytes.length+1);let size=0;
    while(size<buffer.length){const count=nativeFs.readSync(fd,buffer,size,buffer.length-size,null);if(!count)break;size+=count;}
    if(size!==bytes.length||!buffer.subarray(0,size).equals(bytes)||identity(nativeFs.fstatSync(fd,{bigint:true}))!==identity(before))throw new PersonalityError('personality_conflict');
  } finally {nativeFs.closeSync(fd);}
}

export async function createConversationStore(options: { directory: string; changeLog: ChangeLog; now?: () => number; newId?: () => string; io?: StateIO }): Promise<DurableConversationStore> {
  const directory = path.resolve(options.directory); const file = path.join(directory, 'conversations.json');
  const io = options.io ?? fs; const now = options.now ?? Date.now; const newId = options.newId ?? randomUUID;
  let fatal = false; let queue: Promise<void> = Promise.resolve();
  await checkStateDirectory(directory, io);
  async function commit(next: DurableConversationState, guard?:()=>void): Promise<void> {
    validateState(next);
    const name=`.conversations.json.${randomBytes(16).toString('hex')}.tmp`;
    const dirFd=guard?openPersonalityDirectory(directory):undefined;
    const anchor=dirFd===undefined?directory:`/proc/self/fd/${dirFd}`,temporary=path.join(anchor,name);
    const bytes=Buffer.from(`${JSON.stringify(next)}\n`);
    let renameStarted = false,staged:nativeFs.BigIntStats|undefined;
    try {
      const existing = await openPrivateFile(file, constants.O_RDONLY, false, io).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      });
      await existing?.handle.close();
      const handle = await io.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); if(guard)staged=await handle.stat({bigint:true}); }
      finally { await handle.close(); }
      if (guard) {
        const current=openPersonalityDirectory(directory);
        try {const a=nativeFs.fstatSync(dirFd!),b=nativeFs.fstatSync(current);if(a.dev!==b.dev||a.ino!==b.ino)throw new PersonalityError('personality_conflict');}finally{nativeFs.closeSync(current);}
        verifyConversationTemp(temporary,staged!,bytes);
        guard();renameStarted=true;
        nativeFs.renameSync(temporary,`${anchor}/conversations.json`);
        nativeFs.fsyncSync(dirFd!);
      } else {
        renameStarted = true;
        await io.rename(temporary, file);
        await syncStateDirectory(directory, io);
      }
    } catch (error) {
      if(renameStarted) {fatal=true;if(guard)throw new PersonalityError('personality_uncertain');}
      if(guard)throw error;
      throw new StateError();
    }
    finally {
      await io.unlink(temporary).catch(() => {});
      if(dirFd!==undefined)try{nativeFs.closeSync(dirFd);}catch{if(renameStarted){fatal=true;throw new PersonalityError('personality_uncertain');}throw new PersonalityError('personality_unavailable');}
    }
  }
  let state: DurableConversationState;
  try {
    const opened = await openPrivateFile(file, constants.O_RDONLY, false, io).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (opened) {
      try { const decoded: unknown = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(await opened.handle.readFile())); validateState(decoded); state = decoded; }
      finally { await opened.handle.close(); }
    } else { state = { schemaVersion: 1, conversations: [], deletedRequests: [], auditOutbox: [], deletions: [] }; await commit(state); }
  } catch { throw new StateError(); }
  async function drain(): Promise<void> {
    if (state.auditOutbox.length === 0) return;
    for (const record of state.auditOutbox) await options.changeLog.appendCommitted(record);
    const next = structuredClone(state); next.auditOutbox = [];
    await commit(next); state = next;
  }
  await drain();
  const store: DurableConversationStore = {
    snapshot(): DurableConversationState { if (fatal) throw new StateError(); return structuredClone(state); },
    async setModel(agentId, id, model, actor) {
      await store.mutate((draft, addChange) => {
        const receipt = draft.conversations.find((entry) => entry.agentId === agentId && entry.id === id && entry.state === 'ready');
        if (!receipt) throw new HermesError('conversation_read_only', 'Esta Conversación no admite cambios de modelo.');
        const previous = receipt.model;
        receipt.model = model;
        if (JSON.stringify(previous) !== JSON.stringify(model)) addChange({ actor, action: 'conversation.model.changed', target: { kind: 'conversation', id: JSON.stringify([agentId, id]) } });
      });
    },
    mutate<T>(fn: (draft: DurableConversationState, addChange: (input: ChangeInput) => ChangeRecord) => T, guard?:()=>void): Promise<T> {
      const operation = queue.then(async () => {
        if (fatal) throw new StateError();
        await drain(); const draft = structuredClone(state);
        const result = fn(draft, (input) => { const record = makeChangeRecord(input, now(), newId); draft.auditOutbox.push(record); return record; });
        if (result && typeof result === 'object' && 'then' in result && typeof result.then === 'function') throw new StateError();
        const next = structuredClone(draft); await commit(next,guard); state = next;
        try {await drain();}catch(error){if(guard)throw new PersonalityError('personality_uncertain');throw error;}
        return result;
      });
      queue = operation.then(() => {}, () => {}); return operation;
    },
  };
  return store;
}
