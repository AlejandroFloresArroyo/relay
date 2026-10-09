// Logical conversations adapter for Hermes 0.21.5; SQL projections live in hermes_store.ts.
// Evidence: hermes_state_common.py:338–429; hermes_state_sessions.py:454–463,131–169;
// hermes_state_compression.py:120–146. Never instantiate SessionDB or migrate its schema.
import { createHash } from 'node:crypto';
import { readConversationRows, readDeletionRows } from './hermes_store.ts';
import type { SQLOutputValue } from 'node:sqlite';
import type { ConversationQuery, ConversationSearchQuery, DecisionRecord, TranscriptItem } from '../../protocol/protocol.ts';
import type { StoredConversation, StoredConversationPage, StoredConversationSearchPage, StoredDeletionPreview } from './chatPorts.ts';
import { HermesError } from './hermes.ts';
import type { Transcript } from './hermes.ts';
import { previewWithoutNotes, titleWithoutNotes } from '../../protocol/chatFiles.ts';

type Row = Record<string, SQLOutputValue>;
interface SessionRow extends Row {
  id: string; source: string; parent_session_id: string | null; model_config: string | null;
  title: string | null; end_reason: string | null; started_at: number; last_activity_at: number | null;
  ended_at: number | null; archived: number; hidden: number;
}
interface MessageRow extends Row {
  id: number; session_id: string; role: string; content: string | null;
  tool_calls: string | null; tool_call_id: string | null; timestamp: number;
  active: number; compacted: number; _compressed_summary: number;
}
interface Snapshot {
  sessions: SessionRow[];
  messages: MessageRow[];
  titleMatches: Set<string>;
  messageMatches: Set<string>;
}
interface Family {
  conversation: StoredConversation;
  sessions: SessionRow[];
  messages: MessageRow[];
  displayMessages: MessageRow[];
}
const BACKGROUND_SOURCES: Record<string, true> = { cron: true, subagent: true, kanban: true, tool: true, oneshot: true };
const RESET_REASONS: Record<string, true> = { session_reset: true, session_switch: true, idle: true, daily: true, suspended: true, resume_pending_expired: true };

function nullableText(value: SQLOutputValue): value is string | null {
  return value === null || typeof value === 'string';
}
function nullableNumber(value: SQLOutputValue): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function sessionRow(row: Row): SessionRow {
  if (typeof row.id !== 'string' || typeof row.source !== 'string' || !nullableText(row.parent_session_id) ||
      !nullableText(row.model_config) || !nullableText(row.title) || !nullableText(row.end_reason) ||
      typeof row.started_at !== 'number' || !Number.isFinite(row.started_at) || !nullableNumber(row.last_activity_at) ||
      !nullableNumber(row.ended_at) || typeof row.archived !== 'number' || typeof row.hidden !== 'number') {
    throw new Error('Invalid session row');
  }
  return { ...row, id: row.id, source: row.source, parent_session_id: row.parent_session_id,
    model_config: row.model_config, title: row.title === null ? null : titleWithoutNotes(row.title), end_reason: row.end_reason, started_at: row.started_at,
    last_activity_at: row.last_activity_at, ended_at: row.ended_at, archived: row.archived, hidden: row.hidden };
}

function messageRow(row: Row): MessageRow {
  if (typeof row.id !== 'number' || typeof row.session_id !== 'string' || typeof row.role !== 'string' ||
      !nullableText(row.content) || !nullableText(row.tool_calls) || !nullableText(row.tool_call_id) ||
      typeof row.timestamp !== 'number' || !Number.isFinite(row.timestamp) ||
      typeof row.active !== 'number' || typeof row.compacted !== 'number' || typeof row._compressed_summary !== 'number') throw new Error('Invalid message row');
  return { ...row, id: row.id, session_id: row.session_id, role: row.role, content: row.content,
    tool_calls: row.tool_calls, tool_call_id: row.tool_call_id, timestamp: row.timestamp,
    active: row.active, compacted: row.compacted, _compressed_summary: row._compressed_summary };
}

