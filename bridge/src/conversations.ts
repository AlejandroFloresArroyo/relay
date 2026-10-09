import { randomUUID } from 'node:crypto';
import type { Conversation, ConversationDeletionPreview, ConversationDeleted, ConversationPage, ConversationQuery, ConversationSearchPage, ConversationSearchQuery, ModelSelection, RunRequest } from '../../protocol/protocol.ts';
import type { ConversationReceipt, ConversationWritePort, HermesChat, RunActivityPort, RunContext, StoredConversation, PreparedRunRequest } from './chatPorts.ts';
import type { ConversationActor, ConversationDeletion, DurableConversationStore } from './conversationStore.ts';
import { HermesError } from './hermes.ts';
import type { ConversationPersonality } from '../../protocol/personalityPresets.ts';
import { PersonalityCatalog, PersonalityError } from './personalityCatalog.ts';
import { isPersonalityRevision, personalityHash, personalitySelection } from './personalitySelection.ts';
import { exactObject, isUuid } from './changeLog.ts';
import { AuthorizationError } from './auth.ts';

const ORIGIN_LABELS: Record<string, string> = { discord: 'Discord', cli: 'Terminal', terminal: 'Terminal', api_server: 'API de Hermes', telegram: 'Telegram', slack: 'Slack', whatsapp: 'WhatsApp', cron: 'Tarea programada', subagent: 'Subagente', tool: 'Subagente', kanban: 'Kanban' };
export interface ConversationServiceOptions { hermes: HermesChat; store: DurableConversationStore; runs: RunActivityPort; now?: () => number; newId?: () => string; presets?:PersonalityCatalog }
export class ConversationService implements ConversationWritePort {
  private options: ConversationServiceOptions;
  private reservations = new Set<string>();
  private creations = new Map<string, Promise<Conversation>>();
  constructor(options: ConversationServiceOptions) { this.options = options; }

