import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridgeClient } from './bridgeClient.ts';
const at=1791110400000, id='00000000-0000-4000-8000-000000000001', revision='a'.repeat(64);
const item={id,number:1,revision,title:'Synthetic',agentId:'dev',column:'todo',blockedBy:[],commentCount:0,createdAt:at,updatedAt:at};
const page={items:[item],counts:{todo:1,in_progress:0,review:0,blocked:0,done:0},revision,observedAt:at,nextCursor:null};
function client(reply: unknown, status=200) {
 const calls: {url:string;options:RequestInit}[]=[];
 const fetcher = async (url: string | URL | Request,options?:RequestInit) => {calls.push({url:String(url),options:options!});return new Response(JSON.stringify(reply),{status});};
 return {api:createBridgeClient({baseUrl:'https://synthetic.fixture.ts.net',key:'synthetic-key',fetch:fetcher}).kanban!,calls};
}
test('public transport authenticates additive routes and validates received metadata before display',async()=>{
 const {api,calls}=client(page);
 assert.deepEqual(await api.items({limit:100}),page);
 assert.equal(calls[0].url,'https://synthetic.fixture.ts.net/v1/kanban/items?limit=100');
 assert.equal(new Headers(calls[0].options.headers).get('X-Relay-Protocol'),'2');
 assert.equal(calls[0].options.redirect,'error');
 await assert.rejects(client({...page,items:[{...item,createdAt:at/1000}]}).api.items(), /Trabajo/);
 await assert.rejects(client({...page,nextCursor:'../secret'}).api.items(), /Trabajo/);
});
test('an old Puente without Work routes (404/405/501) asks to update the Puente; a Work 404 keeps its cause',async()=>{
 for(const [status,body] of [[404,{error:{code:'not_found',message:'Not found'}}],[405,'Method Not Allowed'],[501,{error:{code:'not_implemented'}}]] as const){
  const fetcher=async()=>new Response(typeof body==='string'?body:JSON.stringify(body),{status});
  const api=createBridgeClient({baseUrl:'https://synthetic.fixture.ts.net',key:'synthetic-key',fetch:fetcher}).kanban!;
  await assert.rejects(api.items(),e=>e instanceof Error&&'code' in e&&e.code==='kanban_unsupported'&&e.message==='Actualiza el Puente para usar Trabajo.',`status ${status}`);
 }
 await assert.rejects(client({error:{code:'kanban_not_found'}},404).api.item(id),e=>e instanceof Error&&'code' in e&&e.code==='kanban_not_found');
});
test('opaque auth errors, byte caps and request/receipt identity fail closed',async()=>{
 await assert.rejects(client({error:{code:'device_revoked',message:'SECRET_UPSTREAM'}},401).api.items(),e=>e instanceof Error && !e.message.includes('SECRET') && 'code' in e && e.code==='device_revoked');
 await assert.rejects(client({...page,unexpected:'x'.repeat(1048576)}).api.items(),/Trabajo/);
 const req={requestId:'fixture_request',revision,agentId:'dev',input:'Exact human preview'};
 const receipt={...req,itemId:'00000000-0000-4000-8000-000000000002',itemRevision:revision,requestedBy:{kind:'device',id:'fixture',name:'Humano'},requestedAt:at,updatedAt:at,state:'started',conversationId:'new',runId:'new-run',errorCode:null,turn:null};
 await assert.rejects(client(receipt,202).api.notify(id,req),/Trabajo/);
 const valid=client({...receipt,itemId:id},202); await valid.api.notify(id,req);
 assert.deepEqual(JSON.parse(String(valid.calls[0].options.body)),req);
 await assert.rejects(valid.api.notify('../unsafe',req));
 assert.equal(valid.calls.length,1);
});
