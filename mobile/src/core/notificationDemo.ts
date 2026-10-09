import type { NotificationStatus, NotificationNotice, NotificationPreferences, NotificationDecisionInput, NotificationRegistrationInput } from '../../../protocol/notifications.ts';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../../../protocol/notifications.ts';
import { RelayError } from './client.ts';
export const NOTIFICATION_DEMO_STATES = ['pending','approved','rejected','expired','uncertain','unknown'] as const;
export const NOTIFICATION_SETTINGS_DEMO_STATES = ['configured','all-kinds','unconfigured','permission-denied','unavailable','revoked','protocol'] as const;
export function notificationDemoStatus(state: string, now: number): NotificationStatus {
  return {schema:1,configured:state!=='unconfigured',transport:'ntfy-unifiedpush',availableKinds:state==='all-kinds'?['approval','task','error','server']:['approval'],preferences:{...structuredClone(DEFAULT_NOTIFICATION_PREFERENCES),enabled:state==='all-kinds'},revision:0,registration:state==='all-kinds'?{id:'demo-all-kinds',expiresAt:now+604800000}:null,delivery:'disabled',serverNow:now};
}
export function notificationDemoNotice(state: string, now: number): NotificationNotice {
  const resolved = NOTIFICATION_DEMO_STATES.find(value=>value===state) ?? 'pending';
  const expiresAt = resolved === 'expired' ? now-1000 : now+300000;
  return {schema:1,noticeId:state,registrationId:'demo-registration',kind:'approval',target:{agentId:'coding',runId:'demo-notice-turn',approvalId:'demo-notice-approval'},
    approval:{id:'demo-notice-approval',agentId:'coding',agentName:'Coding',runId:'demo-notice-turn',command:'npm test -- --runInBand',createdAt:now-15000,expiresAt,choices:['once','deny'],risk:{level:1,label:'Comando de demostración',summary:'Prueba sintética de aprobación'},cwd:null,reason:null,affects:null},expiresAt,serverNow:now,state:resolved};
}
export function createNotificationDemoClient(resource: string) {
  let preferences: NotificationPreferences = notificationDemoStatus(resource,0).preferences;
  let revision = 0;
  const status = () => {
    if (resource.includes('revoked')) throw new RelayError('device_revoked','Demostración');
    if (resource.includes('protocol')) throw new RelayError('protocol_upgrade_required','Demostración',426);
    if (resource.includes('unavailable')) throw new RelayError('unavailable','Demostración',503);
    return {...notificationDemoStatus(resource,Date.now()),preferences,revision};
  };
  return {async status(){return status();},async notice(id:string){return notificationDemoNotice(id,Date.now());},
    async register(input:NotificationRegistrationInput){preferences=input.preferences;revision++;return status();},
    async unregister(_revision:number){preferences={...preferences,enabled:false};revision++;return status();},
    async decide(_id:string,input:NotificationDecisionInput):Promise<{ok:true;outcome:'approved'|'rejected'}>{return {ok:true,outcome:input.choice==='once'?'approved':'rejected'};}};
}
