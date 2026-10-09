import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitMemoryFile, MemoryFileError, type PreparedSnapshot } from '../src/memoryFileCommit.ts';

test('commitMemoryFile rejects profile names that could escape the profiles directory',()=>{
 const reached=new Error('validation passed the profile check');
 // Every check before the revision comparison passes; reading previous.revision proves the profile was accepted.
 const previous={get revision():string{throw reached;}} as unknown as PreparedSnapshot;
 const prepared={phase:'prepared',bucket:'soul',pid:1,dirFd:3,directoryIdentity:[],temp:'.relay-memory-00000000-0000-4000-8000-000000000000.tmp',tempIdentity:[],revision:'r',lockIdentity:[]};
 const attempt=(profile:string)=>()=>commitMemoryFile({home:'/nonexistent',managedFile:'/nonexistent',profile,bucket:'soul',previous,replacement:Buffer.alloc(0),prepared,pid:1,guard(){},onCommitAttempt(){}});
 assert.throws(attempt('default'),reached);
 for(const profile of ['..','../other','a/b','a/../b','.hidden',''])assert.throws(attempt(profile),MemoryFileError,profile);
});
