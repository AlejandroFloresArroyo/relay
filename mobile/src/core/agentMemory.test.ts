import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridgeClient } from './bridgeClient.ts';
import { isAgentMemory, isAgentSoul } from './agentMemory.ts';
import type { AgentMemory, AgentSoul } from '../../../protocol/agentMemory.ts';
const rev='a'.repeat(64), note='b'.repeat(64);
const memory:AgentMemory={agentId:'dev',capturedAt:100,buckets:{memory:{exists:true,revision:rev,notes:[{id:note,text:'Prefiere español.'}],characters:17,limit:2200,writable:true,reason:null},user:{exists:false,revision:rev,notes:[],characters:0,limit:1375,writable:false,reason:'No existe.'}}};
const soul:AgentSoul={agentId:'dev',capturedAt:100,exists:false,revision:rev,content:'',characters:0,contextLimit:null,writable:true,reason:null};
test('client sends memory identity and protocol, validates profile-scoped responses and uses safe errors',async()=>{
 const calls:{url:string;init:RequestInit}[]=[];let result:unknown=memory;let status=200;
 const client=createBridgeClient({baseUrl:'http://fixture.example.ts.net',key:'fixture',fetch:async(input,init)=>{calls.push({url:String(input),init:init!});return new Response(JSON.stringify(result),{status});}});
 assert.deepEqual(await client.agentMemory('dev'),memory);
 await client.changeAgentMemory('dev',{bucket:'memory',revision:rev,noteId:note,content:'Nueva nota'});
 assert.equal(calls[1].init.method,'PATCH');assert.equal(new Headers(calls[1].init.headers).get('X-Relay-Protocol'),'2');
 assert.deepEqual(JSON.parse(String(calls[1].init.body)),{bucket:'memory',revision:rev,noteId:note,content:'Nueva nota'});
 result=soul;assert.deepEqual(await client.agentSoul('dev'),soul);
 result={...soul,agentId:'another'};await assert.rejects(client.agentSoul('dev'),/no está disponible/);
 status=409;result={error:{code:'agent_memory_conflict',message:'PRIVATE CONTENT'}};
 await assert.rejects(client.agentSoul('dev'),e=>e instanceof Error&&!e.message.includes('PRIVATE')&&e.message.includes('cambió'));
});
test('normalizers reject unbounded or inconsistent payloads and preserve unknown effective limits',()=>{
 assert.equal(isAgentMemory(memory,'dev'),true);assert.equal(isAgentSoul(soul,'dev'),true);
 assert.equal(isAgentMemory({...memory,buckets:{...memory.buckets,memory:{...memory.buckets.memory,notes:[{id:note,text:'x'.repeat(1024*1024+1)}]}}},'dev'),false);
 assert.equal(isAgentSoul({...soul,contextLimit:-1},'dev'),false);
 assert.equal(isAgentSoul({...soul,characters:3},'dev'),false);
 assert.equal(isAgentMemory({...memory,capturedAt:NaN},'dev'),false);
});

test('memory transport rejects an oversized response before decoding or exposing its content',async()=>{
 let pulled=0;
 const stream=new ReadableStream<Uint8Array>({pull(control){pulled++;control.enqueue(new Uint8Array(1024*1024));if(pulled===20)control.close();}});
 const client=createBridgeClient({baseUrl:'http://fixture.example.ts.net',key:'fixture',fetch:async()=>new Response(stream,{headers:{'Content-Type':'application/json'}})});
 await assert.rejects(client.agentMemory('dev'),/no está disponible/);
 assert.ok(pulled<20,'the transport must stop reading at the payload bound');
});

test('the same payload bound applies to server errors without draining arbitrary error bodies',async()=>{
 let pulled=0;const stream=new ReadableStream<Uint8Array>({pull(control){pulled++;control.enqueue(new Uint8Array(1024*1024));if(pulled===20)control.close();}});
 const client=createBridgeClient({baseUrl:'http://fixture.example.ts.net',key:'fixture',fetch:async()=>new Response(stream,{status:503})});
 await assert.rejects(client.agentSoul('dev'),/no está disponible/);assert.ok(pulled<20);
});
