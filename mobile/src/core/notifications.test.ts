import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNotificationClient } from './notifications.ts';
const origin='http://relay.fixture.ts.net:17651';
const status={schema:1,configured:true,transport:'ntfy-unifiedpush',availableKinds:['approval'],preferences:{enabled:false,types:{approval:true,task:true,error:true,server:true},preview:'generic'},revision:0,registration:null,delivery:'disabled',serverNow:1700000000000};
test('Notifications sends both additive versions to the exact paired Tailnet origin and validates capability DTO',async()=>{
 const requests:{url:string;options?:RequestInit}[]=[];
 const client=createNotificationClient({baseUrl:origin,key:'synthetic-private-key',deviceId:'synthetic-device',fetch:async(url,options)=>{requests.push({url:String(url),options});return new Response(JSON.stringify(status));}});
 assert.deepEqual(await client.status(),status);assert.equal(requests.length,1);assert.equal(requests[0].url,origin+'/v1/notifications');
 const headers=new Headers(requests[0].options?.headers);assert.equal(headers.get('X-Relay-Protocol'),'2');assert.equal(headers.get('X-Relay-Notifications'),'1');assert.equal(headers.get('Authorization'),'Bearer synthetic-private-key');assert.equal(requests[0].options?.redirect,'error');
});

test('wire states remain scalar and decisions reject hidden fields and invalid identity before transport',async()=>{
 const {validNotificationStatus}=await import('./notifications.ts');
 assert.equal(validNotificationStatus({...status,delivery:['disabled']}),false);
 let sent=0;
 const client=createNotificationClient({baseUrl:origin,key:'synthetic-key',deviceId:'synthetic-device',fetch:async()=>{sent++;return new Response(JSON.stringify({ok:true,outcome:'approved'}));}});
 const input={schema:1 as const,registrationId:'registration-A',target:{agentId:'agentA',runId:'run-A',approvalId:'approval-A'},choice:'once' as const};
 await assert.rejects(client.decide('notice-A',{...input,hidden:'private'} as typeof input));
 await assert.rejects(client.decide('../other',input));
 await assert.rejects(client.decide('notice-A',{...input,target:{...input.target,agentId:''}}));
 assert.equal(sent,0);
});


test('an opposite ACK is uncertain, never a confirmed decision or resend',async()=>{
 let sent=0;
 const client=createNotificationClient({baseUrl:origin,key:'synthetic-key',deviceId:'synthetic-device',fetch:async()=>{sent++;return new Response(JSON.stringify({ok:true,outcome:'rejected'}));}});
 await assert.rejects(client.decide('notice-A',{schema:1,registrationId:'registration-A',target:{agentId:'agentA',runId:'run-A',approvalId:'approval-A'},choice:'once'}),error=>(error as {code:string}).code==='decision_uncertain');
 assert.equal(sent,1);
});

import { notificationOpenTarget } from './notifications.ts';
test('generic notification gestures open only Relay Servers, never a private approval lookup',()=>{
 for(const kind of ['task','error','server']) {
  assert.deepEqual(notificationOpenTarget({serverId:'A',noticeId:'notice-A',kind}),{kind:'generic',serverId:'A',pathname:'/board'});
 }
 assert.deepEqual(notificationOpenTarget({serverId:'A',noticeId:'notice-A',kind:'approval'}),{kind:'approval',serverId:'A',noticeId:'notice-A'});
 for(const value of [{serverId:'A',noticeId:'notice-A'}, {serverId:'A',noticeId:'notice-A',kind:'other'}, {serverId:'A',noticeId:'notice-A',kind:['approval']}, {serverId:'A',noticeId:'notice-A',kind:'task',url:'https://external.invalid'}]) assert.equal(notificationOpenTarget(value),null);
});

import { notificationDemoStatus } from './notificationDemo.ts';
test('all-kind preferences are demonstrable with synthetic capabilities, without adding producers',()=>{
 const value=notificationDemoStatus('all-kinds',1700000000000);
 assert.deepEqual(value.availableKinds,['approval','task','error','server']);
 assert.equal(value.preferences.enabled,true);assert.ok(value.registration);
});
test('a notice is decidable only within 60 s of its local read',async()=>{
 const { noticeCanDecide } = await import('./notifications.ts');
 const notice={state:'pending',expiresAt:null,serverNow:1700000000000} as Parameters<typeof noticeCanDecide>[0];
 assert.equal(noticeCanDecide(notice,1000,60999),true);
 assert.equal(noticeCanDecide(notice,1000,61000),false);
 assert.equal(noticeCanDecide(notice,1000,999),false);
});