function messageText(content: unknown): string {
  if (typeof content !== 'string') return '';
  if (!content.startsWith('[')) return content;
  try {
    const parts: unknown = JSON.parse(content);
    if (!Array.isArray(parts)) return content;
    return parts.map((part: unknown) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if ('text' in part && typeof part.text === 'string') return part.text;
      return 'type' in part && part.type === 'image_url' ? '[image]' : '';
    }).filter(Boolean).join('\n');
  } catch {
    return content;
  }
}

function displayMessages(rows: MessageRow[]): MessageRow[] {
  const generations = new Map<string, MessageRow>();
  for (const row of [...rows].sort((a, b) => a.id - b.id)) {
    if ((row.active !== 1 && row.compacted !== 1) || row._compressed_summary !== 0 || row.display_kind === 'hidden') continue;
    const metadata = typeof row.display_metadata === 'string' ? JSON.parse(row.display_metadata) : null;
    if (metadata?.model_only) continue;
    const identity = row.display_identity;
    const key = identity instanceof Uint8Array
      ? Buffer.from(identity.buffer, identity.byteOffset, identity.byteLength).toString('hex')
      : JSON.stringify([row.role, row.content_identity ?? row.content, row.timestamp, row.tool_call_id, row.tool_calls, row.tool_name]);
    const previous = generations.get(key);
    if (!previous || row.active > previous.active || (row.active === previous.active && row.id > previous.id)) generations.set(key, row);
  }
  return [...generations.values()];
}

function config(row: SessionRow): Record<string, unknown> {
  if (!row.model_config) return {};
  const parsed: unknown = JSON.parse(row.model_config);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid metadata');
  return Object.fromEntries(Object.entries(parsed));
}

function readSnapshot(home: string, query?: string, purpose: 'index' | 'transcript' | 'decisions' | 'revision' = 'index', sessionIds?: string[]): Snapshot {
  try {
    const rows = purpose === 'revision' ? readDeletionRows(home) : readConversationRows(home, purpose, sessionIds);
    const sessions = rows.sessions.map(sessionRow), messages = rows.messages.map(messageRow);
    // Literal Unicode search over the same bounded, verified snapshot.
    const folded = query?.toUpperCase().toLowerCase();
    const titleMatches = new Set(folded === undefined ? [] : sessions.filter(row => typeof row.title === 'string' && row.title.toUpperCase().toLowerCase().includes(folded)).map(row => row.id));
    const messageMatches = new Set(folded === undefined ? [] : messages.filter(row => (row.active === 1 || row.compacted === 1) && row._compressed_summary === 0 && ['user', 'assistant'].includes(row.role) && messageText(row.content).toUpperCase().toLowerCase().includes(folded)).map(row => String(row.id)));
    return { sessions, messages, titleMatches, messageMatches };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: [], messages: [], titleMatches: new Set(), messageMatches: new Set() };
    throw new HermesError('chat_unavailable', 'The Hermes conversation store is unavailable.');
  }
}