  ownsSession(agentId: string, sessionId: string): boolean {
    return this.options.store.snapshot().conversations.some(receipt => receipt.agentId === agentId && receipt.sessionIds.includes(sessionId));
  }
  private receipt(agentId: string, id: string): ConversationReceipt | undefined {
    return this.options.store.snapshot().conversations.find((receipt) => receipt.agentId === agentId && receipt.id === id);
  }
  private dto(agentId: string, stored: StoredConversation): Conversation {
    const receipt = this.receipt(agentId, stored.id);
    const owned = receipt !== undefined && receipt.state !== 'creating';
    const deleting = this.options.store.snapshot().deletions.some((plan) => plan.agentId === agentId && plan.sessionIds.includes(stored.id));
    return { id: stored.id, sessionId: stored.sessionId, title: stored.title, source: stored.createdSource ?? stored.source,
      origin: owned ? 'relay' : 'external', originLabel: owned ? 'Relay' : ORIGIN_LABELS[stored.createdSource ?? stored.source] ?? 'Otro canal',
      kind: stored.kind, writable: owned && receipt.state === 'ready' && !deleting && !stored.continuationUncertain, archived: stored.archived, hidden: stored.hidden,
      state: deleting || receipt?.state === 'deleting' ? 'deleting' : 'ready', startedAt: stored.startedAt, lastActiveAt: stored.lastActiveAt,
      messageCount: stored.messageCount, preview: stored.preview, model: receipt?.model ?? null };
  }
  async list(agentId: string, query: ConversationQuery): Promise<ConversationPage> {
    const page = await this.options.hermes.listConversations(agentId, query);
    return { conversations: page.conversations.map((stored) => this.dto(agentId, stored)), nextOffset: page.nextOffset };
  }
  async get(agentId: string, id: string): Promise<Conversation> {
    const stored = await this.options.hermes.getConversation(agentId, id);
    if (!stored) throw new HermesError('conversation_not_found', 'La Conversación ya no existe.');
    return this.dto(agentId, stored);
  }
  async search(agentId: string, query: ConversationSearchQuery): Promise<ConversationSearchPage> {
    const page = await this.options.hermes.searchConversations(agentId, query);
    return { hits: page.hits.map((hit) => ({ ...hit, conversation: this.dto(agentId, hit.conversation) })), nextOffset: page.nextOffset };
  }
  create(agentId: string, requestId: string, actor: ConversationActor, guard: () => void): Promise<Conversation> {
    const key = JSON.stringify([agentId, actor.id, requestId]);
    const pending = this.creations.get(key);
    if (pending) return pending;
    const operation = this.createOnce(agentId, requestId, actor, guard).finally(() => { this.creations.delete(key); });
    this.creations.set(key, operation); return operation;
  }
  private async createOnce(agentId: string, requestId: string, actor: ConversationActor, guard: () => void): Promise<Conversation> {
    const state = this.options.store.snapshot();
    if (state.deletedRequests.some((entry) => entry.agentId === agentId && entry.deviceId === actor.id && entry.requestId === requestId)) {
      throw new HermesError('request_conflict', 'Esta solicitud corresponde a una Conversación borrada.');
    }
    const previous = state.conversations.find((receipt) => receipt.agentId === agentId && receipt.createdByDeviceId === actor.id && receipt.createRequestId === requestId);
    if (previous) {
      if (previous.state === 'creating') throw new HermesError('operation_uncertain', 'La creación quedó sin confirmar. No se repetirá la solicitud.');
      if (previous.state === 'deleting') throw new HermesError('request_conflict', 'La Conversación se está borrando.');
      return this.get(agentId, previous.id);
    }
    const id = `relay_${(this.options.newId ?? randomUUID)()}`;
    guard();
    await this.options.store.mutate((draft, addChange) => {
      draft.conversations.push({ agentId, id, createdAt: (this.options.now ?? Date.now)(), createdByDeviceId: actor.id, createRequestId: requestId, state: 'creating', sessionIds: [id], model: null });
      addChange({ actor, action: 'conversation.create.requested', target: { kind: 'conversation', id: JSON.stringify([agentId, id]) } });
    });
    let sent = false;
    try {
      guard(); sent = true;
      await this.options.hermes.createConversation(agentId, id);
    } catch (error) {
      const definitive = !sent || error instanceof HermesError && ['bad_request', 'conflict', 'invalid_request', 'invalid_title', 'request_conflict', 'unavailable'].includes(error.code);
      await this.options.store.mutate((draft, addChange) => {
        if (definitive) draft.conversations = draft.conversations.filter((receipt) => receipt.agentId !== agentId || receipt.id !== id);
        addChange({ actor, action: definitive ? 'conversation.create.failed' : 'conversation.create.uncertain', target: { kind: 'conversation', id: JSON.stringify([agentId, id]) } });
      });
      throw error;
    }
    // A confirmed upstream success becomes permission only after this durable commit.
    await this.options.store.mutate((draft, addChange) => {
      const receipt = draft.conversations.find((entry) => entry.agentId === agentId && entry.id === id)!;
      receipt.state = 'ready';
      addChange({ actor, action: 'conversation.create.succeeded', target: { kind: 'conversation', id: JSON.stringify([agentId, id]) } });
    });
    return this.get(agentId, id);
  }

