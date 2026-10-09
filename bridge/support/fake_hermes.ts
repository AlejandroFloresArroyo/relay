import { createHash } from 'node:crypto';
import type { HermesChat, HermesMedia, StoredConversation, StoredConversationSearchPage } from '../src/chatPorts.ts';
import type {
  DecisionRecord,
  ConversationQuery,
  ConversationSearchQuery,
  ApprovalChoice,
  DoctorCheck,
  GatewayStatus,
  Job,
  LogLevel,
  LogLine,
  ModelInfo,
  RunCreated,
  RunRequest,
} from '../../protocol/protocol.ts';
import { HermesError, unavailableChatPort } from '../src/hermes.ts';
import type {
  AgentProfile,
  ChatStatus,
  GatewayAction,
  Hermes,
  ProfileState,
  Transcript,
  UpstreamEvent,
  UpstreamRunStatus,
} from '../src/hermes.ts';
import { Channel } from './channel.ts';

export interface FakeCall {
  method: string;
  args: unknown[];
}

// In-memory Hermes for tests. Every call is recorded in `calls`; run event streams are fed by
// the test through `stream(runId)`.
export class FakeHermes implements Hermes {
  details?: import('../src/agentDetailsPorts.ts').HermesAgentDetails;
  decisions: Record<string,DecisionRecord[]> = {};
  async decisionHistory(profile: string): Promise<DecisionRecord[]> { this.record('decisionHistory',profile); return structuredClone(this.decisions[profile] ?? []); }
  serverControl?: import('../../protocol/serverControl.ts').HermesServerControl;
  conversations: Record<string, StoredConversation[]> = {};
  conversationTranscripts: Record<string, Record<string, Transcript>> = {};
  sessionTranscripts: Record<string, Record<string, Transcript['items']>> = {};
  sessionMessageCounts: Record<string, Record<string, number>> = {};
  private fixtureClock = 1_700_000_000_000;

  seedConversation(profile: string, conversation: StoredConversation, items: Transcript['items'] = []): void {
    const rows = this.conversations[profile] ??= [];
    const index = rows.findIndex((row) => row.id === conversation.id);
    const stored = { ...conversation, sessionIds: [...conversation.sessionIds] };
    if (index < 0) rows.push(stored); else rows[index] = stored;
    (this.conversationTranscripts[profile] ??= {})[conversation.id] = { sessionId: conversation.sessionId, items: [...items] };
    const sessions = this.sessionTranscripts[profile] ??= {};
    const counts = this.sessionMessageCounts[profile] ??= {};
    for (const id of stored.sessionIds) {
      sessions[id] = id === stored.sessionIds[0] ? [...items] : [];
      counts[id] = id === stored.sessionIds[0] ? stored.messageCount : 0;
    }
  }

  private findConversation(profile: string, id: string): StoredConversation | undefined {
    return this.conversations[profile]?.find((row) => row.id === id || row.sessionId === id || row.sessionIds.includes(id));
  }

