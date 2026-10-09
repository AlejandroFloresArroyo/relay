import { RelayError } from './client.ts';
export interface PrivateNotificationScope {serverId:string;url:string;key:string;deviceId:string}
export type NativeNotificationRequest = (scope:string,method:string,path:string,body:string|null)=>Promise<{status:number;body:string}>;
/** No JS network fallback: DNS pinning and final socket guards belong to the native boundary. */
export function createPrivateNotificationFetch(scope:PrivateNotificationScope, request:NativeNotificationRequest|null):typeof fetch {
  return async(input,options)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    const method=options?.method ?? 'GET';
    const path=url.pathname;
    const allowed=(method==='GET' && (path==='/v1/notifications' || /^\/v1\/notifications\/notices\/[A-Za-z0-9-]{1,1000}$/.test(path)))
      || (['PUT','DELETE'].includes(method) && path==='/v1/notifications/registration')
      || (method==='POST' && /^\/v1\/notifications\/notices\/[A-Za-z0-9-]{1,1000}\/decision$/.test(path));
    if (!request || url.origin!==new URL(scope.url).origin || url.username || url.password || url.search || url.hash || !allowed || options?.signal?.aborted)
      throw new RelayError('unavailable','El transporte privado de Avisos no está disponible.');
    const response=await request(JSON.stringify(scope),method,path,typeof options?.body==='string'?options.body:null);
    return {ok:response.status>=200 && response.status<300,status:response.status,json:async()=>JSON.parse(response.body)} as Response;
  };
}
