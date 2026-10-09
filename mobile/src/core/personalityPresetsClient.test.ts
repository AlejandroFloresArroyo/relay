import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridgeClient } from './bridgeClient.ts';
import { RelayError } from './client.ts';
import { AGENT_MEMORY_ERROR_STATUS, AGENT_MEMORY_MESSAGES } from '../../../protocol/agentMemory.ts';
import { CHAT_PROTOCOL_HEADER, PROTOCOL_VERSION } from '../../../protocol/protocol.ts';
const id='11111111-1111-4111-8111-111111111111', revision='a'.repeat(64), requestId='22222222-2222-4222-8222-222222222222';
const summary={id,revision,name:'Breve',kind:'overlay',bytes:5,createdAt:1000,updatedAt:1000};
const version={...summary,content:'Breve'};
const catalog={revision,capturedAt:1000,presets:[summary]};
function client(value:unknown,status=200) {return createBridgeClient({baseUrl:'http://fixture.ts.net',key:'synthetic',fetch:(async()=>Response.json(value,{status})) as typeof fetch});}
test('personality catalogue and immutable version authenticate with the existing protocol',async()=>{
 const calls:{url:string;init:RequestInit}[]=[];
 const c=createBridgeClient({baseUrl:'http://fixture.ts.net',key:'synthetic',fetch:(async(url,init)=>{calls.push({url:String(url),init:init!});return Response.json(calls.length===1?catalog:version);}) as typeof fetch});
 assert.equal(typeof c.personalityPresets,'function');
 assert.deepEqual(await c.personalityPresets!(),catalog);
 assert.deepEqual(await c.personalityPreset!(id,revision),version);
 assert.equal(calls[1].url,`http://fixture.ts.net/v1/personality-presets/${id}/versions/${revision}`);
 for(const call of calls){const h=call.init.headers as Record<string,string>;assert.equal(h.Authorization,'Bearer synthetic');assert.equal(h[CHAT_PROTOCOL_HEADER],String(PROTOCOL_VERSION));}
});
test('the catalogue rejects content, duplicate identities, oversized lists and invalid revisions',async()=>{
 for(const value of [{...catalog,presets:[version]},{...catalog,presets:[summary,summary]},{...catalog,presets:Array(65).fill(summary)},{...catalog,revision:'bad'}]) {
  const c=client(value);assert.equal(typeof c.personalityPresets,'function');await assert.rejects(c.personalityPresets!(),(e)=>e instanceof RelayError&&e.code==='personality_unavailable');
 }
});
test('immutable retrieval cannot substitute a different version or byte count',async()=>{
 for(const v of [{...version,revision:'b'.repeat(64)},{...version,id:'33333333-3333-4333-8333-333333333333'},{...version,bytes:6}]){
  const c=client(v);assert.equal(typeof c.personalityPreset,'function');await assert.rejects(c.personalityPreset!(id,revision));
 }
});
test('known errors retain causes without forwarding private text; uncertainty is never retried',async()=>{
 for(const code of ['device_revoked','key_unknown','personality_conflict','personality_uncertain']){
  let calls=0;const c=createBridgeClient({baseUrl:'http://fixture.ts.net',key:'synthetic',fetch:(async()=>{calls++;return Response.json({error:{code,message:'PRIVATE'}},{status:code==='personality_uncertain'?503:409});}) as typeof fetch});
  assert.equal(typeof c.setConversationPersonality,'function');
  await assert.rejects(c.setConversationPersonality!('agent','conversation',{requestId,revision,preset:{id,revision}}),(e)=>e instanceof RelayError&&e.code===code&&!e.message.includes('PRIVATE'));assert.equal(calls,1);
 }
});
test('selection acknowledgements pin Agente, Conversación and immutable selection',async()=>{
 const value={agentId:'agent',conversationId:'conversation',revision,updatedAt:1000,preset:version};
 for(const bad of [{...value,agentId:'other'},{...value,conversationId:'other'},{...value,preset:null},{...value,preset:{...version,revision:'b'.repeat(64)}}]){
  const c=client(bad);assert.equal(typeof c.setConversationPersonality,'function');await assert.rejects(c.setConversationPersonality!('agent','conversation',{requestId,revision,preset:{id,revision}}));
 }
});
test('SOUL preview and apply reject a substituted Agente, preset or receipt',async()=>{
 const soul={agentId:'agent',capturedAt:1000,exists:true,revision,content:'Old',characters:3,contextLimit:null,writable:true,reason:null};
 const preset={...version,kind:'soul'};
 const c=client({agentId:'agent',preset,soul});assert.equal(typeof c.soulPresetPreview,'function');assert.deepEqual((await c.soulPresetPreview!('agent',{id,revision})).soul,soul);
 for(const v of [{requestId:'bad',presetId:id,presetRevision:revision,soul},{requestId,presetId:id,presetRevision:revision,soul:{...soul,agentId:'other'}}]){
  await assert.rejects(client(v).applySoulPreset!('agent',{requestId,presetId:id,presetRevision:revision,soulRevision:revision}));
 }
});
test('request validation rejects invalid references and UTF-8 size before transport',async()=>{
 let calls=0;const c=createBridgeClient({baseUrl:'http://fixture.ts.net',key:'synthetic',fetch:(async()=>{calls++;return Response.json(version);}) as typeof fetch});
 assert.equal(typeof c.createPersonalityPreset,'function');
 await assert.rejects(c.createPersonalityPreset!({requestId,catalogRevision:revision,name:'Breve',kind:'overlay',content:'ñ'.repeat(32769)}));
 await assert.rejects(c.personalityPreset!('../escape',revision));assert.equal(calls,0);
});
test('response size is enforced before parsing and during streaming',async()=>{
 for(const response of [new Response(JSON.stringify(catalog),{headers:{'Content-Length':'12587009'}}),new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(' '.repeat(12*1024*1024+4097)+JSON.stringify(catalog)));c.close();}}))]) {
  const c=createBridgeClient({baseUrl:'http://fixture.ts.net',key:'synthetic',fetch:(async()=>response) as typeof fetch});assert.equal(typeof c.personalityPresets,'function');await assert.rejects(c.personalityPresets!());
 }
});

test('preset SOUL endpoints preserve every known memory cause with local safe messages',async()=>{
 for(const code of Object.keys(AGENT_MEMORY_ERROR_STATUS) as (keyof typeof AGENT_MEMORY_ERROR_STATUS)[]){
  for(const operation of ['preview','apply'] as const){
   const c=client({error:{code,message:'PRIVATE upstream content'}},AGENT_MEMORY_ERROR_STATUS[code]);
   const request=operation==='preview'?c.soulPresetPreview!('agent',{id,revision}):c.applySoulPreset!('agent',{requestId,presetId:id,presetRevision:revision,soulRevision:revision});
   await assert.rejects(request,e=>e instanceof RelayError&&e.code===code&&e.status===AGENT_MEMORY_ERROR_STATUS[code]&&e.message===AGENT_MEMORY_MESSAGES[code]&&!e.message.includes('PRIVATE'));
  }
 }
});