  private conversationRows(profile: string, query: ConversationQuery = {}): StoredConversation[] {
    return (this.conversations[profile] ?? []).filter((row) => (row.kind === 'background') === (query.background ?? false))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  async listConversations(profile: string, query: ConversationQuery = {}): ReturnType<HermesChat['listConversations']> {
    this.record('listConversations', profile, query);
    if (this.chatHooks.listConversations) return this.chatHooks.listConversations(profile, query);
    const rows = this.conversationRows(profile, query);
    const offset = query.offset ?? 0, limit = query.limit ?? 50;
    return { conversations: rows.slice(offset, offset + limit), nextOffset: offset + limit < rows.length ? offset + limit : null };
  }
  async getConversation(profile: string, id: string): ReturnType<HermesChat['getConversation']> {
    this.record('getConversation', profile, id);
    return this.chatHooks.getConversation ? this.chatHooks.getConversation(profile, id) : this.findConversation(profile, id) ?? null;
  }
  async searchConversations(profile: string, query: ConversationSearchQuery): ReturnType<HermesChat['searchConversations']> {
    this.record('searchConversations', profile, query);
    if (this.chatHooks.searchConversations) return this.chatHooks.searchConversations(profile, query);
    const needle = query.q.toUpperCase().toLowerCase();
    const hits: StoredConversationSearchPage['hits'] = [];
    for (const conversation of this.conversationRows(profile, query)) {
      if (conversation.title?.toUpperCase().toLowerCase().includes(needle)) {
        hits.push({ conversation, match: 'title', messageId: null, snippet: conversation.title });
        continue;
      }
      const items = this.conversationTranscripts[profile]?.[conversation.id]?.items ?? [];
      for (let index = items.length - 1; index >= 0; index--) {
        const item = items[index];
        if ((item.kind === 'user' || item.kind === 'assistant') && item.text.toUpperCase().toLowerCase().includes(needle)) {
          hits.push({ conversation, match: 'message', messageId: item.id, snippet: item.text });
          break;
        }
      }
    }
    const offset = query.offset ?? 0, limit = query.limit ?? 50;
    return { hits: hits.slice(offset, offset + limit), nextOffset: offset + limit < hits.length ? offset + limit : null };
  }
  async createConversation(profile: string, id: string): ReturnType<HermesChat['createConversation']> {
    this.record('createConversation', profile, id);
    if (this.chatHooks.createConversation) return this.chatHooks.createConversation(profile, id);
    if (this.findConversation(profile, id)) throw new HermesError('conflict', 'Session already exists');
    const at = this.fixtureClock++;
    this.seedConversation(profile, { id, sessionId: id, sessionIds: [id], source: 'api_server', createdSource: 'api_server',
      title: null, kind: 'interactive', hidden: false, archived: false, startedAt: at, lastActiveAt: at, messageCount: 0, preview: null });
  }
  async renameConversation(profile: string, sessionId: string, title: string): ReturnType<HermesChat['renameConversation']> {
    this.record('renameConversation', profile, sessionId, title);
    if (this.chatHooks.renameConversation) return this.chatHooks.renameConversation(profile, sessionId, title);
    const row = this.findConversation(profile, sessionId);
    if (!row) throw new HermesError('not_found', 'Session not found');
    const normalized = title.trim();
    if (!normalized || [...normalized].length > 100 || this.conversations[profile].some((other) => other !== row && other.title === normalized)) {
      throw new HermesError('invalid_title', 'Invalid or duplicate title');
    }
    row.title = normalized;
  }
  async deleteSession(profile: string, sessionId: string): ReturnType<HermesChat['deleteSession']> {
    this.record('deleteSession', profile, sessionId);
    if (this.chatHooks.deleteSession) return this.chatHooks.deleteSession(profile, sessionId);
    const row = this.findConversation(profile, sessionId);
    if (!row || !row.sessionIds.includes(sessionId)) throw new HermesError('not_found', 'Session not found');
    const removedIds = new Set((this.sessionTranscripts[profile]?.[sessionId] ?? []).map((item) => item.id));
    const transcript = this.conversationTranscripts[profile]?.[row.id];
    if (transcript) transcript.items = transcript.items.filter((item) => !removedIds.has(item.id));
    row.messageCount -= this.sessionMessageCounts[profile]?.[sessionId] ?? 0;
    delete this.sessionTranscripts[profile]?.[sessionId];
    delete this.sessionMessageCounts[profile]?.[sessionId];
    row.sessionIds = row.sessionIds.filter((id) => id !== sessionId);
    if (!row.sessionIds.length) {
      this.conversations[profile] = this.conversations[profile].filter((other) => other !== row);
      delete this.conversationTranscripts[profile]?.[row.id];
    } else if (row.sessionId === sessionId) {
      row.sessionId = row.sessionIds[row.sessionIds.length - 1];
    }
  }
  async deletionPreview(profile: string, id: string): ReturnType<HermesChat['deletionPreview']> {
    this.record('deletionPreview', profile, id);
    if (this.chatHooks.deletionPreview) return this.chatHooks.deletionPreview(profile, id);
    const row = this.findConversation(profile, id);
    if (!row) throw new HermesError('not_found', 'Conversation not found');
    return { conversationId: row.id, messageCount: row.messageCount, conversationCount: 1,
      revision: createHash('sha256').update(JSON.stringify([row, this.conversationTranscripts[profile]?.[row.id]?.items ?? []])).digest('hex'),
      sessionIds: [...row.sessionIds],
      sessionRevisions: Object.fromEntries(row.sessionIds.map((sessionId) => [sessionId,
        createHash('sha256').update(JSON.stringify([sessionId, row.title, row.source, row.createdSource, row.hidden, row.archived,
          this.sessionMessageCounts[profile]?.[sessionId] ?? 0, this.sessionTranscripts[profile]?.[sessionId] ?? []])).digest('hex')])) };
  }
  // BEGIN MODEL (#38)
  async models(profile: string): ReturnType<HermesChat['models']> {
    this.record('models', profile);
    const hook = this.chatHooks.models;
    return hook ? hook(profile) : unavailableChatPort();
  }
  // END MODEL
  // BEGIN TURN (#37)
  async steerRun(profile: string, runId: string, input: string): ReturnType<HermesChat['steerRun']> {
    this.record('steerRun', profile, runId, input);
    const hook = this.chatHooks.steerRun;
    if (hook) return hook(profile, runId, input);
    const status = this.statuses.get(runId);
    if (!this.streams.has(runId) || status === null) throw new HermesError('run_not_found', 'Turno desconocido.');
    if (status && status.status !== 'running') throw new HermesError('run_not_accepting_steer', 'El Turno no admite redirección.');
  }
  // END TURN
  chatHooks: Partial<HermesChat> = {};
  media: HermesMedia = { announcements: unavailableChatPort, validate: unavailableChatPort };
  resetChat(): void { this.chatHooks = {}; this.media = { announcements: unavailableChatPort, validate: unavailableChatPort }; }
  calls: FakeCall[] = [];

  profilesList: AgentProfile[] = [
    { id: 'default', name: 'default', model: 'deepseek-v4.1-flash', provider: 'opencode-go' },
    { id: 'coding', name: 'coding', model: 'qwen3.8-max', provider: 'opencode-go' },
  ];
  states: Record<string, ProfileState> = { default: 'on', coding: 'on' };
  lastMessages: Record<string, { text: string; at: number } | null> = {};
  transcripts: Record<string, Transcript> = {};
  gatewayStatus: GatewayStatus = { state: 'active', pid: 4242, uptimeSeconds: 3600, port: 8642 };
  doctorChecks: DoctorCheck[] = [{ label: 'config.yaml', value: 'ok', ok: true }];
  logLines: LogLine[] = [{ t: '09:40:58', level: 'INFO', msg: 'gateway started' }];
  modelInfo: ModelInfo = { model: 'deepseek-v4.1-flash', provider: 'opencode-go' };
  jobList: Job[] = [];
  chatStatus: ChatStatus = { available: true, reason: null };
  approvalTimeout = 300;

  nextRunId = 1;
  streams = new Map<string, Channel<UpstreamEvent>[]>();
  statuses = new Map<string, UpstreamRunStatus | null>();
  failWith: Partial<Record<string, Error>> = {};

  // The channel for the Nth (0-based) connection to a run's event stream.
  stream(runId: string, connection = 0): Channel<UpstreamEvent> {
    let list = this.streams.get(runId);
    if (!list) this.streams.set(runId, (list = []));
    while (list.length <= connection) list.push(new Channel<UpstreamEvent>());
    return list[connection];
  }

  callsTo(method: string): FakeCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const failure = this.failWith[method];
    if (failure) throw failure;
  }

