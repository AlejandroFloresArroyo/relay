import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateWorkDraft } from './kanban.ts';
import type { KanbanItem } from '../../../protocol/kanban.ts';
const at = 1791110400000;
const item: KanbanItem = {id:'00000000-0000-4000-8000-000000000001',number:1,revision:'a'.repeat(64),title:'Synthetic item',agentId:'dev',column:'todo',blockedBy:[],commentCount:0,createdAt:at,updatedAt:at};
test('manual drafts obey title, assignment and dependency boundaries without claiming an active Turn', () => {
 assert.equal(validateWorkDraft({title:'Synthetic item',agentId:'dev',column:'todo',blockedBy:[]},['dev'],[item]),null);
 assert.match(validateWorkDraft({title:' '.repeat(2),agentId:null,column:'todo',blockedBy:[]},[],[])!,/título/);
 assert.match(validateWorkDraft({title:'x'.repeat(201),agentId:null,column:'todo',blockedBy:[]},[],[])!,/200/);
 assert.match(validateWorkDraft({title:'x',agentId:'foreign',column:'todo',blockedBy:[]},['dev'],[])!,/Servidor/);
 assert.match(validateWorkDraft({title:'x',agentId:'dev',column:'blocked',blockedBy:[]},['dev'],[item])!,/bloquea/);
 assert.match(validateWorkDraft({...item,blockedBy:[item.id]},['dev'],[item],item.id)!,/mismo/);
});

test('cycles are rejected and UTF-8 limits apply to manual text', async () => {
 const { validateWorkText } = await import('./kanban.ts');
 const other = {...item,id:'00000000-0000-4000-8000-000000000002',blockedBy:[item.id]};
 assert.match(validateWorkDraft({...item,blockedBy:[other.id]},['dev'],[item,other],item.id)!,/ciclo/);
 assert.equal(validateWorkText('Hola\nAgente',4096),null);
 assert.match(validateWorkText('😀'.repeat(1025),4096)!,/4096/);
 assert.ok(validateWorkText('secret\u0000',4096));
});
test('dated cache and preferences reject another scope and malformed metadata; receipts never imply a completed Turn', async () => {
 const { parseWorkPreferences, parseWorkCache, workCache, notificationLabel } = await import('./kanban.ts');
 const counts = {todo:1,in_progress:0,review:0,blocked:0,done:0};
 const page = {items:[item],counts,revision:item.revision,observedAt:at,nextCursor:null};
 const encoded = workCache('A|fixture|device',page);
 assert.deepEqual(parseWorkCache(encoded,'A|fixture|device'),page);
 assert.equal(parseWorkCache(encoded,'B|fixture|device'),null);
 assert.equal(parseWorkCache(encoded.replace('1791110400000','1791110400'),'A|fixture|device'),null);
 assert.equal(parseWorkCache(encoded.replace('"todo":1','"todo":2'),'A|fixture|device'),null);
 assert.deepEqual(parseWorkPreferences('{"column":"review","compact":true}'),{column:'review',compact:true});
 assert.deepEqual(parseWorkPreferences('{"column":"injected","compact":"false"}'),{column:'todo',compact:false});
 const base={requestId:'fixture_request',itemId:item.id,itemRevision:item.revision,agentId:'dev',requestedBy:{kind:'device' as const,id:'fixture',name:'Humano'},requestedAt:at,updatedAt:at};
 assert.match(notificationLabel({...base,state:'started',conversationId:'conversation',runId:'run',errorCode:null,turn:null}),/no disponible/);
 assert.match(notificationLabel({...base,state:'uncertain',conversationId:null,runId:null,errorCode:'kanban_notification_uncertain'}),/incierto/);
 assert.match(notificationLabel({...base,state:'rejected',conversationId:null,runId:null,errorCode:'server_paused'}),/Pausa general/);
});

test('receipt lookup references survive remount without storing or queueing notice input',async()=>{
 const {parseWorkAttempts,workAttempts}=await import('./kanban.ts');
 const attempts={[item.id]:{itemId:item.id,requestId:'fixture_notice',itemRevision:item.revision,agentId:'dev',requestedAt:at}};
 assert.deepEqual(parseWorkAttempts(workAttempts('scope',attempts),'scope'),attempts);
 assert.deepEqual(parseWorkAttempts(workAttempts('scope',attempts),'another'),{});
 assert.deepEqual(parseWorkAttempts(JSON.stringify({version:1,source:'scope',attempts:{...attempts,[item.id]:{...attempts[item.id],input:'hidden'}}}),'scope'),{});
});
test('a Tarjeta lifted from a column lands where its horizontal travel puts it, or nowhere past the board',async()=>{
 const {dragTarget}=await import('./kanban.ts');
 assert.equal(dragTarget('todo',0,160),'todo');
 assert.equal(dragTarget('todo',79,160),'todo');
 assert.equal(dragTarget('todo',81,160),'in_progress');
 assert.equal(dragTarget('review',-170,160),'in_progress');
 assert.equal(dragTarget('todo',3*160,160),'blocked');
 assert.equal(dragTarget('todo',4*160,160),'done');
 assert.equal(dragTarget('done',-4*160,160),'todo');
 assert.equal(dragTarget('todo',-100,160),null);
 assert.equal(dragTarget('done',100,160),null);
 assert.equal(dragTarget('todo',Number.NaN,160),null);
 assert.equal(dragTarget('todo',100,0),null);
 // The card's centre must stay inside the board: it started `at` from the top, `size` tall, in a `board`-tall row.
 const on={dy:0,at:40,size:100,board:600};
 assert.equal(dragTarget('todo',0,160,on),'todo');
 assert.equal(dragTarget('todo',160,160,{...on,dy:-90}),'in_progress');
 assert.equal(dragTarget('todo',160,160,{...on,dy:-91}),null);
 assert.equal(dragTarget('todo',160,160,{...on,dy:510}),'in_progress');
 assert.equal(dragTarget('todo',160,160,{...on,dy:511}),null);
 assert.equal(dragTarget('todo',0,160,{...on,board:0}),'todo');
});
test('notice validation accounts for both exact input UTF-8 and the encoded request body',async()=>{
 const {validateWorkNotification}=await import('./kanban.ts');
 const body={requestId:'fixture_notice',revision:item.revision,agentId:'dev',input:'Exact human input'};
 assert.equal(validateWorkNotification(body),null);
 assert.match(validateWorkNotification({...body,input:'😀'.repeat(16001)})!,/64000/);
 assert.match(validateWorkNotification({...body,input:'"'.repeat(40000)})!,/80000/);
});

test('a swipe to the right moves a Tarjeta to the next column, skipping BLOQUEADO, and DONE stays', async () => {
 const { nextColumn } = await import('./kanban.ts');
 assert.equal(nextColumn('todo'),'in_progress');
 assert.equal(nextColumn('in_progress'),'review');
 assert.equal(nextColumn('review'),'done');
 assert.equal(nextColumn('blocked'),'in_progress');
 assert.equal(nextColumn('done'),null);
});
