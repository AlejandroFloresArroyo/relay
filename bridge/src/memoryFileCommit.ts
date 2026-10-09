import fs, { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { AGENT_MEMORY_MAX_BYTES, type AgentMemoryErrorCode, type MemoryBucket } from '../../protocol/agentMemory.ts';
import { exactObject } from './changeLog.ts';

export interface FileSnapshot { bytes: string; exists: boolean; identity: string[] | null }
export interface PreparedSnapshot extends FileSnapshot {
  revision: string; config: FileSnapshot;
  directories: { fd: number; identity: string[] }[];
  lockIdentity: string[] | null;
}
export class MemoryFileError extends Error {
  code: AgentMemoryErrorCode;
  constructor(code: AgentMemoryErrorCode) { super('Memory file transaction failed.'); this.code = code; }
}
function fail(code: AgentMemoryErrorCode = 'agent_memory_unavailable'): never { throw new MemoryFileError(code); }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const identity = (s: BigIntStats) => [s.dev,s.ino,s.uid,s.mode,s.mtimeNs,s.ctimeNs,s.size].map(String);
const directoryIdentity = (s: BigIntStats) => identity(s).slice(0,4);
const validIdentity = (v: unknown, length: number): v is string[] => Array.isArray(v) && v.length === length && v.every(n => typeof n === 'string' && /^\d{1,40}$/.test(n));
function regular(s: BigIntStats) {
  if (!s.isFile() || s.nlink !== 1n || s.uid !== BigInt(process.getuid!()) || s.mode & 0o022n || s.size > BigInt(AGENT_MEMORY_MAX_BYTES)) fail();
}
function checkSource(anchor: string, name: string, expected: FileSnapshot, privateFile = false) {
  if (typeof expected?.bytes !== 'string' || typeof expected.exists !== 'boolean' || expected.exists && !validIdentity(expected.identity,7)
    || !expected.exists && (expected.identity!==null || expected.bytes!=='')) fail();
  let fd: number;
  try { fd = fs.openSync(`${anchor}/${name}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK); }
  catch (error) {
    if (!expected.exists && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    fail('agent_memory_conflict');
  }
  try {
    const before=fs.fstatSync(fd,{bigint:true}); regular(before);
    if (privateFile && before.mode & 0o077n) fail();
    const chunks: Buffer[]=[];let size=0;
    while (size<=AGENT_MEMORY_MAX_BYTES) {
      const chunk=Buffer.alloc(Math.min(65536,AGENT_MEMORY_MAX_BYTES+1-size));
      const count=fs.readSync(fd,chunk,0,chunk.length,null);
      if (!count) break;
      chunks.push(chunk.subarray(0,count));size+=count;
    }
    const after=fs.fstatSync(fd,{bigint:true});regular(after);
    const bytes=Buffer.concat(chunks,size);
    if (size>AGENT_MEMORY_MAX_BYTES || !same(identity(before),identity(after)) || !expected.exists
      || !same(identity(after),expected.identity) || bytes.toString('base64')!==expected.bytes) fail('agent_memory_conflict');
    new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  } finally { fs.closeSync(fd); }
}

/** All validation is synchronous. Local revocation cannot interleave the final guard and rename. */
export function commitMemoryFile(options: {
  home: string; managedFile: string; profile: string; bucket: MemoryBucket | 'soul'; previous: PreparedSnapshot;
  replacement: Buffer; prepared: unknown; pid: number; guard: () => void; onCommitAttempt: () => void;
}): true {
  const { home, managedFile, profile, bucket, previous, replacement, prepared: m, pid, guard }=options;
  if (!['memory','user','soul'].includes(bucket) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(profile)) fail();
  const name={memory:'MEMORY.md',user:'USER.md',soul:'SOUL.md'}[bucket];
  if (!exactObject(m,['phase','bucket','pid','dirFd','directoryIdentity','temp','tempIdentity','revision','lockIdentity'])
    || m.phase!=='prepared' || m.bucket!==bucket || m.pid!==pid || !Number.isSafeInteger(pid) || pid<=0
    || !Number.isSafeInteger(m.dirFd) || (m.dirFd as number)<0 || (m.dirFd as number)>1_000_000
    || typeof m.temp!=='string' || !/^\.relay-memory-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(m.temp)
    || m.revision!==previous.revision || !validIdentity(m.directoryIdentity,4) || !validIdentity(m.tempIdentity,7)
    || !validIdentity(m.lockIdentity,2) || !same(m.lockIdentity,previous.lockIdentity)
    || !Array.isArray(previous.directories) || !previous.directories.length) fail();
  const last=previous.directories.at(-1)!;
  if (m.dirFd!==last.fd || !same(m.directoryIdentity,last.identity)) fail();
  const anchor=`/proc/${pid}/fd/${m.dirFd}`;
  const opened: number[]=[];
  try {
    // Reopen the public chain using only fixed, server-owned profile coordinates.
    let fd=fs.openSync('/',constants.O_RDONLY|constants.O_DIRECTORY);opened.push(fd);
    const absolute=path.resolve(home);
    for (const part of absolute.split('/').filter(Boolean)) {
      fd=fs.openSync(`/proc/self/fd/${fd}/${part}`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);opened.push(fd);
    }
    const childNames=profile==='default'?[]:['profiles',profile];
    if(bucket!=='soul')childNames.push('memories');
    for (let i=0;i<previous.directories.length;i++) {
      const expected=previous.directories[i];
      if (!expected || !Number.isSafeInteger(expected.fd) || expected.fd<0 || expected.fd>1_000_000 || !validIdentity(expected.identity,4)) fail();
      if (i>0) {
        if (!childNames[i-1]) fail();
        fd=fs.openSync(`/proc/self/fd/${fd}/${childNames[i-1]}`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);opened.push(fd);
      }
      const stat=fs.fstatSync(fd,{bigint:true});
      if (!stat.isDirectory() || stat.uid!==BigInt(process.getuid!()) || stat.mode & 0o022n || !same(directoryIdentity(stat),expected.identity)) fail('agent_memory_conflict');
      const retained=fs.statSync(`/proc/${pid}/fd/${expected.fd}`,{bigint:true});
      if (!retained.isDirectory() || !same(directoryIdentity(retained),expected.identity)) fail('agent_memory_conflict');
    }
    if (previous.directories.length!==childNames.length+1) fail();
    const anchored=fs.statSync(anchor,{bigint:true});
    if (!anchored.isDirectory() || !same(directoryIdentity(anchored),last.identity)) fail('agent_memory_conflict');
    const profileDirectory=previous.directories[profile==='default'?0:2];
    if (!profileDirectory || !Number.isSafeInteger(profileDirectory.fd) || profileDirectory.fd<0) fail();
    checkSource(`/proc/${pid}/fd/${profileDirectory.fd}`,'config.yaml',previous.config);
    checkSource(anchor,name,previous);
    checkSource(anchor,m.temp,{bytes:replacement.toString('base64'),exists:true,identity:m.tempIdentity},true);
    const lock=fs.openSync(`${anchor}/${name}.lock`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const stat=fs.fstatSync(lock,{bigint:true});regular(stat);
      if (!same(identity(stat).slice(0,2),m.lockIdentity)) fail('agent_memory_conflict');
    } finally { fs.closeSync(lock); }
    // Any managed configuration makes the previously local effective limits unverifiable.
    try { fs.lstatSync(managedFile); fail('agent_memory_conflict'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
    guard();
    options.onCommitAttempt();
    try { fs.renameSync(`${anchor}/${m.temp}`,`${anchor}/${name}`); }
    catch { fail('agent_memory_uncertain'); }
    return true;
  } catch (error) {
    if (error instanceof MemoryFileError || error instanceof Error && error.name==='AuthorizationError') throw error;
    return fail();
  } finally {
    let cleanupFailed = false;
    for (const fd of opened.reverse()) {
      try { fs.closeSync(fd); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) fail();
  }
}
