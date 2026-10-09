import type { ChatRunEvent, ModelSelection, RunSnapshot } from '../../../protocol/protocol.ts';
import { withFileNotes } from '../../../protocol/chatFiles.ts';
import { RelayError, type RelayClient } from './client.ts';
import { demoModelOptions } from './demoModels.ts';
import { demoConnectionError } from './demoConnection.ts';
import { recordDemoTurn, type DemoConversationClient } from './demoConversations.ts';
import { DEMO_MARKDOWN } from './demoMarkdown.ts';
import { applyRunEvent } from './transcript.ts';

export const DEMO_TURN_SCENARIOS = [
  { id: 'normal', name: 'Conversación actual' }, { id: 'working', name: 'Trabajando' },
  { id: 'redirected', name: 'Redirigido' }, { id: 'rejected', name: 'Redirección rechazada' },
  { id: 'lost', name: 'Conexión perdida' }, { id: 'recovered', name: 'Respuesta recuperada' },
  { id: 'unavailable', name: 'Chat no disponible' }, { id: 'loading', name: 'Cargando conversación…' },
  { id: 'empty', name: 'Conversación vacía' }, { id: 'error', name: 'Error al cargar' },
  { id: 'markdown', name: 'Markdown completo' },
] as const;
export type DemoTurnScenario = (typeof DEMO_TURN_SCENARIOS)[number]['id'];
interface DemoTurn {
  runtime: ModelSelection;
  state: RunSnapshot;
  events: { id: number; event: ChatRunEvent }[];
  subscribers: Set<(event: ChatRunEvent) => void>;
  done: Set<() => void>;
  /** Keeps writing until stopped: research's demo Turno, so its Conversación shows the voice box. */
  writes: boolean;
}
/** What the demo sends for research when its Conversación opens. */
export const DEMO_WRITING_PROMPT = 'Busca lo nuevo sobre KV-cache y resúmelo.';
const scenarios = new Map<string, DemoTurnScenario>();
const worlds = new Map<string, Map<string, DemoTurn>>();
export function demoTurnScenario(serverId: string): DemoTurnScenario { return scenarios.get(serverId) ?? 'normal'; }
export function setDemoTurnScenario(serverId: string, scenario: DemoTurnScenario) { scenarios.set(serverId, scenario); }
export function resetDemoTurns() { scenarios.clear(); worlds.clear(); }

