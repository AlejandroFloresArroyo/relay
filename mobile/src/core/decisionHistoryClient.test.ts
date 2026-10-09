import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridgeClient } from './bridgeClient.ts';
import { RelayError } from './client.ts';

function client(response: Response, timeoutMs=5000) {
 return createBridgeClient({baseUrl:'http://synthetic.fixture.ts.net:17651',key:'synthetic',timeoutMs,fetch:async()=>response});
}
const unavailable=(error:unknown)=>error instanceof RelayError && error.code==='decision_history_unavailable';

test('an oversized legacy history is rejected from its length without consuming unbounded JSON',async()=>{
 let reads=0,parsed=false,cancelled=false;
 const response={ok:true,status:200,headers:new Headers({'Content-Length':'20971521'}),json:async()=>{parsed=true;return {decisions:[],capturedAt:3000};},
  body:{cancel:async()=>{cancelled=true;},getReader:()=>({read:async()=>{reads++;return {done:true};},cancel:async()=>{cancelled=true;},releaseLock(){}})}} as unknown as Response;
 await assert.rejects(client(response).decisions(),unavailable);
 assert.equal(reads,0);assert.equal(parsed,false);assert.equal(cancelled,true);
});

test('absent or lying content length cannot bypass the streamed legacy byte limit',async()=>{
 for(const length of [null,'1']){
  let reads=0,cancelled=false;
  const response={ok:true,status:200,headers:new Headers(length?{'Content-Length':length}:{}),json:async()=>({decisions:[],capturedAt:3000}),
   body:{getReader:()=>({read:async()=>{reads++;return {done:false,value:new Uint8Array(8*1024*1024)};},cancel:async()=>{cancelled=true;},releaseLock(){}})}} as unknown as Response;
  await assert.rejects(client(response).decisions(),unavailable);assert.equal(reads,3);assert.equal(cancelled,true);
 }
});

test('a history transport without a bounded stream fails closed rather than calling json',async()=>{
 let parsed=false;
 const response={ok:true,status:200,headers:new Headers(),body:null,json:async()=>{parsed=true;return {decisions:[],capturedAt:3000};}} as unknown as Response;
 await assert.rejects(client(response).decisions(),unavailable);assert.equal(parsed,false);
});

test('history denies and malformed bodies never expose private upstream content',async()=>{
 for(const [body,status,code] of [[{error:{code:'device_revoked',message:'synthetic-private-detail'}},401,'device_revoked'],['synthetic-private-detail',200,'decision_history_unavailable']] as const){
  await assert.rejects(client(new Response(JSON.stringify(body),{status})).decisions(),error=>error instanceof RelayError && error.code===code && !error.message.includes('synthetic-private-detail'));
 }
});


test('a timed-out history reader retires before consuming delayed native chunks',async()=>{
 let release!:(chunk:ReadableStreamReadResult<Uint8Array>)=>void, accesses=0,cancelled=false;
 const response={ok:true,status:200,headers:new Headers(),body:{getReader:()=>({read:()=>new Promise<ReadableStreamReadResult<Uint8Array>>(resolve=>{release=resolve;}),cancel:async()=>{cancelled=true;},releaseLock(){}})}} as unknown as Response;
 await assert.rejects(client(response,10).decisions(),error=>error instanceof RelayError && error.code==='timeout');
 assert.equal(cancelled,true);
 release({done:false,get value(){accesses++;return new Uint8Array(32);}});
 await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(accesses,0);
});