function families(snapshot: Snapshot): Family[] {
  try {
    const byId = new Map(snapshot.sessions.map((row) => [String(row.id), row]));
    const metadata = new Map(snapshot.sessions.map((row) => [String(row.id), config(row)]));
    const checked = new Set<string>();
    for (const session of snapshot.sessions) {
      const seen = new Set<string>();
      let current: SessionRow | undefined = session;
      while (current && !checked.has(current.id)) {
        if (seen.has(current.id)) throw new Error('Cyclic lineage');
        seen.add(current.id);
        current = current.parent_session_id === null ? undefined : byId.get(current.parent_session_id);
      }
      for (const id of seen) checked.add(id);
    }
    const candidates = new Map<string, SessionRow[]>();
    const resumeParents = new Set<string>();
    for (const child of snapshot.sessions) {
      const parent = child.parent_session_id === null ? undefined : byId.get(child.parent_session_id);
      const markers = metadata.get(child.id)!;
      const legacyReset = parent && RESET_REASONS[parent.end_reason ?? ''] && typeof child.session_key === 'string'
        && child.session_key !== '' && child.session_key === parent.session_key;
      // Hermes's resume walk follows unmarked children even without compression or matching source.
      if (parent && child.source !== 'tool' && !legacyReset
        && ['_branched_from', '_delegate_from', '_reset_from'].every((key) => markers[key] == null)) resumeParents.add(parent.id);
      if (!parent || parent.end_reason !== 'compression' || child.source !== parent.source || child.source === 'tool') continue;
      if (['_branched_from', '_delegate_from', '_reset_from'].some((key) => markers[key] === parent.id)) continue;
      const children = candidates.get(parent.id) ?? [];
      children.push(child);
      candidates.set(parent.id, children);
    }
    // Ambiguity never chooses a speculative tip or propagates Relay ownership.
    const next = new Map<string, SessionRow>();
    const continuationIds = new Set<string>();
    for (const [id, children] of candidates) {
      if (children.length !== 1) continue;
      next.set(id, children[0]);
      continuationIds.add(children[0].id);
    }
    const messagesBySession = new Map<string, MessageRow[]>();
    for (const message of snapshot.messages) {
      if (!byId.has(message.session_id)) throw new Error('Orphaned message');
      const rows = messagesBySession.get(message.session_id) ?? [];
      rows.push(message);
      messagesBySession.set(message.session_id, rows);
    }
    const result: Family[] = [];
    for (const root of snapshot.sessions) {
      if (continuationIds.has(root.id)) continue;
      const sessions = [root];
      let tip = root;
      while (next.has(tip.id)) {
        tip = next.get(tip.id)!;
        sessions.push(tip);
      }
      const messages = sessions.flatMap((row) => messagesBySession.get(row.id) ?? [])
        .sort((a, b) => Number(a.timestamp) - Number(b.timestamp) || Number(a.id) - Number(b.id));
      const display = displayMessages(messages);
      const visible = display.filter((row) => (row.role === 'user' || row.role === 'assistant') && messageText(row.content).trim());
      const latest = visible.at(-1);
      const markers = metadata.get(root.id)!;
      const background = BACKGROUND_SOURCES[root.source] === true || markers._delegate_from != null;
      let lastActiveAt = root.started_at;
      for (const session of sessions) lastActiveAt = Math.max(lastActiveAt, session.started_at, session.last_activity_at ?? session.started_at);
      for (const message of messages) lastActiveAt = Math.max(lastActiveAt, message.timestamp);
      result.push({ sessions, messages, displayMessages: display, conversation: {
        id: root.id, sessionId: tip.id, source: root.source, createdSource: root.source,
        title: [...sessions].reverse().find((row) => row.title != null)?.title ?? null,
        kind: background ? 'background' : 'interactive', hidden: root.hidden === 1, archived: root.archived === 1,
        startedAt: Math.round(Number(root.started_at) * 1000), lastActiveAt: Math.round(lastActiveAt * 1000),
        messageCount: messages.length, preview: latest ? previewWithoutNotes(messageText(latest.content)).slice(0, 280) : null,
        sessionIds: sessions.map((row) => row.id),
        // Never send to a tip whose upstream resume resolver can leave the verified family.
        continuationUncertain: (candidates.get(tip.id)?.length ?? 0) > 1 || resumeParents.has(tip.id),
      } });
    }
    return result.sort((a, b) => b.conversation.lastActiveAt - a.conversation.lastActiveAt || (a.conversation.id < b.conversation.id ? 1 : a.conversation.id > b.conversation.id ? -1 : 0));
  } catch {
    throw new HermesError('chat_unavailable', 'The Hermes conversation store is unavailable.');
  }
}

function paginate<T>(items: T[], query: ConversationQuery): { items: T[]; nextOffset: number | null } {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 50;
  return { items: items.slice(offset, offset + limit), nextOffset: offset + limit < items.length ? offset + limit : null };
}