  async version(): Promise<string> {
    this.record('version');
    return '0.21.5';
  }

  async profiles(): Promise<AgentProfile[]> {
    this.record('profiles');
    return this.profilesList;
  }

  async profileStates(ids: string[]): Promise<Record<string, ProfileState>> {
    this.record('profileStates', ids);
    return Object.fromEntries(ids.map((id) => [id, this.states[id] ?? 'off']));
  }

  async lastMessage(profile: string): Promise<{ text: string; at: number } | null> {
    this.record('lastMessage', profile);
    return this.lastMessages[profile] ?? null;
  }

  async transcript(profile: string, sessionId: string | null): Promise<Transcript> {
    this.record('transcript', profile, sessionId);
    if (this.conversations[profile] !== undefined) {
      const row = sessionId === null ? this.conversationRows(profile)[0] : this.findConversation(profile, sessionId);
      if (!row) {
        if (sessionId !== null) throw new HermesError('not_found', 'Conversation not found');
        return { sessionId: null, items: [] };
      }
      return { sessionId: row.sessionId, items: this.conversationTranscripts[profile]?.[row.id]?.items ?? [] };
    }
    const legacy = this.transcripts[profile];
    if (sessionId !== null && legacy?.sessionId !== sessionId) throw new HermesError('not_found', 'Conversation not found');
    return legacy ?? { sessionId: null, items: [] };
  }

