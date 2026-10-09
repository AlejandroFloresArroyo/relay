// Runs started through the bridge, and the pending-approvals inbox built from them.
//
// Hermes has no "pending approvals" list: an approval only exists as an `approval.request` event
// on the SSE stream of the run that is waiting. So for every run it starts, the bridge keeps
// reading that stream itself, whether or not an app client is attached, and derives the inbox
// from what it sees. App clients subscribe to the bridge's own copy of the stream.

import { randomUUID } from 'node:crypto';
import type { Approval, DecisionAttempt, DecisionRecord, ApprovalChoice, ApprovalResolution, ChatRunEvent, ChatRunTerminal, RunConnection, RunCreated, RunPhase, RunRequest, RunSnapshot, SteerAccepted, SteerReceipt, SteerRequest, TranscriptItem } from '../../protocol/protocol.ts';
import { HermesError } from './hermes.ts';
import type { AgentProfile, Hermes, UpstreamEvent } from './hermes.ts';
import type { RunContext, RunStartPorts } from './chatPorts.ts';
import type { Notifier } from './notify.ts';
import { isModelSelection } from './conversationStore.ts';
import { memoryDecisionStore, type DecisionStore } from './decisionStore.ts';
import { riskFor } from './risk.ts';

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface RunManagerDeps {
  hermes: Hermes;
  decisionStore?: DecisionStore;
  startPorts?: Partial<RunStartPorts>;
  notifier: Notifier;
  now?: () => number;
  timers?: Timers;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

type Listener = (seq: number, event: ChatRunEvent) => void;

interface Subscriber {
  listener: Listener;
  onClose: () => void;
}

interface PendingApproval {
  approval: Approval;
  requestId: string | null; // Hermes's own id for the request, when it sent one
  timer: unknown;
  deciding?: boolean;
  uncertain?: boolean;
  response?: ApprovalChoice;
  record?: DecisionRecord;
  resolution?: Promise<void>;
}

interface Steering {
  input: string;
  status: SteerReceipt['status'];
  result: Promise<SteerAccepted>;
}

export interface TerminalObservation { id: string; outcome: 'completed' | 'failed'; at: number }

interface Run {
  observationId: string;
  runId: string;
  context: RunContext | null;
  agent: AgentProfile;
  events: ChatRunEvent[]; // index = seq on the bridge's stream
  done: boolean;
  subscribers: Set<Subscriber>;
  abort: AbortController;
  approvalTimeoutMs: number;
  toolCount: number;
  openTools: Map<string, string[]>; // tool name -> ids of calls still running, oldest first
  approvalCount: number;
  sessionId: string;
  phase: RunPhase;
  connection: RunConnection;
  complete: boolean;
  items: TranscriptItem[];
  terminal: ChatRunTerminal | null;
  steers: Map<string, Steering>;
  steerTail: Promise<unknown>;
  consuming: boolean;
  lastUpstreamSeq: number | null;
  unsequenced: boolean;
  messageCount: number;
  imageReceipt?: { clientMessageId: string; previousIds: string[]; input: string; messageId: string | null };
}

const CHOICES: readonly ApprovalChoice[] = ['once', 'session', 'always', 'deny'];
const TERMINAL_STATUSES: Record<string, true> = { completed: true, failed: true, cancelled: true, interrupted: true };
const MAX_RECONNECTS = 5;
const MAX_EVENTS_PER_RUN = 5000;
const FINISHED_RUN_TTL_MS = 10 * 60 * 1000;

const realTimers: Timers = {
  set(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export class RunManager {
  private decisions: DecisionStore;
  private startPorts: Partial<RunStartPorts>;
  private hermes: Hermes;
  private notifier: Notifier;
  private terminalObservers = new Set<(event: TerminalObservation) => Promise<void>>();
  subscribeTerminals(observer: (event: TerminalObservation) => Promise<void>): () => void {
    this.terminalObservers.add(observer); return () => { this.terminalObservers.delete(observer); };
  }
  private approvalNotifiers = new Set<Notifier>();
  subscribeApprovals(notifier: Notifier): () => void { this.approvalNotifiers.add(notifier); return () => { this.approvalNotifiers.delete(notifier); }; }
  // Agente busy state or the Aprobaciones inbox changed; observers learn only that, never what.
  private changeObservers = new Set<() => void>();
  subscribeChanges(observer: () => void): () => void { this.changeObservers.add(observer); return () => { this.changeObservers.delete(observer); }; }
  private changed(): void { for (const observer of this.changeObservers) observer(); }
  private now: () => number;
  private timers: Timers;
  private sleep: (ms: number) => Promise<void>;
  private log: (line: string) => void;
  private runs = new Map<string, Run>();
  private inbox = new Map<string, PendingApproval>();
  private cleanups = new Set<unknown>();

  constructor(deps: RunManagerDeps) {
    this.decisions = deps.decisionStore ?? memoryDecisionStore();
    this.startPorts = deps.startPorts ?? {};
    this.hermes = deps.hermes;
    this.notifier = deps.notifier;
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? realTimers;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = deps.log ?? (() => {});
  }

  async start(agent: AgentProfile, request: RunRequest, context?: RunContext, beforeEffect: () => void = () => {}): Promise<RunCreated> {
    if (context) return this.startPrepared(agent, request, context, beforeEffect);
    // BEGIN CONVERSATIONS (#36): reservation encloses creation AND registration.
    const operation = (context: RunContext | null) => this.startPrepared(agent, request, context, beforeEffect);
    return this.startPorts.prepare ? this.startPorts.prepare(agent, request, operation) : operation(null);
    // END CONVERSATIONS
  }

  private async startPrepared(agent: AgentProfile, request: RunRequest, context: RunContext | null, beforeEffect: () => void): Promise<RunCreated> {
    // BEGIN CONVERSATIONS (#36): only the resolved Context supplies the upstream session.
    const conversationRequest = context ? { ...request, sessionId: context.sessionId } : request;
    // END CONVERSATIONS
    // BEGIN MODEL (#38): decorate the request without changing the Agent default.
    const prepared = this.startPorts.decorateRequest ? await this.startPorts.decorateRequest(context, conversationRequest) : conversationRequest;
    // END MODEL
    let previousIds: string[] | null = null;
    if (prepared.images && prepared.clientMessageId && prepared.sessionId) {
      try { previousIds = (await this.hermes.transcript(agent.id, prepared.sessionId)).items.filter((item) => item.kind === 'user').map((item) => item.id); }
      catch { /* Missing receipt evidence must never guess an older message. */ }
    }
    await this.decisions.ready();
    beforeEffect();
    // BEGIN IMAGES (#39): upstream body and input receipt belong to this slot.
    const created = this.startPorts.createUpstreamRun
      ? await this.startPorts.createUpstreamRun(agent.id, prepared, context)
      : await this.hermes.createRun(agent.id, prepared);
    // END IMAGES
    let timeoutSeconds = 300;
    try {
      timeoutSeconds = await this.hermes.approvalTimeoutSeconds(agent.id);
    } catch {
      // keep Hermes's documented default
    }
    const run: Run = {
      observationId: randomUUID(),
      runId: created.runId,
      context,
      agent,
      events: [],
      done: false,
      subscribers: new Set(),
      abort: new AbortController(),
      approvalTimeoutMs: timeoutSeconds * 1000,
      toolCount: 0,
      openTools: new Map(),
      approvalCount: 0,
      sessionId: created.sessionId ?? context?.sessionId ?? created.runId,
      phase: 'running',
      connection: 'connected',
      complete: true,
      items: [{ kind: 'user', id: created.inputMessageId ?? `${created.runId}:input`, text: request.input, at: this.now(), runId: created.runId,
        ...(request.clientMessageId ? { clientMessageId: request.clientMessageId } : {}),
        ...(request.images ? { attachmentIds: request.images.map((image) => image.attachmentId) } : {}) }],
      terminal: null,
      steers: new Map(),
      steerTail: Promise.resolve(),
      consuming: false,
      lastUpstreamSeq: null,
      unsequenced: false,
      messageCount: 0,
      ...(previousIds && prepared.clientMessageId ? { imageReceipt: { clientMessageId: prepared.clientMessageId, previousIds, input: prepared.input, messageId: null } } : {}),
    };
    this.runs.set(run.runId, run);
    this.changed();
    await this.resolveImageReceipt(run);
    void this.consume(run);
    return { ...created, ...(context ? { conversationId: context.conversationId } : {}),
      ...(request.clientMessageId ? { clientMessageId: request.clientMessageId } : {}),
      ...(request.images ? { inputMessageId: run.imageReceipt?.messageId ?? created.inputMessageId ?? null } : {}) };
  }

  private async resolveImageReceipt(run: Run): Promise<void> {
    const receipt = run.imageReceipt;
    if (!receipt || receipt.messageId) return;
    try {
      const history = await this.hermes.transcript(run.agent.id, run.sessionId);
      const candidates = history.items.filter((item) => item.kind === 'user' && !receipt.previousIds.includes(item.id) && item.text === receipt.input);
      if (candidates.length !== 1) return;
      receipt.messageId = candidates[0].id;
      run.items = run.items.map((item) => item.kind === 'user' && item.clientMessageId === receipt.clientMessageId ? { ...item, id: receipt.messageId! } : item);
      this.emit(run, { type: 'run.input', clientMessageId: receipt.clientMessageId, messageId: receipt.messageId, sessionId: run.sessionId });
    } catch { /* Local thumbnails stay unbound until Hermes proves the input identity. */ }
  }

  // Only bridge-started active Turns participate in #36's mutation reservation.
  activeForConversation(agentId: string, id: string): boolean {
    for (const run of this.runs.values()) {
      if (!run.done && run.agent.id === agentId && run.context?.conversationId === id) return true;
    }
    return false;
  }

  // Opaque upstream IDs may be reused after restart. Evidence is local and scope-complete.
  phaseForConversation(agentId: string, conversationId: string, runId: string): RunPhase | null {
    const run = this.runs.get(runId);
    return run?.agent.id === agentId && run.context?.conversationId === conversationId ? run.phase : null;
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  // Replays every event after `afterSeq`, then delivers live ones. `onClose` fires once the run
  // has ended and everything was delivered. Returns null for a run the bridge does not know.
  subscribe(runId: string, afterSeq: number, listener: Listener, onClose: () => void): (() => void) | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    for (let seq = Math.max(afterSeq + 1, 0); seq < run.events.length; seq++) listener(seq, run.events[seq]);
    if (run.done) {
      onClose();
      return () => {};
    }
    const subscriber: Subscriber = { listener, onClose };
    run.subscribers.add(subscriber);
    return () => {
      run.subscribers.delete(subscriber);
    };
  }

  async stopActive(authorize: () => void, attempted = new Set<string>()): Promise<void> {
    const outcomes = await Promise.allSettled([...this.runs.values()].filter((run) => !run.done && !attempted.has(run.runId)).map((run) => {
      attempted.add(run.runId);
      return this.stop(run.runId, authorize);
    }));
    if (outcomes.some((result) => result.status === 'rejected')) throw new HermesError('upstream', 'No se pudo detener todos los Turnos de Relay. Reintenta.');
  }

  async stop(runId: string, beforeEffect: () => void = () => {}): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new HermesError('not_found', 'Turno desconocido.');
    beforeEffect();
    const previousPhase = run.phase;
    if (!run.done) run.phase = 'stopping';
    try { await this.hermes.stopRun(run.agent.id, runId); }
    catch (error) { if (!run.done) run.phase = previousPhase; throw error; }
  }


  snapshot(runId: string): RunSnapshot {
    const run = this.known(runId);
    return {
      runId, conversationId: run.context?.conversationId ?? run.sessionId, sessionId: run.sessionId,
      phase: run.phase, connection: run.connection, lastEventId: run.events.length - 1,
      items: run.items.map((item) => ({ ...item })), complete: run.complete,
      steers: [...run.steers].map(([requestId, receipt]) => ({ requestId, status: receipt.status })),
      terminal: run.terminal ? { ...run.terminal } : null,
    };
  }

  reconnect(runId: string, beforeEffect: () => void = () => {}): RunSnapshot {
    const run = this.known(runId);
    beforeEffect();
    if (!run.done && !run.consuming) {
      this.connection(run, 'reconnecting');
      void this.consume(run);
    }
    return this.snapshot(runId);
  }

  steer(runId: string, request: SteerRequest, beforeEffect: () => void = () => {}): Promise<SteerAccepted> {
    const run = this.known(runId);
    beforeEffect();
    const previous = run.steers.get(request.requestId);
    if (previous) {
      if (previous.input !== request.input) throw new HermesError('request_conflict', 'La solicitud ya corresponde a otra instrucción.');
      return previous.result;
    }
    if (run.steers.size >= MAX_EVENTS_PER_RUN || run.done || run.phase !== 'running' || run.connection !== 'connected' || !run.complete) {
      throw new HermesError('run_not_accepting_steer', 'El Turno no admite redirección.');
    }
    let receipt: Steering;
    const operation = run.steerTail.catch(() => {}).then(async (): Promise<SteerAccepted> => {
      let written = false;
      try {
        beforeEffect();
        const status = await this.hermes.runStatus(run.agent.id, runId);
        beforeEffect();
        if (status === null) throw new HermesError('run_not_found', 'Hermes ya no conoce este Turno.');
        if (run.done || run.phase !== 'running' || run.connection !== 'connected' || !run.complete || status?.status !== 'running') {
          throw new HermesError('run_not_accepting_steer', 'El Turno ya no admite redirección.');
        }
        written = true;
        await this.hermes.steerRun(run.agent.id, runId, request.input);
        receipt.status = 'accepted';
        this.emit(run, { type: 'run.steered', requestId: request.requestId, accepted: true });
        return { runId, requestId: request.requestId, accepted: true };
      } catch (error) {
        const refused = error instanceof HermesError && ['run_not_found', 'run_not_accepting_steer', 'steer_not_accepted', 'invalid_steer_input'].includes(error.code);
        receipt.status = !written || refused ? 'rejected' : 'unknown';
        if (written && !refused) throw new HermesError('operation_uncertain', 'La redirección quedó sin confirmar. Conserva la misma solicitud.');
        throw error;
      }
    });
    receipt = { input: request.input, status: 'unknown', result: operation };
    run.steers.set(request.requestId, receipt);
    run.steerTail = operation;
    return operation;
  }

  private known(runId: string): Run {
    const run = this.runs.get(runId);
    if (!run) throw new HermesError('run_not_found', 'El Puente no conoce este Turno.');
    return run;
  }
  // Pending approvals across every agent, oldest first.
  approvals(): Approval[] {
    this.expireDue();
    return [...this.inbox.values()]
      .filter((entry) => !entry.resolution && !entry.uncertain && (entry.approval.expiresAt === null || entry.approval.expiresAt > this.now()))
      .map((entry) => entry.approval)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  pendingFor(agentId: string): number {
    return this.approvals().filter((approval) => approval.agentId === agentId).length;
  }

  busy(agentId: string): boolean {
    for (const run of this.runs.values()) {
      if (!run.done && run.agent.id === agentId) return true;
    }
    return false;
  }

  async decisionHistory(): Promise<DecisionRecord[]> { await this.decisions.ready(); return this.decisions.list(); }

  async uncertainDecisions(): Promise<DecisionAttempt[]> {
    await this.decisions.ready();
    return this.decisions.pending().filter(record => record.choice !== null).map(record => ({id:record.id,agentId:record.agentId,agentName:record.agentName,command:record.command,choice:record.choice!,at:record.at,origin:'relay'}));
  }

  private decisionRecord(entry: PendingApproval, choice: ApprovalChoice, resolution: ApprovalResolution): DecisionRecord {
    const approval = entry.approval; const run = this.runs.get(approval.runId);
    if (entry.record) return { ...entry.record, choice,
      actor: resolution === 'expired' ? 'expired' : 'person',
      outcome: resolution === 'expired' ? 'expired' : choice === 'deny' ? 'rejected' : 'approved',
      at: resolution === 'expired' ? approval.expiresAt ?? this.now() : entry.record.at };
    return { id: JSON.stringify(['relay',approval.agentId,approval.runId,approval.id]), agentId: approval.agentId, agentName: approval.agentName,
      sessionId: run?.sessionId ?? approval.runId, runId: approval.runId, approvalId: approval.id, toolCallId: null, command: approval.command,
      actor: resolution === 'expired' ? 'expired' : 'person', outcome: resolution === 'expired' ? 'expired' : choice === 'deny' ? 'rejected' : 'approved',
      choice, at: resolution === 'expired' ? approval.expiresAt ?? this.now() : this.now(), timeKind: 'decision', origin: 'relay', source: 'api_server', originLabel: 'Relay' };
  }

  async decide(approvalId: string, choice: ApprovalChoice, beforeEffect: () => void = () => {}): Promise<void> {
    beforeEffect();
    this.expireDue();
    const capturedEntry = this.inbox.get(approvalId);
    await this.decisions.ready();
    beforeEffect();
    const entry = this.inbox.get(approvalId);
    // Ledger writes may outlive a Turn. Never select an entry that arrived during this wait.
    if (entry && entry !== capturedEntry) throw new HermesError('conflict','Esta Aprobación cambió mientras se consultaba su Decisión.');
    if (entry?.deciding) throw new HermesError('conflict','Ya se está enviando esta Decisión.');
    const matches = (record: DecisionRecord) => record.origin === 'relay' && record.approvalId === approvalId;
    const records = this.decisions.list().filter(matches);
    const attempts = this.decisions.pending().filter(matches);
    for (const record of [...records, ...attempts]) {
      if (record.runId === null || record.id !== JSON.stringify(['relay',record.agentId,record.runId,approvalId])) {
        throw new HermesError('decision_store_unavailable','El registro de Decisiones de Relay no está disponible.');
      }
    }
    // The endpoint carries no Turn identity: an old replay cannot select a reused active id.
    const identities = new Set([...records, ...attempts].map(record => record.id));
    if (capturedEntry) identities.add(JSON.stringify(['relay',capturedEntry.approval.agentId,capturedEntry.approval.runId,approvalId]));
    if (identities.size > 1) throw new HermesError('conflict','La identidad de esta Aprobación es ambigua.');
    if (attempts.length) throw new HermesError('decision_uncertain','La Decisión quedó sin confirmar. No se enviará otra vez.');
    if (!entry || entry.resolution || records.length) {
      if (!records.length) throw new HermesError('not_found','Esta Aprobación es desconocida.');
      if (records.length !== 1 || records[0].actor !== 'person' || records[0].choice !== choice) {
        throw new HermesError('conflict','Esta Aprobación ya tiene otra Decisión.');
      }
      return;
    }
    const { approval } = entry;
    if (!approval.choices.includes(choice)) throw new HermesError('bad_request','La elección no está disponible para esta Aprobación.');
    entry.deciding = true;
    let sent = false; let prepared = false;
    entry.record = this.decisionRecord(entry,choice,'decision');
    const recordId = entry.record.id;
    try {
      await this.decisions.prepare(entry.record);
      prepared = true;
      beforeEffect();
      if (approval.expiresAt !== null && approval.expiresAt <= this.now()) {
        await this.resolveApproval(approvalId,'deny','expired',entry);
        throw new HermesError('conflict','Esta Aprobación expiró sin respuesta.');
      }
      sent = true;
      await this.hermes.resolveApproval(approval.agentId,approval.runId,choice,entry.requestId);
      await this.resolveApproval(approvalId,entry.response ?? choice,'decision',entry);
    } catch (error) {
      if (!sent && prepared) await this.decisions.discard(recordId);
      if (!sent && !entry.response && !entry.resolution) entry.record = undefined;
      if (entry.response) await this.resolveApproval(approvalId,entry.response,'decision',entry);
      else if (error instanceof HermesError && (error.code === 'conflict' || error.code === 'not_found')) { await this.decisions.discard(recordId); this.dropApproval(approvalId,entry);
        if (error.code === 'not_found') throw new HermesError('conflict','Esta Aprobación ya no está pendiente.');
      }
      else if (sent) { entry.uncertain = true; this.changed(); throw new HermesError('decision_uncertain','La Decisión quedó sin confirmar. No se enviará otra vez.'); }
      throw error;
    } finally { entry.deciding = false; }
  }

  close(): void {
    for (const run of this.runs.values()) run.abort.abort();
    for (const entry of this.inbox.values()) this.timers.clear(entry.timer);
    for (const handle of this.cleanups) this.timers.clear(handle);
    this.inbox.clear();
    this.cleanups.clear();
  }

  // ---- upstream consumption -------------------------------------------------------------

  private async consume(run: Run): Promise<void> {
    if (run.consuming || run.done) return;
    run.consuming = true;
    let failures = 0;
    try {
      while (!run.done && !run.abort.signal.aborted) {
        try {
          const stream = this.hermes.runEvents(run.agent.id, run.runId, run.lastUpstreamSeq, run.abort.signal);
          for await (const event of stream) {
            if (run.abort.signal.aborted) return;
            if (typeof event.seq === 'number' && Number.isSafeInteger(event.seq) && event.seq >= 0) {
              if (run.lastUpstreamSeq !== null && event.seq <= run.lastUpstreamSeq) continue;
              if (run.lastUpstreamSeq !== null && event.seq > run.lastUpstreamSeq + 1) this.incomplete(run, 'upstream_replay_lost');
              run.lastUpstreamSeq = event.seq;
            } else run.unsequenced = true;
            failures = 0;
            this.connection(run, 'connected');
            if (event.event === 'run.completed' || event.event === 'run.failed' || event.event === 'run.cancelled' || event.event === 'run.interrupted') await this.resolveImageReceipt(run);
            await this.handle(run, event);
            if (run.done) return;
          }
        } catch {
          if (run.abort.signal.aborted) return;
          this.log('Hermes event stream unavailable.');
        }
        if (run.done || run.abort.signal.aborted) return;
        if (run.unsequenced || run.lastUpstreamSeq === null) this.incomplete(run, 'upstream_replay_lost');
        this.connection(run, 'reconnecting');
        let status;
        try { status = await this.hermes.runStatus(run.agent.id, run.runId); }
        catch { this.log('Hermes run status unavailable.'); }
        if (run.abort.signal.aborted || run.done) return;
        if (status === null) {
          this.incomplete(run, 'upstream_replay_lost');
          this.finish(run, { type: 'run.failed', error: 'Hermes ya no conoce este Turno.' }, false);
          return;
        }
        if (status && TERMINAL_STATUSES[status.status] === true) {
          await this.resolveImageReceipt(run);
          this.incomplete(run, 'upstream_replay_lost');
          this.connection(run, 'connected');
          const pending = { ...(status.pendingSteer ? { pendingSteer: status.pendingSteer } : {}), ...(status.runtime ? { runtime: status.runtime } : {}) };
          if (status.status === 'completed') this.finish(run, { type: 'run.completed', output: status.output ?? '', ...pending });
          else if (status.status === 'cancelled') this.finish(run, { type: 'run.cancelled', ...pending });
          else this.finish(run, { type: 'run.failed', error: status.error ?? 'El Turno falló.', ...pending });
          return;
        }
        failures += 1;
        if (failures > MAX_RECONNECTS) {
          this.connection(run, 'lost');
          return; // Keep the Turn and partial response available for explicit reconnect.
        }
        await this.sleep(Math.min(250 * 2 ** (failures - 1), 4000));
      }
    } finally { run.consuming = false; }
  }

  private connection(run: Run, connection: RunConnection): void {
    if (run.connection === connection) return;
    run.connection = connection;
    this.emit(run, { type: 'run.connection', connection });
  }

  private incomplete(run: Run, reason: 'upstream_replay_lost' | 'snapshot_limit'): void {
    if (!run.complete) return;
    run.complete = false;
    this.emit(run, { type: 'run.resync_required', reason });
  }

  private async handle(run: Run, event: UpstreamEvent): Promise<void> {
    switch (event.event) {
      case 'replay.truncated':
        this.incomplete(run, 'upstream_replay_lost');
        return;
      case 'run.started':
        run.phase = 'running';
        return;
      case 'run.stopping':
        run.phase = 'stopping';
        return;
      case 'message.delta': {
        const text = str(event.delta);
        if (text) this.emit(run, { type: 'message.delta', text });
        return;
      }
      case 'tool.started': {
        const tool = str(event.tool) || 'tool';
        const toolCallId = `${run.runId}:tool:${++run.toolCount}`;
        const open = run.openTools.get(tool) ?? [];
        open.push(toolCallId);
        run.openTools.set(tool, open);
        this.emit(run, { type: 'tool.started', toolCallId, tool, preview: str(event.preview) });
        return;
      }
      case 'tool.completed': {
        const tool = str(event.tool) || 'tool';
        // Hermes sends no call id, so a completion is matched to the oldest call of that tool
        // still running. A completion with no known start still gets an id of its own.
        const toolCallId = run.openTools.get(tool)?.shift() ?? `${run.runId}:tool:${++run.toolCount}`;
        this.emit(run, {
          type: 'tool.completed',
          toolCallId,
          tool,
          durationSeconds: typeof event.duration === 'number' ? event.duration : 0,
          error: event.error === true,
          preview: str(event.preview),
        });
        return;
      }
      case 'approval.request':
        this.addApproval(run, event);
        return;
      case 'approval.responded':
        await this.onResponded(run, event);
        return;
      case 'run.completed':
        this.finish(run, { type: 'run.completed', output: str(event.output), ...terminalMetadata(event) });
        return;
      case 'run.failed':
        this.finish(run, { type: 'run.failed', error: str(event.error) || 'El Turno falló.', ...terminalMetadata(event) });
        return;
      case 'run.interrupted':
        this.finish(run, { type: 'run.failed', error: str(event.error) || 'El Turno se interrumpió.', ...terminalMetadata(event) });
        return;
      case 'run.cancelled':
        this.finish(run, { type: 'run.cancelled', ...terminalMetadata(event) });
        return;
      default:
        // Raw run.steered proves queue acceptance but has no request identity.
        // Only a successful steer HTTP receipt emits the correlated local event.
        return;
    }
  }

  private emit(run: Run, event: ChatRunEvent): void {
    const terminal = event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled';
    if (run.events.length >= MAX_EVENTS_PER_RUN - 2 && !terminal && event.type !== 'run.resync_required') {
      this.incomplete(run, 'snapshot_limit');
      return;
    }
    this.materialize(run, event);
    const seq = run.events.push(event) - 1;
    for (const subscriber of [...run.subscribers]) {
      try {
        subscriber.listener(seq, event);
      } catch (error) {
        this.log(`run ${run.runId}: subscriber failed: ${message(error)}`);
        run.subscribers.delete(subscriber);
      }
    }
  }

  private finish(run: Run, event: ChatRunTerminal, observed = true): void {
    if (run.done) return;
    for (const [id, entry] of this.inbox) {
      if (entry.approval.runId === run.runId) this.dropApproval(id);
    }
    this.emit(run, event);
    run.done = true;
    this.changed();
    if (observed && (event.type === 'run.completed' || event.type === 'run.failed')) {
      const observation: TerminalObservation = { id: run.observationId, outcome: event.type === 'run.completed' ? 'completed' : 'failed', at: this.now() };
      for (const observer of this.terminalObservers) {
        void observer(observation).catch(() => this.log('Turn notification unavailable.'));
      }
    }
    run.abort.abort();
    for (const subscriber of [...run.subscribers]) subscriber.onClose();
    run.subscribers.clear();
    // Keep the finished run around for a while so a reconnecting client can replay it.
    const handle = this.timers.set(() => {
      this.cleanups.delete(handle);
      this.runs.delete(run.runId);
    }, FINISHED_RUN_TTL_MS);
    this.cleanups.add(handle);
  }


  private materialize(run: Run, event: ChatRunEvent): void {
    const at = this.now();
    if (event.type === 'message.delta') {
      const last = run.items.at(-1);
      if (last?.kind === 'assistant') last.text += event.text;
      else run.items.push({ kind: 'assistant', id: `${run.runId}:message:${++run.messageCount}`, text: event.text, at, runId: run.runId });
    } else if (event.type === 'tool.started') {
      run.items.push({ kind: 'tool', id: event.toolCallId, tool: event.tool, preview: event.preview, status: 'running', durationSeconds: null, result: null, at });
    } else if (event.type === 'tool.completed') {
      const item = run.items.find((item) => item.kind === 'tool' && item.id === event.toolCallId);
      if (item?.kind === 'tool') {
        item.status = event.error ? 'error' : 'done'; item.durationSeconds = event.durationSeconds; item.result = event.preview;
      } else run.items.push({ kind: 'tool', id: event.toolCallId, tool: event.tool, preview: event.preview, status: event.error ? 'error' : 'done', durationSeconds: event.durationSeconds, result: event.preview, at });
    } else if (event.type === 'approval.request') {
      run.phase = 'waiting_for_approval';
      const tool = run.items.findLast((item) => item.kind === 'tool' && item.status === 'running');
      if (tool?.kind === 'tool') tool.status = 'waiting';
    } else if (event.type === 'approval.resolved') {
      run.phase = 'running';
      for (const entry of this.inbox.values()) {
        if (entry.approval.runId === run.runId) { run.phase = 'waiting_for_approval'; break; }
      }
      const tool = run.items.findLast((item) => item.kind === 'tool' && item.status === 'waiting');
      if (tool?.kind === 'tool') tool.status = event.choice === 'deny' ? 'error' : 'running';
    } else if (event.type === 'run.steered') {
      const receipt = run.steers.get(event.requestId);
      if (receipt) run.items.push({ kind: 'user', id: `${run.runId}:steer:${event.requestId}`, text: receipt.input, at, runId: run.runId, clientMessageId: event.requestId, redirected: true });
    } else if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
      run.phase = event.type === 'run.completed' ? 'completed' : event.type === 'run.cancelled' ? 'cancelled' : 'failed';
      run.terminal = event;
      if (event.type === 'run.completed' && event.output) {
        const assistant = run.items.at(-1);
        if (assistant?.kind === 'assistant') { assistant.text = event.output; if (event.runtime) assistant.runtime = event.runtime; }
        else run.items.push({ kind: 'assistant', id: `${run.runId}:message:${++run.messageCount}`, text: event.output, at, runId: run.runId, ...(event.runtime ? { runtime: event.runtime } : {}) });
      }
    }
  }
  // ---- approvals inbox ------------------------------------------------------------------

  private addApproval(run: Run, event: UpstreamEvent): void {
    const requestId = str(event.request_id) || null;
    const id = requestId ?? `${run.runId}:approval:${++run.approvalCount}`;
    if (this.inbox.has(id) || this.decisions.list().some(record => record.id === JSON.stringify(['relay',run.agent.id,run.runId,id]))) return; // resolved or pending replay

    const offered = Array.isArray(event.choices) ? event.choices : [];
    const choices = CHOICES.filter((choice) => offered.includes(choice));
    const createdAt = typeof event.timestamp === 'number' ? Math.round(event.timestamp * 1000) : this.now();
    const description = str(event.description) || null;
    const approval: Approval = {
      id,
      runId: run.runId,
      agentId: run.agent.id,
      agentName: run.agent.name,
      command: str(event.command),
      cwd: null, // Hermes does not send the working directory
      reason: null,
      affects: null,
      risk: riskFor(str(event.pattern_key) || null, description),
      createdAt,
      expiresAt: createdAt + run.approvalTimeoutMs,
      choices: choices.length > 0 ? choices : ['once', 'deny'],
    };
    const timer = this.timers.set(
      () => { if (!this.inbox.get(id)?.deciding && !this.inbox.get(id)?.uncertain) void this.resolveApproval(id, 'deny', 'expired').catch(() => this.log('Decision persistence unavailable.')); },
      Math.max(approval.expiresAt! - this.now(), 0),
    );
    this.inbox.set(id, { approval, requestId, timer });
    this.changed();
    this.emit(run, { type: 'approval.request', approval });
    for (const notifier of [this.notifier,...this.approvalNotifiers]) notifier.approvalCreated(approval).catch((error) => {
      this.log(`approval ${id}: notification failed: ${message(error)}`);
    });
  }

  private async onResponded(run: Run, event: UpstreamEvent): Promise<void> {
    const choice = CHOICES.find((candidate) => candidate === event.choice);
    if (!choice) return;
    const requestId = str(event.request_id);
    if (requestId) {
      for (const [id, entry] of this.inbox) {
        if (entry.approval.runId === run.runId && entry.requestId === requestId) {
          if (entry.deciding) entry.response = choice; else await this.resolveApproval(id,choice,'decision');
        }
      }
      return;
    }
    // No request id: Hermes resolved the oldest `resolved` requests of this run's session.
    const count = typeof event.resolved === 'number' && event.resolved > 0 ? event.resolved : 1;
    const oldestFirst = [...this.inbox.values()]
      .filter((entry) => entry.approval.runId === run.runId)
      .sort((a, b) => a.approval.createdAt - b.approval.createdAt);
    for (const entry of oldestFirst.slice(0, count)) { if (entry.deciding) entry.response = choice; else await this.resolveApproval(entry.approval.id,choice,'decision'); }
  }

  // A captured confirmation survives Turn cleanup. Its promise serializes HTTP/SSE evidence,
  // and removal checks entry identity so a reused approval id keeps its new pending entry.
  private async resolveApproval(id: string, choice: ApprovalChoice, resolution: ApprovalResolution, captured?: PendingApproval): Promise<void> {
    const entry = captured ?? this.inbox.get(id);
    if (!entry) return;
    if (entry.resolution) return entry.resolution;
    const operation = (async () => {
      await this.decisions.append(this.decisionRecord(entry,choice,resolution));
      this.dropApproval(id,entry);
      const run = this.runs.get(entry.approval.runId);
      if (run && !run.done) this.emit(run,{type:'approval.resolved',approvalId:id,choice,resolution});
    })();
    entry.resolution = operation;
    try { await operation; } catch (error) { entry.resolution = undefined; throw error; }
  }

  private dropApproval(id: string, expected?: PendingApproval): PendingApproval | null {
    const entry = this.inbox.get(id);
    if (!entry || expected && entry !== expected) return null;
    this.inbox.delete(id);
    this.changed();
    this.timers.clear(entry.timer);
    return entry;
  }

  // Hermes fails closed when nobody answers in time, so an expired approval is a deny.
  private expireDue(): void {
    const now = this.now();
    for (const [id, entry] of this.inbox) {
      if (!entry.deciding && !entry.uncertain && !entry.resolution && entry.approval.expiresAt !== null && entry.approval.expiresAt <= now) void this.resolveApproval(id, 'deny', 'expired').catch(() => this.log('Decision persistence unavailable.'));
    }
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pendingSteer(event: UpstreamEvent): { pendingSteer?: string } {
  return typeof event.pending_steer === 'string' && event.pending_steer ? { pendingSteer: event.pending_steer } : {};
}

function terminalMetadata(event: UpstreamEvent): import('../../protocol/protocol.ts').RunTerminalMetadata {
  const runtime = event.runtime && typeof event.runtime === 'object' ? Object.fromEntries(Object.entries(event.runtime)) : null;
  const selection = runtime && { provider: runtime.provider, model: runtime.model };
  return { ...pendingSteer(event), ...(isModelSelection(selection) ? { runtime: selection } : {}) };
}
