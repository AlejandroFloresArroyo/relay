import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDemoClient } from './demo.ts';
import { DEMO_MEMORY_SCENARIOS, demoAgentDocuments, setDemoMemoryScenario } from './demoMemory.ts';
import { isAgentMemory, isAgentSoul } from './agentMemory.ts';
test('demo exposes every memory and personality state with valid snapshots and real note mutations', async()=>{
 const now=1700000000000;
 for(const state of DEMO_MEMORY_SCENARIOS) {
  setDemoMemoryScenario(state);
  const view=demoAgentDocuments('atlas','dev',now);
  assert.equal(isAgentMemory(view.memory,'dev'),true,state);
  assert.equal(isAgentSoul(view.soul,'dev'),true,state);
 }
 setDemoMemoryScenario('ready');const client=createDemoClient('atlas',()=>now);
 const before=await client.agentMemory('dev');assert.equal(before.buckets.memory.notes.length,5);
 const first=before.buckets.memory.notes[0];
 const saved=await client.changeAgentMemory('dev',{bucket:'memory',revision:before.buckets.memory.revision,noteId:first.id,content:'Nueva 😀'});
 assert.equal(saved.buckets.memory.notes[0].text,'Nueva 😀');
 await assert.rejects(client.changeAgentMemory('dev',{bucket:'memory',revision:before.buckets.memory.revision,noteId:first.id,content:null}),/cambió/);
 assert.equal((await client.changeAgentMemory('dev',{bucket:'memory',revision:saved.buckets.memory.revision,noteId:saved.buckets.memory.notes[0].id,content:null})).buckets.memory.notes.length,4);
 const soul=await client.agentSoul('dev');
 assert.equal((await client.changeAgentSoul('dev',{revision:soul.revision,content:'Personalidad nueva'})).content,'Personalidad nueva');
 setDemoMemoryScenario('ready');
});