  private async reserve<T>(agentId: string, id: string, operation: () => Promise<T>, allowActive = false): Promise<T> {
    const key = JSON.stringify([agentId, id]);
    if (this.reservations.has(key) || !allowActive && this.options.runs.activeForConversation(agentId, id)) throw new HermesError('conversation_busy', 'La Conversación tiene un Turno en marcha.');
    this.reservations.add(key);
    try { return await operation(); }
    finally { this.reservations.delete(key); }
  }
  async assertWritable(agentId: string, id: string): Promise<RunContext> {
    const stored = await this.options.hermes.getConversation(agentId, id);
    if (!stored) throw new HermesError('conversation_not_found', 'La Conversación ya no existe.');
    const receipt = this.receipt(agentId, stored.id);
    if (receipt?.state === 'creating') throw new HermesError('operation_uncertain', 'La creación de esta Conversación quedó sin confirmar.');
    if (stored.continuationUncertain) throw new HermesError('operation_uncertain', 'Hermes tiene más de una continuación posible; abre una Conversación nueva.');
    if (!this.dto(agentId, stored).writable) throw new HermesError('conversation_read_only', 'Esta Conversación nació fuera de Relay; ábrela en solo lectura.');
    return { agentId, conversationId: stored.id, sessionId: stored.sessionId };
  }
  async withConversationWrite<T>(agentId: string, id: string | null, operation: (context: RunContext) => Promise<T>): Promise<T> {
    if (id === null) throw new HermesError('invalid_request', 'Primero crea una Conversación.');
    const context = await this.assertWritable(agentId, id);
    return this.reserve(agentId, context.conversationId, async () => operation(await this.assertWritable(agentId, context.conversationId)));
  }
  async setModel(agentId: string, id: string, model: ModelSelection | null, actor: ConversationActor, guard: () => void): Promise<Conversation> {
    const initial = await this.assertWritable(agentId, id);
    return this.reserve(agentId, initial.conversationId, async () => {
      const context = await this.assertWritable(agentId, initial.conversationId);
      const options = await this.options.hermes.models(agentId);
      guard();
      if (model && !options.models.some((option) => option.provider === model.provider && option.model === model.model)) {
        throw new HermesError('model_not_configured', 'El modelo no está configurado para este Agente.');
      }
      await this.options.store.mutate((draft, addChange) => {
        guard();
        const receipt = draft.conversations.find((entry) => entry.agentId === agentId && entry.id === context.conversationId && entry.state === 'ready');
        if (!receipt) throw new HermesError('conversation_read_only', 'Esta Conversación no admite cambios de modelo.');
        if (JSON.stringify(receipt.model) === JSON.stringify(model)) return;
        receipt.model = model;
        addChange({ actor, action: 'conversation.model.changed', target: { kind: 'conversation', id: JSON.stringify([agentId, context.conversationId]) } });
      });
      return this.get(agentId, context.conversationId);
    }, true);
  }
  private async personalityContext(agentId:string,id:string):Promise<RunContext> {
    try{return await this.assertWritable(agentId,id);}
    catch(error){if(error instanceof HermesError&&error.code==='conversation_read_only')throw new PersonalityError('personality_read_only');throw error;}
  }
  async getPersonality(agentId:string,id:string,guard:()=>void):Promise<ConversationPersonality> {
    const context=await this.personalityContext(agentId,id);guard();
    return personalitySelection(agentId,context.conversationId,this.receipt(agentId,context.conversationId)?.personality);
  }
  async selectPersonality(agentId:string,id:string,value:unknown,actor:ConversationActor,guard:()=>void):Promise<ConversationPersonality> {
    if(!exactObject(value,['requestId','revision','preset'])||!isUuid(value.requestId)||!isPersonalityRevision(value.revision)
      ||value.preset!==null&&(!exactObject(value.preset,['id','revision'])||!isUuid(value.preset.id)||!isPersonalityRevision(value.preset.revision)))throw new PersonalityError('personality_invalid');
    const request=structuredClone(value),ref=request.preset as {id:string;revision:string}|null;
    const fingerprint=personalityHash([request.revision,ref?[ref.id,ref.revision]:null]);
    const initial=await this.personalityContext(agentId,id);guard();
    return this.reserve(agentId,initial.conversationId,async()=>{
      const context=await this.personalityContext(agentId,initial.conversationId);guard();
      const receipt=this.receipt(agentId,context.conversationId)!;
      const replay=receipt.personality?.receipts.find(r=>r.deviceId===actor.id&&r.requestId===request.requestId);
      if(replay) {if(replay.fingerprint!==fingerprint)throw new PersonalityError('personality_conflict');return structuredClone(replay.result);}
      const current=personalitySelection(agentId,context.conversationId,receipt.personality);
      if(current.revision!==request.revision)throw new PersonalityError('personality_conflict');
      if((receipt.personality?.receipts.length??0)>=128)throw new PersonalityError('personality_limit');
      const preset=ref?await this.options.presets?.get(ref.id):null;guard();
      if(ref&&(!preset||preset.kind!=='overlay'||preset.revision!==ref.revision))throw new PersonalityError('personality_conflict');
      const updatedAt=(this.options.now??Date.now)(),result:ConversationPersonality={agentId,conversationId:context.conversationId,preset:preset??null,updatedAt,
        revision:personalityHash([current.revision,actor.id,request.requestId,preset??null,updatedAt])};
      const finalGuard=()=>{guard();if(ref)this.options.presets!.assertCurrent(ref.id,ref.revision,'overlay');};
      await this.options.store.mutate((draft,addChange)=>{
        guard();if(ref)this.options.presets!.assertCurrent(ref.id,ref.revision,'overlay');
        const live=draft.conversations.find(r=>r.agentId===agentId&&r.id===context.conversationId&&r.state==='ready');
        if(!live||personalitySelection(agentId,context.conversationId,live.personality).revision!==request.revision)throw new PersonalityError('personality_conflict');
        live.personality={revision:result.revision,preset:result.preset,updatedAt,receipts:[...(live.personality?.receipts??[]),{deviceId:actor.id,requestId:request.requestId as string,fingerprint,result}]};
        addChange({actor,action:'conversation.personality.changed',target:{kind:'conversation',id:JSON.stringify([agentId,context.conversationId])}});
      },finalGuard);
      try{guard();}catch{throw new PersonalityError('personality_uncertain');}return result;
    },true);
  }
  async decorateRequest(context:RunContext,request:RunRequest):Promise<PreparedRunRequest> {
    const receipt=this.receipt(context.agentId,context.conversationId);
    const model=receipt?.model,preset=receipt?.personality?.preset;
    if(model) {
      const options=await this.options.hermes.models(context.agentId);
      if(!options.models.some(option=>option.provider===model.provider&&option.model===model.model))throw new HermesError('model_not_configured','El modelo ya no está configurado para este Agente.');
    }
    return {...request,...(model?{model}:{}),...(preset?{instructions:preset.content}:{})};
  }
  async rename(agentId: string, id: string, title: string, actor: ConversationActor, guard: () => void): Promise<Conversation> {
    const conversation = await this.get(agentId, id);
    return this.reserve(agentId, conversation.id, async () => {
      const current = await this.get(agentId, conversation.id);
      if (current.state === 'deleting') throw new HermesError('operation_uncertain', 'El borrado de esta Conversación no está confirmado.');
      guard();
      await this.options.store.mutate((_draft, addChange) => { addChange({ actor, action: 'conversation.rename.requested', target: { kind: 'conversation', id: JSON.stringify([agentId, current.id]) } }); });
      try {
        guard(); await this.options.hermes.renameConversation(agentId, current.sessionId, title);
      } catch (error) {
        const definitive = error instanceof HermesError && ['bad_request', 'invalid_title', 'not_found', 'conversation_not_found', 'conflict'].includes(error.code);
        await this.options.store.mutate((_draft, addChange) => { addChange({ actor, action: definitive ? 'conversation.rename.failed' : 'conversation.rename.uncertain', target: { kind: 'conversation', id: JSON.stringify([agentId, current.id]) } }); });
        throw error;
      }
      await this.options.store.mutate((_draft, addChange) => { addChange({ actor, action: 'conversation.rename.succeeded', target: { kind: 'conversation', id: JSON.stringify([agentId, current.id]) } }); });
      return this.get(agentId, current.id);
    });
  }
  async deletionPreview(agentId: string, id: string): Promise<ConversationDeletionPreview> {
    const current = await this.get(agentId, id);
    if (this.reservations.has(JSON.stringify([agentId, current.id])) || this.options.runs.activeForConversation(agentId, current.id)) throw new HermesError('conversation_busy', 'La Conversación tiene un Turno en marcha.');
    const preview = await this.options.hermes.deletionPreview(agentId, current.id);
    const pending = this.options.store.snapshot().deletions.find((plan) => plan.agentId === agentId && plan.id === current.id);
    // Resume the saved confirmation; delete rechecks drift before touching the remaining messages.
    return { conversationId: current.id, messageCount: pending?.messageCount ?? preview.messageCount, conversationCount: preview.conversationCount, revision: pending?.revision ?? preview.revision };
  }
  async delete(agentId: string, id: string, revision: string, actor: ConversationActor, guard: () => void): Promise<ConversationDeleted> {
    let plan = this.options.store.snapshot().deletions.find((entry) => entry.agentId === agentId && entry.id === id);
    const root = plan?.id ?? (await this.get(agentId, id)).id;
    return this.reserve(agentId, root, async () => {
      plan = this.options.store.snapshot().deletions.find((entry) => entry.agentId === agentId && entry.id === root);
      if (plan && plan.revision !== revision) throw new HermesError('conversation_changed', 'La Conversación cambió. Confirma de nuevo el borrado.');
      if (!plan) {
        const preview = await this.options.hermes.deletionPreview(agentId, root);
        if (preview.revision !== revision) throw new HermesError('conversation_changed', 'La Conversación cambió. Confirma de nuevo el borrado.');
        if (!preview.sessionRevisions || preview.sessionIds.some((sessionId) => !preview.sessionRevisions?.[sessionId])) {
          throw new HermesError('chat_unavailable', 'Hermes no permite comprobar este borrado con seguridad.');
        }
        guard();
        plan = { agentId, id: root, revision, messageCount: preview.messageCount, sessionIds: preview.sessionIds, remainingSessionIds: [...preview.sessionIds], actor,
          sessionRevisions: preview.sessionRevisions };
        const saved = plan;
        await this.options.store.mutate((draft, addChange) => {
          draft.deletions.push(saved);
          const receipt = draft.conversations.find((entry) => entry.agentId === agentId && entry.id === root);
          if (receipt?.state === 'ready') receipt.state = 'deleting';
          addChange({ actor, action: 'conversation.delete.requested', target: { kind: 'conversation', id: JSON.stringify([agentId, root]) } });
        });
      }
      const saved: ConversationDeletion = plan;
      try {
        for (const sessionId of saved.remainingSessionIds) {
          const present = await this.options.hermes.getConversation(agentId, sessionId);
          if (present) {
            const fresh = await this.options.hermes.deletionPreview(agentId, sessionId);
            if (saved.remainingSessionIds.length === saved.sessionIds.length && sessionId === saved.sessionIds[0] && fresh.revision !== saved.revision
              || fresh.sessionIds.some((candidate) => !saved.sessionIds.includes(candidate)
                || fresh.sessionRevisions?.[candidate] !== saved.sessionRevisions[candidate])) {
              throw new HermesError('conversation_changed', 'La Conversación cambió durante el borrado. No se borrarán más mensajes.');
            }
            guard();
            try { await this.options.hermes.deleteSession(agentId, sessionId); }
            catch (error) { if (!(error instanceof HermesError) || !['not_found', 'conversation_not_found'].includes(error.code)) throw error; }
          }
          await this.options.store.mutate((draft) => {
            const deletion = draft.deletions.find((entry) => entry.agentId === agentId && entry.id === root)!;
            deletion.remainingSessionIds = deletion.remainingSessionIds.filter((candidate) => candidate !== sessionId);
          });
        }
      } catch (error) {
        await this.options.store.mutate((draft, addChange) => {
          if (error instanceof HermesError && error.code === 'conversation_changed') {
            // Drift ends this confirmation; a fresh preview can authorize the remaining messages.
            draft.deletions = draft.deletions.filter((entry) => entry.agentId !== agentId || entry.id !== root);
            const receipt = draft.conversations.find((entry) => entry.agentId === agentId && entry.id === root);
            if (receipt?.state === 'deleting') receipt.state = 'ready';
          }
          addChange({ actor, action: 'conversation.delete.uncertain', target: { kind: 'conversation', id: JSON.stringify([agentId, root]) } });
        });
        if (error instanceof AuthorizationError || error instanceof HermesError && error.code === 'conversation_changed') throw error;
        throw new HermesError('operation_uncertain', 'El borrado quedó sin confirmar. Reintenta con la misma confirmación.');
      }
      await this.options.store.mutate((draft, addChange) => {
        const removed = draft.conversations.filter((receipt) => receipt.agentId === agentId && saved.sessionIds.includes(receipt.id));
        for (const receipt of removed) draft.deletedRequests.push({ agentId, deviceId: receipt.createdByDeviceId, requestId: receipt.createRequestId, conversationId: receipt.id });
        draft.conversations = draft.conversations.filter((receipt) => !removed.includes(receipt));
        draft.deletions = draft.deletions.filter((entry) => entry.agentId !== agentId || entry.id !== root);
        addChange({ actor, action: 'conversation.delete.succeeded', target: { kind: 'conversation', id: JSON.stringify([agentId, root]) } });
      });
      return { conversationId: root, deleted: true, messageCount: saved.messageCount };
    });
  }
}
