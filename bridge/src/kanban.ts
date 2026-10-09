import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import type * as p from '../../protocol/kanban.ts';
import { KANBAN_COLUMNS, KANBAN_MAX_ITEMS, KANBAN_MAX_RECEIPTS, KANBAN_MAX_COMMENTS, KANBAN_MAX_COMMENTS_PER_ITEM, KANBAN_PAGE_DEFAULT_LIMIT, KANBAN_PAGE_MAX_LIMIT, KANBAN_CURSOR_MAX_CHARS } from '../../protocol/kanban.ts';
import { isUuid, exactObject, type ChangeInput } from './changeLog.ts';
import type { KanbanStore, KanbanData, StoredReceipt } from './kanbanStore.ts';
import { HermesError } from './hermes.ts';
import { AgentDetailsError } from './agentDetailsError.ts';
import { KanbanError, invalid, unavailable, parseMutation, digest, itemRevision, graph, column, timestamp } from './kanbanValidation.ts';
export { KanbanError } from './kanbanValidation.ts';
const conflict=()=>new KanbanError('kanban_conflict');
const fingerprint=(kind:StoredReceipt['kind'],resource:string,body:Record<string,unknown>)=>digest([kind,resource,Object.keys(body).sort().map(key=>[key,body[key]])]);
export interface KanbanNotifications {
  admit<T>(operation: (guard: () => void) => Promise<T>, authorize: () => void): Promise<T>;
  start(agentId: string, input: string, key: string, actor: p.KanbanDeviceAuthor, guard: () => void,
    conversation: (id: string) => Promise<void>, accepted: (conversationId: string, runId: string) => Promise<void>): Promise<void>;
  observe(agentId: string, conversationId: string, runId: string): Promise<p.KanbanTurnObservation | null>;
}
interface Options { store: KanbanStore; now?: () => number; agentExists: (id: string) => Promise<boolean>; notifications?: KanbanNotifications }
export class Kanban {
  private readonly store: KanbanStore;
  private readonly now: () => number;
  private readonly agentExists: Options['agentExists'];
  private readonly notifications: KanbanNotifications | undefined;
  private readonly cursorKey=randomBytes(32);
  constructor(options: Options) { this.store=options.store; this.now=options.now ?? Date.now; this.agentExists=options.agentExists; this.notifications=options.notifications; }
  private at(): number { const at=this.now(); if (!timestamp(at)) throw unavailable(); return at; }
  private item(data: KanbanData,id: string): p.KanbanItem {
    if (!isUuid(id)) throw invalid(); const item=data.items.find(item=>item.id===id); if (!item) throw new KanbanError('kanban_not_found'); return item;
  }
  private replay(data: KanbanData,body: {requestId:string},actor: p.KanbanDeviceAuthor,kind: StoredReceipt['kind'],id: string): StoredReceipt | undefined {
    const expected=fingerprint(kind,id,body);
    const receipt=data.receipts.find(r=>r.deviceId===actor.id && r.requestId===body.requestId);
    if (receipt && receipt.fingerprint!==expected) throw conflict();
    return receipt;
  }
  private save(data: KanbanData,body: {requestId:string},actor: p.KanbanDeviceAuthor,kind: StoredReceipt['kind'],id: string,result: StoredReceipt['result'],resource=id): void {
    if (data.receipts.length>=KANBAN_MAX_RECEIPTS) throw new KanbanError('kanban_store_full');
    data.receipts.push({deviceId:actor.id,requestId:body.requestId,fingerprint:fingerprint(kind,resource,body),kind,itemId:id,result:structuredClone(result)});
  }
  private audit(actor: p.KanbanDeviceAuthor,action: string,itemId: string,requestId: string): ChangeInput {
    return {actor,action,target:{kind:'server',id:'local'},details:{itemId,requestId}};
  }
  private async checkAgent(body: Record<string,unknown>,guard: ()=>void): Promise<void> {
    guard(); if (typeof body.agentId==='string') { const exists=await this.agentExists(body.agentId); guard(); if (!exists) throw new KanbanError('kanban_agent_unavailable'); }
  }
  async create(value: unknown,actor: p.KanbanDeviceAuthor,guard: ()=>void): Promise<p.KanbanItemMutationResult> {
    guard(); const body=parseMutation('create',value);
    const data=await this.store.read(guard); guard(); const previous=this.replay(data,body,actor,'create','items');
    if (previous) return previous.result as p.KanbanItemMutationResult;
    await this.checkAgent(body,guard); guard();
    return this.store.mutate((draft,audit)=>{
      const replay=this.replay(draft,body,actor,'create','items'); if (replay) return replay.result as p.KanbanItemMutationResult;
      if (draft.items.length>=KANBAN_MAX_ITEMS || !Number.isSafeInteger(draft.nextNumber+1)) throw new KanbanError('kanban_store_full');
      const at=this.at(); const item: p.KanbanItem={id:randomUUID(),number:draft.nextNumber++,title:body.title as string,agentId:body.agentId as string|null,column:body.column as p.KanbanColumn,blockedBy:body.blockedBy as string[],commentCount:0,createdAt:at,updatedAt:at,revision:''};
      item.revision=itemRevision(item); draft.items.push(item); graph(draft.items);
      if (item.column==='blocked' && !item.blockedBy.length) throw invalid();
      const result={requestId:body.requestId,item}; this.save(draft,body,actor,'create',item.id,result,'items'); audit(this.audit(actor,'kanban.create.succeeded',item.id,body.requestId)); return result;
    },guard);
  }
  async update(id: string,value: unknown,actor: p.KanbanDeviceAuthor,guard: ()=>void): Promise<p.KanbanItemMutationResult> {
    guard(); if (!isUuid(id)) throw invalid(); const body=parseMutation('update',value);
    const data=await this.store.read(guard); guard(); const previous=this.replay(data,body,actor,'update',id); if (previous) return previous.result as p.KanbanItemMutationResult;
    await this.checkAgent(body,guard); guard();
    return this.store.mutate((draft,audit)=>{
      const replay=this.replay(draft,body,actor,'update',id); if (replay) return replay.result as p.KanbanItemMutationResult;
      const item=this.item(draft,id); if (item.revision!==body.revision) throw conflict();
      for (const key of ['title','agentId','column','blockedBy'] as const) if (Object.hasOwn(body,key)) Object.assign(item,{[key]:body[key]});
      if (item.column==='blocked' && !item.blockedBy.length) throw invalid(); graph(draft.items);
      item.updatedAt=Math.max(item.updatedAt,this.at()); item.revision=itemRevision(item);
      const result={requestId:body.requestId,item}; this.save(draft,body,actor,'update',id,result); audit(this.audit(actor,'kanban.update.succeeded',id,body.requestId)); return result;
    },guard);
  }
  async comment(id: string,value: unknown,actor: p.KanbanDeviceAuthor,guard: ()=>void): Promise<p.KanbanCommentMutationResult> {
    guard(); if (!isUuid(id)) throw invalid(); const body=parseMutation('comment',value);
    await this.store.read(guard); guard();
    return this.store.mutate((draft,audit)=>{
      const replay=this.replay(draft,body,actor,'comment',id); if (replay) return replay.result as p.KanbanCommentMutationResult;
      const item=this.item(draft,id); if (item.revision!==body.revision) throw conflict();
      if (item.commentCount>=KANBAN_MAX_COMMENTS_PER_ITEM || draft.comments.length>=KANBAN_MAX_COMMENTS) throw new KanbanError('kanban_store_full');
      const at=Math.max(item.updatedAt,this.at()),comment:p.KanbanComment={id:randomUUID(),number:++item.commentCount,author:actor,text:body.text as string,createdAt:at};
      draft.comments.push({itemId:id,comment}); item.updatedAt=at; item.revision=itemRevision(item);
      const result={requestId:body.requestId,item,comment}; this.save(draft,body,actor,'comment',id,result); audit(this.audit(actor,'kanban.comment.succeeded',id,body.requestId)); return result;
    },guard);
  }
  async detail(id: string,actor: p.KanbanDeviceAuthor,guard: ()=>void): Promise<p.KanbanItemDetail> {
    await this.store.read(guard); guard(); await this.observe(id,guard); guard();
    const data=this.store.snapshot(); const item=this.item(data,id);
    const dependency=(item:p.KanbanItem):p.KanbanDependency=>({id:item.id,number:item.number,title:item.title,column:item.column});
    const receipts=data.receipts.filter(r=>r.kind==='notify' && r.itemId===id && r.deviceId===actor.id);
    return {item,blockers:item.blockedBy.map(id=>dependency(this.item(data,id))),blocks:data.items.filter(i=>i.blockedBy.includes(id)).map(dependency),latestNotification:receipts.length ? receipts.at(-1)!.result as p.KanbanNotifyReceipt : null,observedAt:this.at()};
  }
  private dependencyAdmission(data: KanbanData, id: string, expected?: string, agent?: string): void {
    const item=this.item(data,id);
    if (expected!==undefined && item.revision!==expected || agent!==undefined && item.agentId!==agent) throw conflict();
    if (item.column==='blocked' || item.blockedBy.some(id=>this.item(data,id).column!=='done')) throw new KanbanError('kanban_dependency_blocked');
  }
  private terminal(receipt: p.KanbanNotifyReceipt): boolean {
    return receipt.state==='rejected' || receipt.state==='started' && receipt.turn!==null && ['completed','failed','cancelled'].includes(receipt.turn.phase);
  }
  private async observe(id: string,guard:()=>void): Promise<void> {
    const candidates=this.store.snapshot().receipts.filter(r=>r.kind==='notify' && r.itemId===id && (r.result as p.KanbanNotifyReceipt).state==='started' && !this.terminal(r.result as p.KanbanNotifyReceipt));
    for (const r of candidates) {
      const old=r.result as Extract<p.KanbanNotifyReceipt,{state:'started'}>;
      guard(); const turn=await this.notifications?.observe(old.agentId,old.conversationId,old.runId) ?? null; guard();
      if (turn===null || old.turn?.phase===turn.phase) continue;
      await this.store.mutate(draft=>{
        const current=draft.receipts.find(row=>row.deviceId===r.deviceId && row.requestId===r.requestId)!;
        const result=current.result as p.KanbanNotifyReceipt;
        if (current.kind==='notify' && result.state==='started' && !this.terminal(result)) current.result={...result,turn,updatedAt:Math.max(result.updatedAt,this.at())};
      },guard); guard();
    }
  }
  async notification(id:string,requestId:string,actor:p.KanbanDeviceAuthor,guard:()=>void): Promise<p.KanbanNotifyReceipt> {
    const data=await this.store.read(guard); guard(); this.item(data,id);
    const receipt=data.receipts.find(r=>r.kind==='notify' && r.itemId===id && r.requestId===requestId && r.deviceId===actor.id);
    if (!receipt) throw new KanbanError('kanban_not_found');
    await this.observe(id,guard); guard();
    return this.store.snapshot().receipts.find(r=>r.kind==='notify' && r.requestId===requestId && r.deviceId===actor.id)!.result as p.KanbanNotifyReceipt;
  }
  async notify(id:string,value:unknown,actor:p.KanbanDeviceAuthor,authorize:()=>void): Promise<p.KanbanNotifyReceipt> {
    authorize(); if (!isUuid(id)) throw invalid(); const body=parseMutation('notify',value);
    const data=await this.store.read(authorize); authorize();
    const previous=this.replay(data,body,actor,'notify',id); if (previous) return previous.result as p.KanbanNotifyReceipt;
    if (!this.notifications) throw new KanbanError('kanban_agent_unavailable');
    this.dependencyAdmission(data,id,body.revision as string,body.agentId as string);
    await this.observe(id,authorize); authorize();
    try { return await this.notifications.admit(async admission=>{
      admission(); await this.checkAgent(body,admission); admission();
      const reservation=await this.store.mutate((draft,audit)=>{
        const replay=this.replay(draft,body,actor,'notify',id); if (replay) return {owner:false,receipt:replay.result as p.KanbanNotifyReceipt};
        this.dependencyAdmission(draft,id,body.revision as string,body.agentId as string);
        if (draft.receipts.some(r=>r.kind==='notify' && r.itemId===id && !this.terminal(r.result as p.KanbanNotifyReceipt))) throw new KanbanError('kanban_notification_busy');
        const at=this.at(); const receipt:p.KanbanNotifyReceipt={requestId:body.requestId,itemId:id,itemRevision:body.revision as string,agentId:body.agentId as string,requestedBy:actor,requestedAt:at,updatedAt:at,state:'pending',conversationId:null,runId:null,errorCode:null};
        this.save(draft,body,actor,'notify',id,receipt); audit(this.audit(actor,'kanban.notify.requested',id,body.requestId)); return {owner:true,receipt};
      },admission);
      if (!reservation.owner) { authorize(); return reservation.receipt; }
      let receipt=reservation.receipt;
      const guard=()=>{admission(); this.dependencyAdmission(this.store.snapshot(),id,body.revision as string,body.agentId as string);};
      // Recording the outcome of an already authorized effect is not new permission. In particular,
      // preserve returned IDs if revocation/pause happens during an upstream await, then reject response.
      const record=async(next:p.KanbanNotifyReceipt,action?:string)=>{
        await this.store.mutate((draft,audit)=>{
          const stored=draft.receipts.find(r=>r.deviceId===actor.id && r.requestId===body.requestId)!;
          stored.result=next; if (action) audit(this.audit(actor,action,id,body.requestId));
        },()=>{}); receipt=next;
      };
      try {
        guard();
        await this.notifications!.start(body.agentId as string,body.input as string,digest([actor.id,id,body.requestId]),actor,guard,
          async conversationId=>{ await record({...receipt,conversationId,updatedAt:Math.max(receipt.updatedAt,this.at())}); guard(); },
          async(conversationId,runId)=>{ await record({...receipt,state:'started',conversationId,runId,errorCode:null,turn:null,updatedAt:Math.max(receipt.updatedAt,this.at())},'kanban.notify.accepted'); guard(); });
        authorize();
      } catch(error) {
        if (receipt.state!=='started') {
          const code=error instanceof KanbanError ? error.code : error instanceof HermesError || error instanceof AgentDetailsError ? error.code : null;
          const rejected:p.KanbanNotifyRejection | null=code==='server_paused'?'server_paused':code==='kanban_dependency_blocked'?'dependency_blocked'
            : code==='kanban_conflict' || code==='agent_security_conflict' || code==='agent_security_read_only' || code==='agent_security_invalid' ? 'configuration_conflict'
            : code==='kanban_agent_unavailable' || code==='chat_unavailable' ? 'agent_unavailable'
            : code==='bad_request' || code==='conflict' ? 'upstream_rejected'
            : code==='conversation_read_only' || code==='conversation_not_found' || code==='conversation_busy' ? 'conversation_unavailable' : null;
          const at=Math.max(receipt.updatedAt,this.at());
          const next:p.KanbanNotifyReceipt=rejected ? {...receipt,state:'rejected',runId:null,errorCode:rejected,updatedAt:at}
            : {...receipt,state:'uncertain',runId:null,errorCode:'kanban_notification_uncertain',updatedAt:at};
          await record(next,`kanban.notify.${rejected?'rejected':'uncertain'}`);
        }
        authorize();
      }
      authorize(); return receipt;
    },authorize); } catch(error) {
      if (error instanceof HermesError && error.code==='server_paused') throw new KanbanError('server_paused');
      throw error;
    }
  }
  private page(query:p.KanbanPageQuery,scope:string,revision:string): {limit:number;offset:number;next:(offset:number)=>string} {
    const limit=query.limit ?? KANBAN_PAGE_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit<1 || limit>KANBAN_PAGE_MAX_LIMIT) throw invalid();
    let offset=0;
    if (query.cursor!==undefined) {
      if (typeof query.cursor!=='string' || query.cursor.length>KANBAN_CURSOR_MAX_CHARS || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw invalid();
      try {
        const bytes=Buffer.from(query.cursor,'base64url'); if (bytes.toString('base64url')!==query.cursor || bytes.length<33) throw invalid();
        const payload=bytes.subarray(0,-32), mac=bytes.subarray(-32); if (!timingSafeEqual(mac,createHmac('sha256',this.cursorKey).update(payload).digest())) throw conflict();
        const decoded:unknown=JSON.parse(payload.toString());
        if (!exactObject(decoded,['s','r','o','l']) || decoded.s!==scope || decoded.l!==limit || decoded.r!==revision || !Number.isSafeInteger(decoded.o) || Number(decoded.o)<1) throw conflict();
        offset=Number(decoded.o);
      } catch(error) { if (error instanceof KanbanError) throw error; throw invalid(); }
    }
    return {limit,offset,next:o=>{const payload=Buffer.from(JSON.stringify({s:scope,r:revision,o,l:limit}));return Buffer.concat([payload,createHmac('sha256',this.cursorKey).update(payload).digest()]).toString('base64url');}};
  }
  async list(query:p.KanbanItemsQuery,actor:p.KanbanDeviceAuthor,guard:()=>void): Promise<p.KanbanItemsPage> {
    if (!exactObject(query,[],['column','cursor','limit']) || query.column!==undefined && !column(query.column)) throw invalid();
    const data=await this.store.read(guard); guard(); const revision=digest(data.items);
    const page=this.page(query,JSON.stringify(['items',actor.id,query.column??null]),revision);
    const counts=Object.fromEntries(KANBAN_COLUMNS.map(c=>[c,data.items.filter(item=>item.column===c).length])) as Record<p.KanbanColumn,number>;
    const items=data.items.filter(i=>query.column===undefined || i.column===query.column).sort((a,b)=>b.createdAt-a.createdAt || (a.id<b.id?-1:a.id>b.id?1:0));
    return {items:items.slice(page.offset,page.offset+page.limit),counts,revision,observedAt:this.at(),nextCursor:page.offset+page.limit<items.length?page.next(page.offset+page.limit):null};
  }
  async comments(id:string,query:p.KanbanPageQuery,actor:p.KanbanDeviceAuthor,guard:()=>void): Promise<p.KanbanCommentsPage> {
    if (!exactObject(query,[],['cursor','limit'])) throw invalid();
    const data=await this.store.read(guard); guard(); const item=this.item(data,id),page=this.page(query,JSON.stringify(['comments',actor.id,id]),item.revision);
    const comments=data.comments.filter(row=>row.itemId===id).map(row=>row.comment);
    return {comments:comments.slice(page.offset,page.offset+page.limit),itemRevision:item.revision,observedAt:this.at(),nextCursor:page.offset+page.limit<comments.length?page.next(page.offset+page.limit):null};
  }
}
export function kanbanQuery(parameters: URLSearchParams,items:boolean): p.KanbanItemsQuery {
  const query:p.KanbanItemsQuery={};
  for (const [key,value] of parameters) {
    if (!(items?['column','cursor','limit']:['cursor','limit']).includes(key) || parameters.getAll(key).length!==1) throw invalid();
    if (key==='column') { if (!column(value)) throw invalid(); query.column=value; }
    if (key==='cursor') { if (!value || value.length>KANBAN_CURSOR_MAX_CHARS || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid(); query.cursor=value; }
    if (key==='limit') { if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value)>KANBAN_PAGE_MAX_LIMIT) throw invalid(); query.limit=Number(value); }
  }
  return query;
}
