import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDemoKanbanClient, setDemoWorkScenario} from './demoKanban.ts';
import {validWorkPage,validWorkDetail,validWorkReceipt} from './kanban.ts';
test('demo has valid manual metadata and notices are idempotent explicit operations',async()=>{
 const api=createDemoKanbanClient('synthetic',['dev'],1791110400000);setDemoWorkScenario('synthetic','normal');
 const page=await api.items();assert.ok(validWorkPage(page));assert.equal(page.items.length,8);
 const created=await api.create({requestId:'fixture_create',title:'Synthetic task',agentId:'dev',column:'todo',blockedBy:[]});
 assert.equal((await api.item(created.item.id)).latestNotification,null);
 const input={requestId:'fixture_notice',revision:created.item.revision,agentId:'dev',input:'Human exact input'};
 const receipt=await api.notify(created.item.id,input);assert.ok(validWorkReceipt(receipt));assert.equal(receipt.state,'started');
 assert.deepEqual(await api.notify(created.item.id,input),receipt);assert.ok(validWorkDetail(await api.item(created.item.id)));
 assert.equal((await api.item(created.item.id)).item.column,'todo');
 setDemoWorkScenario('synthetic','empty');assert.equal((await api.items()).items.length,0);
 setDemoWorkScenario('synthetic','compact');assert.equal((await api.items()).items.length,22);
 setDemoWorkScenario('synthetic','error');await assert.rejects(api.items());
});
test('demo notice reuses the supplied Conversation/Turn port once and forwards the exact human input',async()=>{
 const effects:{agent:string;requestId:string;input:string}[]=[];
 const api=createDemoKanbanClient('synthetic-ports',['dev'],1791110400000,async(agent,requestId,input)=>{effects.push({agent,requestId,input});return {conversationId:'registered-conversation',runId:'registered-run'};});
 const created=await api.create({requestId:'fixture_create',title:'Synthetic',agentId:'dev',column:'todo',blockedBy:[]});
 const req={requestId:'fixture_notice',revision:created.item.revision,agentId:'dev',input:'Exact human message'};
 const [first,second]=await Promise.all([api.notify(created.item.id,req),api.notify(created.item.id,req)]);
 assert.deepEqual(first,second);assert.equal(first.conversationId,'registered-conversation');assert.equal(effects.length,1);assert.equal(effects[0].input,req.input);
});
