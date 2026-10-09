import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createNtfyPublisher } from '../src/ntfyTransport.ts';
const ORIGIN='http://ntfy.fixture.ts.net:8080';
const endpoint=ORIGIN+'/upSyntheticCapability123456789?up=1';
const body=JSON.stringify({schema:1,kind:'approval',noticeId:'10000000-0000-4000-8000-000000000001',registrationId:'20000000-0000-4000-8000-000000000001',expiresAt:2000});
test('ntfy pins a Tailnet address and only publishes the generic UnifiedPush envelope without forwarding or redirects',async()=>{
 const sent: Array<{url:URL;address:string;headers:Record<string,string>;body:string}>= [];
 const publish=createNtfyPublisher(ORIGIN,{now:()=>1000,lookup:async()=>[{address:'100.64.0.2',family:4}],send:async(url,address,headers,payload)=>{sent.push({url,address,headers,body:payload});return 200;}});
 await publish(endpoint,body,new AbortController().signal);
 assert.equal(sent.length,1);assert.equal(sent[0].address,'100.64.0.2');
 assert.equal(sent[0].headers['X-UnifiedPush'],'1');assert.equal(sent[0].headers['X-Firebase'],'no');assert.equal(sent[0].headers['X-Cache'],'no');
 assert.equal(sent[0].body,body);assert.equal(sent[0].headers.Authorization,undefined);assert.equal(sent[0].headers['X-Actions'],undefined);
 for(const bad of ['https://ntfy.sh/upSyntheticCapability123456789',ORIGIN+'/upSyntheticCapability123456789?Actions=http',ORIGIN+'/upSyntheticCapability123456789#fragment',ORIGIN+'/../upSyntheticCapability123456789']){
   await assert.rejects(publish(bad,body,new AbortController().signal));
 }
 assert.equal(sent.length,1);
});
test('DNS outside Tailnet, abort during resolution, expired notices and redirect responses cannot cause external publication',async()=>{
 let sends=0;const send=async()=>{sends++;return 200;};
 await assert.rejects(createNtfyPublisher(ORIGIN,{now:()=>1000,lookup:async()=>[{address:'203.0.113.8',family:4}],send})(endpoint,body,new AbortController().signal));
 const controller=new AbortController();
 await assert.rejects(createNtfyPublisher(ORIGIN,{now:()=>1000,lookup:async()=>{controller.abort();return [{address:'100.64.0.2',family:4}];},send})(endpoint,body,controller.signal));
 await assert.rejects(createNtfyPublisher(ORIGIN,{now:()=>2000,lookup:async()=>[{address:'100.64.0.2',family:4}],send})(endpoint,body,new AbortController().signal));
 assert.equal(sends,0);
 const redirects=createNtfyPublisher(ORIGIN,{now:()=>1000,lookup:async()=>[{address:'100.64.0.2',family:4}],send:async()=>{sends++;return 302;}});
 await assert.rejects(redirects(endpoint,body,new AbortController().signal));assert.equal(sends,1);
});
test('payload extensions cannot carry commands or credentials to ntfy',async()=>{
 let sends=0;
 const publish=createNtfyPublisher(ORIGIN,{now:()=>1000,lookup:async()=>[{address:'100.64.0.2',family:4}],send:async()=>{sends++;return 200;}});
 await assert.rejects(publish(endpoint,JSON.stringify({...JSON.parse(body),command:'synthetic-canary',key:'synthetic-key'}),new AbortController().signal));
 assert.equal(sends,0);
});

test('an interrupted ntfy response is not a successful publication and suppresses network error contents',async t=>{
 const response=new PassThrough() as PassThrough & {statusCode:number};response.statusCode=200;
 // The fake network boundary observes an error without crashing the test process.
 response.on('error',()=>{});
 t.mock.method(http,'request',((_options:unknown,listener:(response:unknown)=>void)=>{
   const request=new EventEmitter() as EventEmitter & {end:(body:string)=>void};
   request.end=()=>queueMicrotask(()=>{listener(response);response.emit('error',new Error('synthetic-network-secret'));});
   return request;
 }) as unknown as typeof http.request);
 const publish=createNtfyPublisher(ORIGIN,{now:()=>1000,lookup:async()=>[{address:'100.64.0.2',family:4}]});
 await assert.rejects(publish(endpoint,body,new AbortController().signal),error=>error instanceof Error && !error.message.includes('synthetic-network-secret'));
});