function rowRevision(session: Row, messages: Row[]): string {
  const hash = createHash('sha256');
  // All columns, including private content, are hashed only in process memory, never persisted/logged.
  for (const row of [session, ...messages]) {
    hash.update(JSON.stringify(Object.keys(row).sort().map((key) => [key, row[key] instanceof Uint8Array ? Array.from(row[key]) : row[key]])));
    hash.update('\n');
  }
  return hash.digest('hex');
}

export class HermesConversations {
  private home: string;
  constructor(home: string) { this.home = home; }

  /** Pinned terminal JSON annotation is consent evidence; stdout is never inspected. */
  decisionHistory(profile: string): DecisionRecord[] {
    try {
      const snapshot = readSnapshot(this.home, undefined, 'decisions');
      const sessions = new Map(snapshot.sessions.map(row => [row.id,row]));
      const calls = new Map<string,{command:string; at:number}>();
      const records: DecisionRecord[] = [];
      const labels: Record<string,string> = {discord:'Discord',cli:'Terminal',terminal:'Terminal',api_server:'API de Hermes',telegram:'Telegram',slack:'Slack',whatsapp:'WhatsApp',cron:'Tarea programada'};
      for (const row of displayMessages(snapshot.messages).sort((a,b) => a.timestamp-b.timestamp || a.id-b.id)) {
        if (row.role === 'assistant' && row.tool_calls) {
          const parsed: unknown = JSON.parse(row.tool_calls);
          if (!Array.isArray(parsed)) throw new Error('Invalid calls');
          for (const call of parsed) {
            if (call?.function?.name !== 'terminal' || typeof call.id !== 'string') continue;
            const args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments;
            if (typeof args?.command === 'string' && args.command.length > 0) calls.set(JSON.stringify([row.session_id,call.id]),{command:args.command,at:row.timestamp});
          }
        }
        if (row.role !== 'tool' || row.tool_name !== 'terminal' || !row.tool_call_id || !row.content) continue;
        const call = calls.get(JSON.stringify([row.session_id,row.tool_call_id]));
        if (!call || call.at > row.timestamp) continue;
        let result: unknown;
        try { result = JSON.parse(row.content); } catch { continue; }
        if (!result || typeof result !== 'object' || Array.isArray(result) || !('exit_code' in result) || typeof result.exit_code !== 'number' || !Number.isSafeInteger(result.exit_code)
          || !('output' in result) || typeof result.output !== 'string' || ('status' in result && result.status === 'blocked')) continue;
        const note = 'approval' in result ? result.approval : null;
        const actor: DecisionRecord['actor'] = typeof note !== 'string' ? 'unknown'
          : /^Command required approval \([\s\S]*\) and was approved by the user(?:, then interrupted)?\.$/.test(note) ? 'person'
          : /^Command was flagged \([\s\S]*\) and auto-approved by smart approval(?:, then interrupted)?\.$/.test(note) ? 'guardian' : 'unknown';
        const source = sessions.get(row.session_id)?.source;
        if (!source || !Number.isSafeInteger(Math.round(row.timestamp*1000)) || row.timestamp < 0) throw new Error('Invalid result identity');
        records.push({id:JSON.stringify(['hermes',profile,row.session_id,String(row.message_uid ?? row.id)]),agentId:profile,agentName:profile,
          sessionId:row.session_id,runId:null,approvalId:null,toolCallId:row.tool_call_id,command:call.command,actor,outcome:actor === 'unknown' ? 'executed':'approved',choice:null,
          at:Math.round(row.timestamp*1000),timeKind:'result',origin:'other',source,originLabel:labels[source] ?? 'Otro canal'});
      }
      return records.sort((a,b) => b.at-a.at || a.id.localeCompare(b.id));
    } catch { throw new HermesError('decision_history_unavailable','No se pudo leer el historial de comandos de Hermes. Reintenta.'); }
  }

