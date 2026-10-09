import type { Conversation, ModelSelection, ConversationQuery, ConversationSearchHit, ConversationTranscript, RunRequest, RunSnapshot, TranscriptItem } from '../../../protocol/protocol.ts';
import { RelayError, type RelayClient } from './client.ts';
import { demoConnectionError } from './demoConnection.ts';
import { previewWithoutNotes, withFileNotes } from '../../../protocol/chatFiles.ts';

export const DEMO_CONVERSATION_SCENARIOS = [
  { id: 'populated', name: 'Conversaciones' }, { id: 'empty', name: 'Sin conversaciones' },
  { id: 'loading', name: 'Cargando' }, { id: 'error', name: 'Error de lectura' }, { id: 'offline', name: 'Sin respuesta' },
] as const;
export type DemoConversationScenario = (typeof DEMO_CONVERSATION_SCENARIOS)[number]['id'];
interface Entry { conversation: Conversation; items: TranscriptItem[]; revision: number; seed?: boolean }
interface World { agents: Map<string, Entry[]>; receipts: Map<string, { agentId: string; id: string }>; runs: Map<string, { agentId: string; id: string; stopped: boolean }>; sequence: number }
const worlds = new Map<string, World>();
const scenarios = new Map<string, DemoConversationScenario>();

export function demoConversationScenario(serverId: string): DemoConversationScenario {
  return scenarios.get(serverId) ?? 'populated';
}
export function setDemoConversationScenario(serverId: string, scenario: DemoConversationScenario) {
  scenarios.set(serverId, scenario); worlds.delete(serverId);
}
export function resetDemoConversations() { worlds.clear(); scenarios.clear(); }

/** Model selection shares the same durable demo world as Conversation reads and Turns. */
export function updateDemoConversationModel(serverId: string, agentId: string, conversationId: string, model: ModelSelection | null): Conversation {
  const failure = demoConnectionError(serverId);
  if (failure) throw failure;
  const row = worlds.get(serverId)?.agents.get(agentId)?.find((entry) => entry.conversation.id === conversationId);
  if (!row) throw new RelayError('conversation_not_found', 'La conversación ya no existe.', 404);
  if (!row.conversation.writable || row.conversation.origin !== 'relay' || row.conversation.state !== 'ready') throw new RelayError('conversation_read_only', 'Esta conversación es de solo lectura.', 403);
  row.conversation.model = model ? { ...model } : null;
  row.revision++;
  return { ...row.conversation };
}

export type DemoConversationClient = Pick<RelayClient, 'transcript' | 'conversations' | 'conversation' | 'createConversation' | 'renameConversation' | 'conversationDeletion' | 'deleteConversation' | 'searchConversations' | 'startRun'>;

/** The Turn demo writes to the same Conversation world as the selection/rename/delete adapter. */
export function recordDemoTurn(serverId: string, snapshot: RunSnapshot) {
  const world = worlds.get(serverId);
  const run = world?.runs.get(snapshot.runId);
  const row = run && world?.agents.get(run.agentId)?.find((entry) => entry.conversation.id === run.id);
  if (!row || !run) return;
  const start = row.items.findIndex((item) => item.kind === 'user' && item.runId === snapshot.runId);
  row.items = [...row.items.slice(0, start < 0 ? row.items.length : start), ...snapshot.items];
  row.seed = false; row.revision++;
  row.conversation.messageCount = row.items.length;
  row.conversation.lastActiveAt = row.items.at(-1)?.at ?? row.conversation.lastActiveAt;
  row.conversation.preview = row.items.filter((item) => item.kind === 'assistant').at(-1)?.text ?? row.conversation.preview;
  if (snapshot.terminal) run.stopped = true;
}

