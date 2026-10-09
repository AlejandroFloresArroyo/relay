import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoPresets, DEMO_PRESET_SCENARIOS, resetDemoPresets, setDemoPresetScenario } from './demoPresets.ts';
import { createDemoMemory } from './demoMemory.ts';
import { validCatalog, validPreset } from './personalityPresetsClient.ts';
import { RelayError } from './client.ts';
const rid='11111111-1111-4111-8111-111111111111';
function setup(s='A'){return createDemoPresets(s,()=>10000,createDemoMemory(s,()=>10000));}
test('demo catalogue omits content and preserves immutable versions per Servidor',async()=>{
 resetDemoPresets();const a=setup(),b=setup('B'),catalog=await a.personalityPresets();assert.ok(validCatalog(catalog));assert.ok(catalog.presets.every(p=>!('content' in p)));
 const p=catalog.presets.find(p=>p.kind==='overlay')!,old=await a.personalityPreset(p.id,p.revision);assert.ok(validPreset(old,true));
 const next=await a.updatePersonalityPreset(p.id,{requestId:rid,revision:p.revision,name:'Nuevo',content:'Nuevo contenido'});
 assert.notEqual(next.revision,p.revision);assert.deepEqual(await a.personalityPreset(p.id,p.revision),old);assert.equal((await b.personalityPreset(p.id)).name,old.name);
});
test('demo conversation freezes a version through edit and delete; none inherits Servidor',async()=>{
 resetDemoPresets();const a=setup(),c=await a.personalityPresets(),p=c.presets.find(p=>p.kind==='overlay')!,initial=await a.conversationPersonality('dev','c');
 const selected=await a.setConversationPersonality('dev','c',{requestId:rid,revision:initial.revision,preset:{id:p.id,revision:p.revision}});
 await a.updatePersonalityPreset(p.id,{requestId:'22222222-2222-4222-8222-222222222222',revision:p.revision,name:'Cambio',content:'Texto nuevo'});
 assert.equal((await a.conversationPersonality('dev','c')).preset?.revision,selected.preset?.revision);
 const latest=await a.personalityPreset(p.id);await a.deletePersonalityPreset(p.id,{requestId:'33333333-3333-4333-8333-333333333333',revision:latest.revision});assert.deepEqual((await a.conversationPersonality('dev','c')).preset,selected.preset);
});
test('demo exposes empty, loading, offline, revoked, error, conflict and uncertainty distinctly',async()=>{
 assert.ok(['ready','empty','loading','offline','revoked','error','conflict','uncertain','soul_changed','mid_turn','external'].every(s=>DEMO_PRESET_SCENARIOS.some(x=>x===s)));
 setDemoPresetScenario('empty');assert.equal((await setup().personalityPresets()).presets.length,0);
 for(const [scenario,code] of [['offline','unreachable'],['revoked','device_revoked'],['error','personality_unavailable']] as const){setDemoPresetScenario(scenario);await assert.rejects(setup().personalityPresets(),e=>e instanceof RelayError&&e.code===code);}
 for(const s of ['conflict','uncertain'] as const){setDemoPresetScenario(s);const a=setup(),c=await a.personalityPresets();await assert.rejects(a.createPersonalityPreset({requestId:rid,catalogRevision:c.revision,name:'Nuevo',kind:'overlay',content:'Texto'}),e=>e instanceof RelayError&&e.code===`personality_${s}`);}
 resetDemoPresets();
});

test('DEMO exported client includes Presets and shows a protected SOUL without pretending it is writable',async()=>{
 const {createDemoClient,resetDemo}=await import('./demo.ts');resetDemo();const c=createDemoClient('preset-demo',()=>10000);assert.equal(typeof c.personalityPresets,'function');const catalog=await c.personalityPresets!();const soul=catalog.presets.find(p=>p.kind==='soul')!;setDemoPresetScenario('read_only');assert.equal((await c.soulPresetPreview!('dev',{id:soul.id,revision:soul.revision})).soul.writable,false);setDemoPresetScenario('limit');await assert.rejects(c.createPersonalityPreset!({requestId:rid,catalogRevision:catalog.revision,name:'Nuevo',kind:'overlay',content:'Texto'}),e=>e instanceof RelayError&&e.code==='personality_limit');resetDemo();
});

test('demo includes a declined fingerprint without changing SOUL',async()=>{
 const module=await import('./demoPresets.ts');assert.ok(module.DEMO_PRESET_SCENARIOS.some(s=>String(s)==='fingerprint_denied'));
 resetDemoPresets();const c=setup(),catalog=await c.personalityPresets(),p=catalog.presets.find(x=>x.kind==='soul')!;const preview=await c.soulPresetPreview('dev',{id:p.id,revision:p.revision});
 const allow=(module as unknown as {demoPresetFingerprintAllowed:()=>boolean}).demoPresetFingerprintAllowed;assert.equal(typeof allow,'function');setDemoPresetScenario('fingerprint_denied' as Parameters<typeof setDemoPresetScenario>[0]);assert.equal(allow(),false);assert.deepEqual((await c.soulPresetPreview('dev',{id:p.id,revision:p.revision})).soul,preview.soul);resetDemoPresets();assert.equal(allow(),true);
});

test('limit DEMO actually fills the 64-preset catalogue shown by the UI',async()=>{
 setDemoPresetScenario('limit');const catalog=await setup().personalityPresets();assert.equal(catalog.presets.length,64);assert.ok(validCatalog(catalog));resetDemoPresets();
});

test('DEMO saves the current demo SOUL as a new SOUL preset without changing that SOUL',async()=>{
 resetDemoPresets();const memory=createDemoMemory('A',()=>10000),c=createDemoPresets('A',()=>10000,memory),soul=await memory.agentSoul('dev');assert.ok(soul.exists&&soul.content);
 const before=await c.personalityPresets(),saved=await c.createPersonalityPreset({requestId:rid,catalogRevision:before.revision,name:'SOUL de dev',kind:'soul',content:soul.content});
 assert.equal(saved.content,soul.content);assert.ok((await c.personalityPresets()).presets.some(p=>p.id===saved.id&&p.kind==='soul'));assert.deepEqual(await memory.agentSoul('dev'),soul);resetDemoPresets();
});