  list(query: ConversationQuery = {}): StoredConversationPage {
    const page = paginate(families(readSnapshot(this.home)).filter((family) => (family.conversation.kind === 'background') === (query.background ?? false)), query);
    return { conversations: page.items.map((family) => family.conversation), nextOffset: page.nextOffset };
  }

  get(id: string): StoredConversation | null {
    return families(readSnapshot(this.home)).find((family) => family.conversation.sessionIds.includes(id))?.conversation ?? null;
  }

  search(query: ConversationSearchQuery): StoredConversationSearchPage {
    const snapshot = readSnapshot(this.home, query.q);
    const hits: StoredConversationSearchPage['hits'] = [];
    for (const family of families(snapshot)) {
      if ((family.conversation.kind === 'background') !== (query.background ?? false)) continue;
      const title = family.sessions.find((row) => snapshot.titleMatches.has(row.id));
      const message = [...family.displayMessages].reverse().find((row) => snapshot.messageMatches.has(String(row.id)));
      if (title) hits.push({ conversation: family.conversation, match: 'title', messageId: null, snippet: String(title.title ?? '').slice(0, 280) });
      else if (message) hits.push({ conversation: family.conversation, match: 'message', messageId: String(message.id), snippet: previewWithoutNotes(messageText(message.content)).slice(0, 280) });
    }
    const page = paginate(hits, query);
    return { hits: page.items, nextOffset: page.nextOffset };
  }

  transcript(id: string | null): Transcript {
    const all = families(readSnapshot(this.home));
    const family = id ? all.find((entry) => entry.conversation.sessionIds.includes(id)) : all.find((entry) => entry.conversation.kind === 'interactive');
    if (!family) {
      if (id) throw new HermesError('conversation_not_found', 'The conversation was not found.');
      return { sessionId: null, items: [] };
    }
    const complete = families(readSnapshot(this.home, undefined, 'transcript', family.conversation.sessionIds))
      .find(entry => entry.conversation.id === family.conversation.id);
    if (!complete || JSON.stringify(complete.conversation.sessionIds) !== JSON.stringify(family.conversation.sessionIds))
      throw new HermesError('chat_unavailable', 'The conversation changed while reading its history.');
    return { sessionId: complete.conversation.sessionId, items: transcriptItems(complete.displayMessages) };
  }

  lastMessage(): { text: string; at: number } | null {
    const visible = families(readSnapshot(this.home)).filter((family) => family.conversation.kind === 'interactive')
      .flatMap((family) => family.displayMessages).filter((row) => (row.role === 'user' || row.role === 'assistant') && messageText(row.content).trim())
      .sort((a, b) => Number(b.timestamp) - Number(a.timestamp) || Number(b.id) - Number(a.id));
    if (!visible.length) return null;
    const text = previewWithoutNotes(messageText(visible[0].content));
    return { text: text.length > 280 ? `${text.slice(0, 279)}…` : text, at: Math.round(Number(visible[0].timestamp) * 1000) };
  }

  deletionPreview(id: string): StoredDeletionPreview {
    const snapshot = readSnapshot(this.home, undefined, 'revision');
    const all = families(snapshot);
    const family = all.find((entry) => entry.conversation.sessionIds.includes(id));
    if (!family) throw new HermesError('conversation_not_found', 'The conversation was not found.');
    const doomed = new Set(family.conversation.sessionIds);
    // Exact API cascade: marker references OR a parent edge carrying any non-null delegate marker.
    let changed = true;
    while (changed) {
      changed = false;
      for (const session of snapshot.sessions) {
        const marker = config(session)._delegate_from;
        if (!doomed.has(session.id) && marker != null &&
            (doomed.has(typeof marker === 'object' ? JSON.stringify(marker) : String(marker)) ||
             (session.parent_session_id !== null && doomed.has(session.parent_session_id)))) {
          doomed.add(session.id);
          changed = true;
        }
      }
    }
    const sessionIds = [...family.conversation.sessionIds].reverse().concat([...doomed].filter((sid) => !family.conversation.sessionIds.includes(sid)).sort());
    const sessionRevisions: Record<string, string> = {};
    for (const session of snapshot.sessions) {
      if (doomed.has(session.id)) sessionRevisions[session.id] = rowRevision(session, snapshot.messages.filter((row) => row.session_id === session.id));
    }
    // Include linked survivors too: a branch/family metadata edit changes the confirmation revision.
    const affected = snapshot.sessions.filter((row) => doomed.has(row.id) || (row.parent_session_id !== null && doomed.has(row.parent_session_id)));
    const revision = createHash('sha256').update(JSON.stringify(affected.map((row) => [row.id, rowRevision(row, snapshot.messages.filter((message) => message.session_id === row.id))]))).digest('hex');
    return { conversationId: family.conversation.id, sessionIds, sessionRevisions, revision,
      messageCount: snapshot.messages.filter((row) => doomed.has(row.session_id)).length,
      conversationCount: all.filter((entry) => entry.conversation.sessionIds.some((sid) => doomed.has(sid))).length };
  }
}

