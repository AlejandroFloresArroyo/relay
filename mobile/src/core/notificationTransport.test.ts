import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPrivateNotificationFetch } from './notificationTransport.ts';
const scope={serverId:'A',url:'http://relay.fixture.ts.net:17651',key:'synthetic-private-key',deviceId:'synthetic-device'};
test('notification transport only enters its own native Tailnet boundary, with no public fallback',async()=>{
 const calls:unknown[][]=[];
 const fetcher=createPrivateNotificationFetch(scope,async(...args)=>{calls.push(args);return {status:200,body:'{"schema":1}'};});
 const response=await fetcher(scope.url+'/v1/notifications',{method:'GET'});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{schema:1});
 assert.deepEqual(calls,[[JSON.stringify(scope),'GET','/v1/notifications',null]]);
 await assert.rejects(fetcher('https://ntfy.sh/v1/notifications',{method:'GET'}));
 await assert.rejects(fetcher(scope.url+'/v1/agents',{method:'GET'}));
 assert.equal(calls.length,1);
 const missing=createPrivateNotificationFetch(scope,null);
 await assert.rejects(missing(scope.url+'/v1/notifications',{method:'GET'}));
});
