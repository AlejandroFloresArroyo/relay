import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { NOTIFICATION_KINDS } from '../../protocol/notifications.ts';
import { exactObject, isTimestamp, isUuid } from './changeLog.ts';
import { HermesError } from './hermes.ts';
import { notificationEndpoint, notificationOrigin, type NotificationPublisher } from './notifications.ts';
import { isTailscaleIp } from './tailnet.ts';
interface Options {
 now?:()=>number;
 lookup?:(host:string)=>Promise<Array<{address:string;family:number}>>;
 send?:(url:URL,address:string,headers:Record<string,string>,body:string,signal:AbortSignal)=>Promise<number>;
}
function unavailable(): never { throw new HermesError('upstream','No se pudo publicar el Aviso privado. Reintenta.'); }
function send(url:URL,address:string,headers:Record<string,string>,body:string,signal:AbortSignal): Promise<number> {
 return new Promise((resolve,reject)=>{
  // Dial the already-verified IP directly: no second DNS lookup or redirect following.
  const request=(url.protocol === 'https:' ? https : http).request({
    hostname:address, port:url.port || (url.protocol === 'https:' ? 443 : 80), servername:url.hostname,
    path:url.pathname+url.search,method:'POST',headers:{...headers,Host:url.host,'Content-Length':Buffer.byteLength(body)},signal,agent:false,
  },response=>{
    response.once('error',()=>reject(new HermesError('upstream','No se pudo publicar el Aviso privado. Reintenta.')));
    response.once('aborted',()=>reject(new HermesError('upstream','No se pudo publicar el Aviso privado. Reintenta.')));
    response.once('end',()=>resolve(response.statusCode ?? 0));
    response.resume();
  });
  request.once('error',()=>reject(new HermesError('upstream','No se pudo publicar el Aviso privado. Reintenta.')));
  request.end(body);
 });
}
export function createNtfyPublisher(originValue:string,options:Options = {}): NotificationPublisher {
 const origin=notificationOrigin(originValue);
 const resolve=options.lookup ?? (host=>lookup(host,{all:true}));
 const transmit=options.send ?? send;
 const now=options.now ?? Date.now;
 return async(endpoint,body,signal)=>{
  try {
   const url=new URL(notificationEndpoint(endpoint,origin));
   if(Buffer.byteLength(body)>1024) unavailable();
   const envelope:unknown=JSON.parse(body);
   if(!exactObject(envelope,['schema','kind','noticeId','registrationId','expiresAt']) || envelope.schema !== 1
     || !NOTIFICATION_KINDS.includes(envelope.kind as never) || !isUuid(envelope.noticeId) || !isUuid(envelope.registrationId)
     || !(envelope.expiresAt === null || isTimestamp(envelope.expiresAt))) unavailable();
   const bounded=AbortSignal.any([signal,AbortSignal.timeout(5000)]);
   const addresses=await Promise.race([resolve(url.hostname),new Promise<never>((_resolve,reject)=>{
     if(bounded.aborted) reject(new Error());
     else bounded.addEventListener('abort',()=>reject(new Error()),{once:true});
   })]);
   if(!addresses.length || addresses.some(item=>!isTailscaleIp(item.address))) unavailable();
   bounded.throwIfAborted();
   if(envelope.expiresAt !== null && Number(envelope.expiresAt) <= now()) unavailable();
   const status=await transmit(url,addresses[0].address,{'Content-Type':'application/octet-stream','X-UnifiedPush':'1','X-Firebase':'no','X-Cache':'no'},body,bounded);
   if(status < 200 || status >= 300) unavailable();
  } catch { unavailable(); }
 };
}