  async gateway(): Promise<GatewayStatus> {
    this.record('gateway');
    return this.gatewayStatus;
  }

  async gatewayAction(action: GatewayAction): Promise<void> {
    this.record('gatewayAction', action);
    this.gatewayStatus =
      action === 'stop'
        ? { state: 'stopped', pid: null, uptimeSeconds: null, port: null }
        : { state: 'active', pid: 5000, uptimeSeconds: 0, port: 8642 };
  }

  async doctor(): Promise<DoctorCheck[]> {
    this.record('doctor');
    return this.doctorChecks;
  }

  async logs(query: { level: LogLevel; lines: number }): Promise<LogLine[]> {
    this.record('logs', query);
    return this.logLines;
  }

  async model(): Promise<ModelInfo> {
    this.record('model');
    return this.modelInfo;
  }

  async jobs(): Promise<Job[]> {
    this.record('jobs');
    return this.jobList;
  }

  async chat(profile?: string): Promise<ChatStatus> {
    if (profile !== undefined) {
      this.record('chat', profile);
      return this.chatHooks.chat ? this.chatHooks.chat(profile) : this.chatStatus;
    }
    this.record('chat');
    return this.chatStatus;
  }

  async approvalTimeoutSeconds(profile: string): Promise<number> {
    this.record('approvalTimeoutSeconds', profile);
    return this.approvalTimeout;
  }

  async createRun(profile: string, request: RunRequest): Promise<RunCreated> {
    this.record('createRun', profile, request);
    if (!this.chatStatus.available) {
      throw new HermesError('unavailable', this.chatStatus.reason ?? 'chat unavailable');
    }
    const runId = `run_${this.nextRunId++}`;
    if (this.conversations[profile] !== undefined) {
      const row = request.sessionId ? this.findConversation(profile, request.sessionId) : undefined;
      if (!row) throw new HermesError('not_found', 'Conversation not found');
      const at = this.fixtureClock++;
      const transcript = (this.conversationTranscripts[profile] ??= {})[row.id] ??= { sessionId: row.sessionId, items: [] };
      transcript.items.push({ kind: 'user', id: `message_${runId}`, text: request.input, at, runId,
        ...(request.clientMessageId ? { clientMessageId: request.clientMessageId } : {}) });
      row.messageCount++;
      ((this.sessionTranscripts[profile] ??= {})[row.sessionId] ??= []).push(transcript.items[transcript.items.length - 1]);
      const counts = this.sessionMessageCounts[profile] ??= {};
      counts[row.sessionId] = (counts[row.sessionId] ?? 0) + 1;
      row.preview = request.input;
      row.lastActiveAt = at;
      return { runId, sessionId: row.sessionId };
    }
    return { runId, sessionId: request.sessionId ?? `session_${runId}` };
  }

  runEvents(
    profile: string,
    runId: string,
    afterSeq: number | null,
    signal: AbortSignal,
  ): AsyncIterable<UpstreamEvent> {
    const connection = this.callsTo('runEvents').filter((call) => call.args[1] === runId).length;
    this.record('runEvents', profile, runId, afterSeq);
    void signal;
    return this.stream(runId, connection);
  }

  async runStatus(profile: string, runId: string): Promise<UpstreamRunStatus | null> {
    this.record('runStatus', profile, runId);
    return this.statuses.has(runId)
      ? this.statuses.get(runId)!
      : { status: 'running', output: null, error: null };
  }

  async stopRun(profile: string, runId: string): Promise<void> {
    this.record('stopRun', profile, runId);
  }

  async resolveApproval(
    profile: string,
    runId: string,
    choice: ApprovalChoice,
    requestId: string | null,
  ): Promise<void> {
    this.record('resolveApproval', profile, runId, choice, requestId);
  }
}
