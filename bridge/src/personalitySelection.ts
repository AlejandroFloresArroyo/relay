import { createHash } from 'node:crypto';
import type { ConversationPersonality, PersonalityPresetVersion } from '../../protocol/personalityPresets.ts';
import { PERSONALITY_OVERLAY_MAX_BYTES, PERSONALITY_PRESET_NAME_MAX_CHARACTERS } from '../../protocol/personalityPresets.ts';
import { exactObject, isTimestamp, isUuid, StateError } from './changeLog.ts';

export interface PersonalitySelectionState {
 revision:string; preset:PersonalityPresetVersion|null; updatedAt:number|null;
 receipts:{deviceId:string;requestId:string;fingerprint:string;result:ConversationPersonality}[];
}
export const personalityHash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const isPersonalityRevision=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function personalitySelection(agentId:string,conversationId:string,selection?:PersonalitySelectionState):ConversationPersonality {
 return {agentId,conversationId,revision:selection?.revision??personalityHash([agentId,conversationId,null]),preset:selection?.preset??null,updatedAt:selection?.updatedAt??null};
}
function validPreset(v:unknown):boolean {
 return exactObject(v,['id','revision','name','kind','bytes','createdAt','updatedAt','content'])&&isUuid(v.id)&&isPersonalityRevision(v.revision)&&v.kind==='overlay'
  &&typeof v.name==='string'&&v.name.trim()===v.name&&Array.from(v.name).length>0&&Array.from(v.name).length<=PERSONALITY_PRESET_NAME_MAX_CHARACTERS&&!/[\x00-\x1f\x7f]/.test(v.name)
  &&typeof v.content==='string'&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v.content)
  &&Buffer.byteLength(v.content)<=PERSONALITY_OVERLAY_MAX_BYTES&&v.bytes===Buffer.byteLength(v.content)&&isTimestamp(v.createdAt)&&isTimestamp(v.updatedAt)&&v.updatedAt>=v.createdAt;
}
export function validatePersonalitySelection(value:unknown,agentId:string,conversationId:string):asserts value is PersonalitySelectionState {
 if(!exactObject(value,['revision','preset','updatedAt','receipts'])||!isPersonalityRevision(value.revision)||value.preset!==null&&!validPreset(value.preset)||!isTimestamp(value.updatedAt)
  ||!Array.isArray(value.receipts)||value.receipts.length<1||value.receipts.length>128)throw new StateError();
 let previous=personalityHash([agentId,conversationId,null]);const identities=new Set<string>();
 for(const receipt of value.receipts) {
  if(!exactObject(receipt,['deviceId','requestId','fingerprint','result'])||!isUuid(receipt.deviceId)||!isUuid(receipt.requestId)||!isPersonalityRevision(receipt.fingerprint))throw new StateError();
  const r=receipt.result;
  if(!exactObject(r,['agentId','conversationId','revision','preset','updatedAt'])||r.agentId!==agentId||r.conversationId!==conversationId||!isPersonalityRevision(r.revision)||!isTimestamp(r.updatedAt)||r.preset!==null&&!validPreset(r.preset))throw new StateError();
  const key=JSON.stringify([receipt.deviceId,receipt.requestId]);if(identities.has(key))throw new StateError();identities.add(key);
  if(r.revision!==personalityHash([previous,receipt.deviceId,receipt.requestId,r.preset,r.updatedAt]))throw new StateError();previous=r.revision;
 }
 const latest=value.receipts.at(-1)!.result;
 if(value.revision!==latest.revision||value.updatedAt!==latest.updatedAt||JSON.stringify(value.preset)!==JSON.stringify(latest.preset))throw new StateError();
}