export function createDemoConversations(serverId: string, now: () => number, seed: (agentId: string) => TranscriptItem[]): DemoConversationClient {
  const world = () => {
    let value = worlds.get(serverId);
    if (!value) { value = { agents: new Map(), receipts: new Map(), runs: new Map(), sequence: 0 }; worlds.set(serverId, value); }
    return value;
  };
  const guard = () => {
    const error = demoConnectionError(serverId);
    if (error) throw error;
    if (demoConversationScenario(serverId) === 'offline') throw new RelayError('timeout', 'Relay no alcanza al Servidor de demostración.');
  };
  const entries = (agentId: string): Entry[] => {
    const w = world();
    let rows = w.agents.get(agentId);
    if (rows) return rows;
    const fixtures = agentId === 'dev' ? [
      { id: 'demo-dev', title: 'Tests de integración rotos', source: 'api_server', originLabel: 'Relay', writable: true },
      { id: 'demo-dev-discord', title: 'Migrar a Node 22', source: 'discord', originLabel: 'Discord', text: 'Listo: actualicé .nvmrc y el workflow de CI a la versión 22. Las pruebas pasan.' },
      { id: 'demo-dev-terminal', title: 'Depurar fuga de memoria', source: 'terminal', originLabel: 'Terminal', text: 'El heap crece en el handler de reintentos.' },
      { id: 'demo-dev-caddy', title: 'Configurar Caddy como reverse proxy', source: 'api_server', originLabel: 'Relay', writable: true, text: 'Te dejo el Caddyfile final con TLS interno.' },
      { id: 'demo-dev-legacy', title: 'Cliente anterior de Hermes', source: 'api_server', originLabel: 'API de Hermes · sin recibo de Relay', text: 'Esta conversación anterior no tiene un recibo de creación de Relay.' },
      { id: 'demo-dev-deleting', title: 'Borrado pendiente', source: 'api_server', originLabel: 'Relay', writable: true, deleting: true, text: 'La respuesta del borrado se perdió; el panel ofrece Reintentar.' },
      { id: 'demo-dev-cron', title: 'Resumen diario de PRs', source: 'cron', originLabel: 'Tarea programada', background: true, text: '3 PRs abiertos; #212 necesita revisión.' },
      { id: 'demo-dev-subagent', title: 'Subagente · Revisar cobertura', source: 'subagent', originLabel: 'Subagente', background: true, text: 'La cobertura de src/db subió a 81 %.' },
    ] : [{ id: `demo-${agentId}`, title: 'Notas de investigación', source: 'api_server', originLabel: 'Relay', writable: true }];
    rows = demoConversationScenario(serverId) === 'empty' ? [] : fixtures.map((fixture, index): Entry => {
      const at = now() - index * 86_400_000;
      const items = 'text' in fixture && fixture.text ? [{ kind: 'assistant' as const, id: `${fixture.id}-message`, text: fixture.text, at }] : seed(agentId);
      const deleting = 'deleting' in fixture && fixture.deleting === true;
      return { conversation: { id: fixture.id, sessionId: fixture.id, title: fixture.title, source: fixture.source, origin: fixture.writable ? 'relay' : 'external', originLabel: fixture.originLabel, kind: 'background' in fixture && fixture.background ? 'background' : 'interactive', writable: fixture.writable === true && !deleting, archived: false, hidden: false, state: deleting ? 'deleting' : 'ready', startedAt: at, lastActiveAt: at, messageCount: items.length, preview: items.length ? items.filter((item) => item.kind === 'assistant').at(-1)?.text ?? null : null, model: null }, items, revision: 1, seed: index === 0 };
    });
    w.agents.set(agentId, rows);
    return rows;
  };
  const find = (agentId: string, id: string) => {
    const entry = entries(agentId).find((row) => row.conversation.id === id || row.conversation.sessionId === id);
    if (!entry) throw new RelayError('conversation_not_found', 'La conversación ya no existe.', 404);
    return entry;
  };
  const hydrate = (agentId: string, entry: Entry) => {
    if (entry.seed) {
      entry.items = seed(agentId);
      entry.conversation.messageCount = entry.items.length;
    }
    return entry;
  };
  const read = async () => {
    guard();
    const scenario = demoConversationScenario(serverId);
    if (scenario === 'loading') {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 1500); await promise;
    }
    if (scenario === 'error') throw new RelayError('conversation_store_unavailable', 'No se pudieron leer las conversaciones de demostración. Reintenta.', 503);
  };
  const ordered = (agentId: string, query: ConversationQuery = {}) => entries(agentId)
    .map((entry) => hydrate(agentId, entry))
    .filter((entry) => (entry.conversation.kind === 'background') === (query.background ?? false))
    .sort((a, b) => b.conversation.lastActiveAt - a.conversation.lastActiveAt || b.conversation.id.localeCompare(a.conversation.id));
  const busy = (id: string) => Array.from(world().runs.values()).some((run) => run.id === id && !run.stopped);

  return {
    async transcript(agentId, sessionId): Promise<ConversationTranscript> {
      guard();
      const entry = sessionId ? find(agentId, sessionId) : ordered(agentId)[0];
      if (!entry) return { sessionId: null, conversation: null, items: [] };
      hydrate(agentId, entry);
      return { sessionId: entry.conversation.sessionId, conversation: { ...entry.conversation }, items: [...entry.items] };
    },
    async conversations(agentId, query = {}) {
      await read();
      const rows = ordered(agentId, query); const offset = query.offset ?? 0; const limit = query.limit ?? 50;
      return { conversations: rows.slice(offset, offset + limit).map((row) => ({ ...row.conversation })), nextOffset: offset + limit < rows.length ? offset + limit : null };
    },
    async conversation(agentId, conversationId) { guard(); return { ...hydrate(agentId, find(agentId, conversationId)).conversation }; },
    async createConversation(agentId, request) {
      guard();
      const w = world(); const receipt = w.receipts.get(request.requestId);
      if (receipt) {
        if (receipt.agentId !== agentId) throw new RelayError('request_conflict', 'La solicitud ya pertenece a otro Agente.', 409);
        return { ...find(agentId, receipt.id).conversation };
      }
      const id = `demo-${agentId}-new-${++w.sequence}`;
      const conversation: Conversation = { id, sessionId: id, title: null, source: 'api_server', origin: 'relay', originLabel: 'Relay', kind: 'interactive', writable: true, archived: false, hidden: false, state: 'ready', startedAt: now(), lastActiveAt: now(), messageCount: 0, preview: null, model: null };
      entries(agentId).push({ conversation, items: [], revision: 1 }); w.receipts.set(request.requestId, { agentId, id });
      return { ...conversation };
    },
    async renameConversation(agentId, conversationId, request) {
      guard(); const title = request.title.trim();
      if (!title || Array.from(title).length > 100) throw new RelayError('invalid_title', 'El título debe tener entre 1 y 100 caracteres.', 400);
      const row = find(agentId, conversationId);
      if (entries(agentId).some((entry) => entry !== row && entry.conversation.title === title)) throw new RelayError('upstream_failure', 'Hermes: ya existe una conversación con ese título.', 502);
      row.conversation.title = title; row.revision++; return { ...row.conversation };
    },
    async conversationDeletion(agentId, conversationId) {
      guard(); const row = hydrate(agentId, find(agentId, conversationId));
      if (busy(row.conversation.id)) throw new RelayError('conversation_busy', 'La conversación tiene un Turno en marcha.', 409);
      return { conversationId: row.conversation.id, messageCount: row.items.length, conversationCount: 1, revision: `demo-${row.revision}-${row.items.length}` };
    },
    async deleteConversation(agentId, conversationId, request) {
      guard(); const row = hydrate(agentId, find(agentId, conversationId));
      if (busy(row.conversation.id)) throw new RelayError('conversation_busy', 'La conversación tiene un Turno en marcha.', 409);
      if (request.revision !== `demo-${row.revision}-${row.items.length}`) throw new RelayError('conversation_changed', 'La conversación cambió desde la confirmación.', 409);
      const rows = entries(agentId); rows.splice(rows.indexOf(row), 1);
      return { conversationId: row.conversation.id, deleted: true, messageCount: row.items.length };
    },
    async searchConversations(agentId, query) {
      await read(); const term = query.q.trim().toLocaleLowerCase();
      if (!term || Array.from(term).length > 200) throw new RelayError('invalid_query', 'Escribe una búsqueda de hasta 200 caracteres.', 400);
      const hits: ConversationSearchHit[] = [];
      for (const row of ordered(agentId, query)) {
        if (row.conversation.title?.toLocaleLowerCase().includes(term)) {
          hits.push({ conversation: { ...row.conversation }, match: 'title', messageId: null, snippet: row.conversation.title });
          continue;
        }
        const message = row.items.find((item) => (item.kind === 'user' || item.kind === 'assistant') && item.text.toLocaleLowerCase().includes(term));
        if (message && (message.kind === 'user' || message.kind === 'assistant')) {
          hits.push({ conversation: { ...row.conversation }, match: 'message', messageId: message.id, snippet: message.text });
        }
      }
      const offset = query.offset ?? 0; const limit = query.limit ?? 50;
      return { hits: hits.slice(offset, offset + limit), nextOffset: offset + limit < hits.length ? offset + limit : null };
    },
    async startRun(agentId, request: RunRequest) {
      guard();
      if (!request.sessionId) throw new RelayError('invalid_request', 'Crea una conversación antes de enviar.', 400);
      const row = hydrate(agentId, find(agentId, request.sessionId));
      if (!row.conversation.writable) throw new RelayError('conversation_read_only', 'Esta conversación es de solo lectura.', 403);
      if (busy(row.conversation.id)) throw new RelayError('conversation_busy', 'La conversación tiene un Turno en marcha.', 409);
      // #114: like the Puente, Puente data is refused and the files become notes at the start of the message.
      if (request.files?.some((file) => file.path.startsWith('/home/user/.config/relay/'))) throw new RelayError('remote_bridge_protected', 'Los datos del Puente no se adjuntan.', 403);
      const text = withFileNotes(request.input, request.files?.map((file) => file.path) ?? []);
      row.seed = false; const runId = `demo-run-${++world().sequence}`;
      row.items.push({ kind: 'user', id: `${runId}-user`, text, at: now(), runId }); row.revision++;
      row.conversation.messageCount = row.items.length; row.conversation.lastActiveAt = now(); row.conversation.preview = previewWithoutNotes(text);
      world().runs.set(runId, { agentId, id: row.conversation.id, stopped: false });
      return { runId, sessionId: row.conversation.sessionId, conversationId: row.conversation.id, inputMessageId: `${runId}-user` };
    },
  };
}
