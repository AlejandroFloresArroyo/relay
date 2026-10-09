import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNotificationCache, notificationCacheScope, notificationCacheKey } from './notificationCache.ts';
test('polling revocation deletes enrollment metadata even when an older write completes late, including offline remount',async()=>{
 const disk=new Map<string,string>();let release!:()=>void;let entered!:()=>void;
 const wait=new Promise<void>(resolve=>release=resolve);const arrived=new Promise<void>(resolve=>entered=resolve);
 const io={async read(scope:string){return disk.get(scope)??null;},async write(scope:string,value:string){entered();await wait;disk.set(scope,value);},async remove(scope:string){disk.delete(scope);}};
 const cache=createNotificationCache(io);
 const pending=cache.write('server-A/device-A',{revision:1});
 await Promise.race([arrived,new Promise<void>(resolve=>setTimeout(resolve,10))]);
 const purge=cache.revoke('server-A/device-A');release();await pending;await purge;
 const remounted=createNotificationCache(io);assert.equal(await remounted.read('server-A/device-A'),null);assert.equal(disk.size,0);
 await cache.write('server-A/device-A',{revision:2});assert.equal(disk.size,0);
});
test('cache publishes only confirmed writes and keeps different device scopes independent',async()=>{
 const disk=new Map<string,string>();const cache=createNotificationCache({async read(scope:string){return disk.get(scope)??null;},async write(scope:string,value:string){disk.set(scope,value);},async remove(scope:string){disk.delete(scope);}});
 await cache.write('A/device-1',{revision:1});await cache.write('A/device-2',{revision:2});await cache.revoke('A/device-1');
 assert.deepEqual(await cache.read('A/device-2'),{revision:2});assert.equal(await cache.read('A/device-1'),null);
});

test('notification persistence requires a bounded one-way key identity and never accepts a raw key as scope identity',()=>{
 const server={id:'A',url:'http://a.fixture.ts.net:17651',deviceId:'fixture-device-A'};
 const scope=notificationCacheScope(server,'a'.repeat(64));
 assert.notEqual(scope,notificationCacheScope(server,'b'.repeat(64)));
 assert.deepEqual(JSON.parse(scope),['A',server.url,server.deviceId,'a'.repeat(64)]);
 for(const bad of ['fixture-key-A','','a'.repeat(63),'a'.repeat(65),'A'.repeat(64)])assert.throws(()=>notificationCacheScope(server,bad));
 assert.match(notificationCacheKey(scope),/^[a-zA-Z0-9.]+$/);
});
