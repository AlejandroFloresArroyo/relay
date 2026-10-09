import { createHash } from 'node:crypto';
import { notificationCacheScope as cacheScope } from '@/core/notificationCache';
import { controlledFetch } from './transport';
import type { NotificationNative } from '@/native/notifications';
async function request(raw:string,method:string,path:string,body:string|null) {
 const scope=JSON.parse(raw) as {url:string;key:string};
 const response=await controlledFetch(scope.url+path,{method,headers:{Authorization:`Bearer ${scope.key}`,'X-Relay-Protocol':'2','X-Relay-Notifications':'1'},...(body ? {body}: {})});
 return {status:response.status,body:JSON.stringify(await response.json())};
}
export const notificationNative: jest.Mocked<NotificationNative> = {
  cacheIdentity:jest.fn((key:string)=>createHash('sha256').update('relay.notifications.cache.v2\0').update(key).digest('hex')),
  request:jest.fn(request),invalidateRequests:jest.fn(),
  permission: jest.fn(()=>false), requestPermission: jest.fn(async()=>({granted:false})),
  distributors: jest.fn(()=>[{packageName:'io.heckel.ntfy',label:'ntfy privado'}]),
  reconcile: jest.fn(), status: jest.fn((_serverId:string)=>({generation:1,state:'endpoint',endpoint:'http://ntfy.fixture.ts.net/upSyntheticEndpoint123?up=1',distributor:'io.heckel.ntfy'})),
  begin: jest.fn((_raw:string,_distributor:string)=>({generation:1,state:'endpoint',endpoint:'http://ntfy.fixture.ts.net/upSyntheticEndpoint123?up=1',distributor:'io.heckel.ntfy'})),
  commit: jest.fn(), forget: jest.fn(), forgetIfCurrent:jest.fn(), clearNotice:jest.fn(), takeOpen: jest.fn(()=>null),
};
export function resetNotifications() {
  notificationNative.cacheIdentity.mockReset().mockImplementation((key:string)=>createHash('sha256').update('relay.notifications.cache.v2\0').update(key).digest('hex'));
  notificationNative.request.mockReset().mockImplementation(request);notificationNative.invalidateRequests.mockReset();
  notificationNative.permission.mockReset().mockReturnValue(false);
  notificationNative.requestPermission.mockReset().mockResolvedValue({granted:false});
  notificationNative.distributors.mockReset().mockReturnValue([{packageName:'io.heckel.ntfy',label:'ntfy privado'}]);
  notificationNative.status.mockReset().mockReturnValue({generation:1,state:'endpoint',endpoint:'http://ntfy.fixture.ts.net/upSyntheticEndpoint123?up=1',distributor:'io.heckel.ntfy'});
  notificationNative.begin.mockReset().mockImplementation(()=>notificationNative.status('A'));
  for(const key of ['reconcile','commit','forget','takeOpen','clearNotice'] as const) notificationNative[key].mockReset();
  notificationNative.takeOpen.mockReturnValue(null);
  notificationNative.forgetIfCurrent.mockReset().mockImplementation((raw,generation)=>{
    const id=JSON.parse(raw).serverId as string;const status=notificationNative.status(id);
    if(status.generation!==generation && !(status.generation===generation+1 && status.state==='missing'))return false;
    notificationNative.forget(id);return true;
  });
}

export function notificationCacheScope(server: {id:string;url:string;deviceId?:string;key:string}): string {
 return cacheScope(server, notificationNative.cacheIdentity(server.key));
}