function argumentPreview(raw: unknown): string {
  let text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  try {
    const args: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      const record: Record<string, unknown> = Object.fromEntries(Object.entries(args));
      const preferred = ['command', 'path', 'file_path', 'query', 'url', 'pattern', 'prompt', 'goal'].map((key) => record[key]).find((value) => typeof value === 'string' && value);
      const first = Object.values(record).find((value) => typeof value === 'string' && value);
      text = String(preferred ?? first ?? JSON.stringify(record));
    }
  } catch { /* Plain text arguments. */ }
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

function toolFailed(content: string): boolean {
  try {
    const result: unknown = JSON.parse(content);
    if (!result || typeof result !== 'object') return false;
    if ('exit_code' in result && typeof result.exit_code === 'number' && result.exit_code !== 0) return true;
    return 'error' in result && result.error !== undefined && result.error !== null && result.error !== '' && result.error !== false;
  } catch { return false; }
}

function transcriptItems(rows: MessageRow[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const pending = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>();
  let lastToolRow = -1;
  rows.forEach((row, index) => {
    const at = Math.round(Number(row.timestamp) * 1000);
    if (row.role === 'user' || row.role === 'assistant') {
      const text = messageText(row.content).trim();
      if (row.role === 'user') items.push({ kind: 'user', id: String(row.id), text, at });
      if (row.role === 'assistant' && text) items.push({ kind: 'assistant', id: String(row.id), text, at });
    }
    if (row.role === 'assistant' && row.tool_calls) {
      let calls: unknown[] = [];
      try {
        const parsed: unknown = JSON.parse(String(row.tool_calls));
        if (Array.isArray(parsed)) calls = parsed;
      } catch { calls = []; }
      calls.forEach((call, position) => {
        if (!call || typeof call !== 'object') return;
        const fields: Record<string, unknown> = Object.fromEntries(Object.entries(call));
        const fn: Record<string, unknown> = fields.function && typeof fields.function === 'object' ? Object.fromEntries(Object.entries(fields.function)) : {};
        const id = String(fields.id ?? fields.call_id ?? `${row.id}:${position}`);
        const item: Extract<TranscriptItem, { kind: 'tool' }> = {
          kind: 'tool', id, tool: String(fn.name ?? fields.name ?? 'tool'),
          preview: argumentPreview(fn.arguments ?? fields.arguments), status: 'running',
          durationSeconds: null, result: null, at,
        };
        items.push(item);
        pending.set(id, item);
        lastToolRow = index;
      });
    }
    if (row.role === 'tool' && row.tool_call_id) {
      const item = pending.get(String(row.tool_call_id));
      if (item) {
        const content = typeof row.content === 'string' ? row.content : '';
        item.status = toolFailed(content) ? 'error' : 'done';
        item.result = content.slice(0, 500);
        pending.delete(String(row.tool_call_id));
      }
    }
  });
  if (rows.slice(lastToolRow + 1).some((row) => row.role === 'user' || row.role === 'assistant')) {
    for (const item of pending.values()) item.status = 'error';
  }
  return items;
}