export function createDemoTurns(serverId: string, now: () => number, conversations: DemoConversationClient): Pick<RelayClient, 'agentChat' | 'transcript' | 'startRun' | 'runEvents' | 'stopRun' | 'steerRun' | 'runSnapshot' | 'reconnectRun'> {
  const runs = worlds.get(serverId) ?? new Map<string, DemoTurn>();
  worlds.set(serverId, runs);
  const find = (runId: string) => {
    const failure = demoConnectionError(serverId);
    if (failure) throw failure;
    const run = runs.get(runId);
    if (!run) throw new RelayError('run_not_found', 'El Turno de demostración ya no existe.', 404);
    return run;
  };
  const emit = (run: DemoTurn, event: ChatRunEvent) => {
    if (event.type === 'run.completed') event = { ...event, runtime: run.runtime };
    run.events.push({ id: ++run.state.lastEventId, event });
    run.state.items = applyRunEvent(run.state.items, event, now(), run.state.runId);
    let message = 0;
    run.state.items = run.state.items.map((item) => ({ ...item, runId: run.state.runId, ...(item.kind === 'assistant' ? { id: `${run.state.runId}:message:${++message}` } : {}) }));
    if (event.type === 'run.connection') run.state.connection = event.connection;
    if (event.type === 'run.resync_required') run.state.complete = false;
    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
      run.state.terminal = event;
      run.state.phase = event.type === 'run.completed' ? 'completed' : event.type === 'run.failed' ? 'failed' : 'cancelled';
    }
    recordDemoTurn(serverId, run.state);
    for (const subscriber of run.subscribers) subscriber(event);
    if (run.state.terminal) for (const done of run.done) done();
  };
  return {
    async agentChat() {
      const failure = demoConnectionError(serverId); if (failure) throw failure;
      return demoTurnScenario(serverId) === 'unavailable' ? { available: false, reason: 'Este Agente tiene apagada la función de chat. Actívala en Hermes para conversar desde Relay.' } : { available: true, reason: null };
    },
    async transcript(agentId, sessionId) {
      const scenario = demoTurnScenario(serverId);
      if (scenario === 'loading') await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      if (scenario === 'error') throw new RelayError('upstream_failure', 'El Servidor respondió con un error al pedir los mensajes.', 502);
      if (scenario === 'empty' && !sessionId) {
        const created = await conversations.createConversation(agentId, { requestId: '00000000-0000-4000-8000-000000000037' });
        return conversations.transcript(agentId, created.sessionId);
      }
      const transcript = await conversations.transcript(agentId, sessionId);
      if (scenario === 'empty') return { ...transcript, items: [] };
      if (scenario === 'markdown') return { ...transcript, items: [{ kind: 'assistant', id: 'demo-markdown', text: DEMO_MARKDOWN, at: now() }] };
      return transcript;
    },
    async startRun(agentId, request) {
      const conversation = request.sessionId ? await conversations.conversation(agentId, request.sessionId) : null;
      const runtime = conversation?.model ?? demoModelOptions(agentId).defaultModel;
      const created = await conversations.startRun(agentId, request);
      if (created.sessionId === null) throw new Error('El Turno demo no tiene Conversación.');
      runs.set(created.runId, {
        runtime: { ...runtime },
        state: { runId: created.runId, conversationId: created.conversationId ?? created.sessionId, sessionId: created.sessionId,
          phase: 'running', connection: 'connected', lastEventId: -1, complete: true, steers: [], terminal: null,
          items: [{ kind: 'user', id: created.inputMessageId ?? `${created.runId}:input`, runId: created.runId, text: withFileNotes(request.input, request.files?.map((file) => file.path) ?? []), at: now() }] },
        events: [], subscribers: new Set(), done: new Set(), writes: agentId === 'research' && request.input === DEMO_WRITING_PROMPT,
      });
      return created;
    },
    async runEvents(runId, onEvent, signal, afterEventId) {
      const run = find(runId);
      for (const frame of run.events) if (frame.id > (afterEventId ?? -1) && !signal?.aborted) onEvent(frame.event);
      if (signal?.aborted || run.state.terminal) return;
      const { promise, resolve } = Promise.withResolvers<void>();
      run.subscribers.add(onEvent); run.done.add(resolve);
      const abort = () => resolve();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const scenario = demoTurnScenario(serverId);
        if (afterEventId !== undefined && run.state.connection === 'connected') {
          emit(run, { type: 'message.delta', text: ' y recuperada sin reenviar tu mensaje.' });
          emit(run, { type: 'run.completed', output: 'Respuesta parcial y recuperada sin reenviar tu mensaje.' });
        } else if (!run.events.length) {
          if (run.writes) {
            emit(run, { type: 'message.delta', text: 'Leo los tres papers nuevos sobre cuantización de KV-cache y te resumo lo importante' });
          } else if (scenario === 'normal') {
            const text = 'Esto es el modo demo: conecta un Servidor real para hablar con el Agente.';
            emit(run, { type: 'message.delta', text }); emit(run, { type: 'run.completed', output: text });
          } else if (scenario === 'lost' || scenario === 'recovered') {
            emit(run, { type: 'message.delta', text: 'Respuesta parcial' });
            emit(run, { type: 'run.resync_required', reason: 'upstream_replay_lost' });
            emit(run, { type: 'run.connection', connection: 'lost' });
          } else {
            emit(run, { type: 'message.delta', text: 'Reproduzco el fallo primero.' });
            emit(run, { type: 'tool.started', toolCallId: `${runId}:tool:0`, tool: 'terminal', preview: 'npm test -- integration' });
            emit(run, { type: 'tool.completed', toolCallId: `${runId}:tool:0`, tool: 'terminal', preview: '{"output":"FAIL src/db/client.test.ts\\nTypeError: createPool is not a function","exit_code":1}', durationSeconds: 14.3, error: true });
            emit(run, { type: 'message.delta', text: 'Corrijo el mock y vuelvo a correr la suite.' });
          }
        }
        await promise;
      } finally { run.subscribers.delete(onEvent); run.done.delete(resolve); signal?.removeEventListener('abort', abort); }
    },
    async steerRun(runId, request) {
      const run = find(runId);
      const receipt = run.state.steers.find((receipt) => receipt.requestId === request.requestId);
      if (receipt?.status === 'accepted') return { runId, requestId: request.requestId, accepted: true };
      if (run.state.terminal || demoTurnScenario(serverId) === 'rejected') throw new RelayError('run_not_accepting_steer', 'El Turno no admite esta redirección. La instrucción no se entregó.', 409);
      run.state.steers.push({ requestId: request.requestId, status: 'accepted' });
      run.state.items.push({ kind: 'user', id: `${runId}:steer:${request.requestId}`, runId, clientMessageId: request.requestId, redirected: true, text: request.input, at: now() });
      emit(run, { type: 'run.steered', requestId: request.requestId, accepted: true });
      emit(run, { type: 'message.delta', text: 'Recibido. Me concentro en la integración y sigo trabajando.' });
      return { runId, requestId: request.requestId, accepted: true };
    },
    async stopRun(runId) { const run = find(runId); if (!run.state.terminal) { run.state.phase = 'stopping'; emit(run, { type: 'run.cancelled' }); } },
    async runSnapshot(runId) {
      const state = find(runId).state;
      return { ...state, items: state.items.map((item) => ({ ...item })), steers: state.steers.map((receipt) => ({ ...receipt })) };
    },
    async reconnectRun(runId) {
      const run = find(runId);
      if (!run.state.terminal && demoTurnScenario(serverId) !== 'lost') emit(run, { type: 'run.connection', connection: 'connected' });
      return { ...run.state, items: run.state.items.map((item) => ({ ...item })), steers: run.state.steers.map((receipt) => ({ ...receipt })) };
    },
  };
}
