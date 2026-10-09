import type { Approval, ChatRunEvent, ModelSelection, ToolStatus, TranscriptItem } from '../../../protocol/protocol.ts';
import { approvalOutcome, type ApprovalOutcome } from './approval.ts';
import { toolLabel } from './format.ts';

/** App-only evidence; the shared wire transcript stays unchanged. */
export type ChatItem = TranscriptItem & {
  approval?: { id: string; runId?: string; outcome?: ApprovalOutcome };
  /** An observed approval command, independent of any Hermes tool call. */
  feedbackOnly?: boolean;
};

const outcomeLabel = (outcome?: ApprovalOutcome) => outcome === 'expired' ? 'VENCIDA' : outcome === 'rejected' ? 'RECHAZADO' : null;

/** Refreshing wire history must not erase confirmed delivery or an observed approval decision. */
export function mergeTranscript(previous: ChatItem[], loaded: ChatItem[]): ChatItem[] {
  const evidence = new Map(previous.filter((it) => it.approval).map((it) => [it.id, it.approval]));
  const redirectedIds = new Set<string>();
  const redirectedRequests = new Set<string>();
  for (const item of previous) {
    if (item.kind !== 'user' || !item.redirected) continue;
    redirectedIds.add(item.id);
    if (item.clientMessageId) redirectedRequests.add(item.clientMessageId);
  }
  const runtimes = new Map(previous.filter((item) => item.kind === 'assistant' && item.runtime).map((item) => [item.id, item]));
  const history = loaded.map((item): ChatItem => {
    const observed = runtimes.get(item.id);
    if (item.kind === 'assistant' && !item.runtime && observed?.kind === 'assistant' && item.text === observed.text && (!item.runId || item.runId === observed.runId)) return { ...item, runtime: observed.runtime };
    if (item.kind === 'tool' && evidence.has(item.id)) {
      const approval = evidence.get(item.id);
      return { ...item, approval, status: approval?.outcome === 'rejected' || approval?.outcome === 'expired' ? 'error' : item.status };
    }
    if (item.kind === 'user' && (redirectedIds.has(item.id) || (item.clientMessageId && redirectedRequests.has(item.clientMessageId)))) return { ...item, redirected: true };
    return item;
  });
  const observed = previous.filter((it) => it.feedbackOnly && !history.some((h) => h.feedbackOnly && h.approval?.id === it.approval?.id));
  return [...history, ...observed];
}

/** Only a successful pending-approval read can retire unresolved local evidence. */
export function reconcileApprovalFeedback(items: ChatItem[], pending: readonly Pick<Approval, 'id'>[]): ChatItem[] {
  const pendingIds = new Set(pending.map((approval) => approval.id));
  return items.flatMap((item): ChatItem[] => {
    if (!item.approval || item.approval.outcome || pendingIds.has(item.approval.id)) return [item];
    if (item.feedbackOnly) return [];
    // Keep the authoritative tool status; absence of an approval does not establish a decision.
    const history = { ...item };
    delete history.approval;
    return [history];
  });
}

export function reloadTranscript(previous: ChatItem[], previousSession: string | null, loaded: { sessionId: string | null; items: ChatItem[] }, pending?: readonly Pick<Approval, 'id'>[]): ChatItem[] {
  const merged = mergeTranscript(previousSession === loaded.sessionId ? previous : [], loaded.items);
  return pending === undefined ? merged : reconcileApprovalFeedback(merged, pending);
}

/** Wire items carry the Puente's clock; shift them onto the phone's with the measured offset (phone − Puente). */
export function onPhoneClock<T extends { at: number }>(items: T[], offsetMs: number): T[] {
  return offsetMs ? items.map((it) => ({ ...it, at: it.at + offsetMs })) : items;
}

export type Tone = 'plain' | 'dim' | 'fail' | 'ok';
export interface Segment {
  text: string;
  tone: Tone;
  glow?: boolean;
}


export type ChatBlock =
  | { kind: 'user'; id: string; text: string; redirected?: boolean }
  | { kind: 'text'; id: string; text: string; streaming: boolean; runtime?: ModelSelection | null }
  | {
      kind: 'activity';
      id: string;
      /** `at`: the step's start, epoch ms. */
      steps: { id: string; label: string; status: ToolStatus; seconds: number | null; at: number; outcome?: string | null }[];
      totalSeconds: number;
      running: boolean;
    }
  /** How the command ended: it ran and failed, or its Aprobación expired or was rejected and it never ran. */
  | { kind: 'terminal'; id: string; cwd: string | null; end: 'failed' | 'expired' | 'rejected'; lines: Segment[][] }
  | { kind: 'diff'; id: string; file: string; added: number; removed: number; lines: { text: string; sign: '+' | '-' | ' ' }[] };


const FAIL = /(\bFAIL\b|\b\d+ failed\b|\b\w*Error: .*$)/;
const OK = /(\bPASS\b|\b\d+ passed\b)/;

/** Colors the failing / passing fragments of a terminal line the way the design does. */
export function toneLine(line: string): Segment[] {
  const out: Segment[] = [];
  for (const piece of line.split(new RegExp(`${FAIL.source}|${OK.source}`)).filter((p) => p !== undefined && p !== '')) {
    if (FAIL.test(piece)) out.push({ text: piece, tone: 'fail', glow: piece === 'FAIL' });
    else if (OK.test(piece)) out.push({ text: piece, tone: 'ok', glow: true });
    else out.push({ text: piece, tone: 'plain' });
  }
  return out;
}

function terminalBlock(item: Extract<ChatItem, { kind: 'tool' }>): ChatBlock | null {
  const outcome = item.approval?.outcome;
  // An expired one says what happened in its own words (D-09); a rejected one keeps its red line.
  if (outcome === 'expired') return { kind: 'terminal', id: `${item.id}:term`, cwd: item.cwd ?? null, end: 'expired', lines: [[{ text: `$ ${item.preview}`, tone: 'dim' }]] };
  if (outcome === 'rejected') return {
    kind: 'terminal', id: `${item.id}:term`, cwd: item.cwd ?? null, end: 'rejected',
    lines: [[{ text: `$ ${item.preview}`, tone: 'dim' }], [{ text: 'RECHAZADO', tone: 'fail', glow: true }]],
  };
  if (item.result == null) return null;
  let output = item.result;
  let exitCode: number | null = null;
  // Hermes JSON-encodes structured results: {"output": "...", "exit_code": 1}
  try {
    const parsed = JSON.parse(item.result) as { output?: unknown; exit_code?: unknown };
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.output === 'string') output = parsed.output;
      if (typeof parsed.exit_code === 'number') exitCode = parsed.exit_code;
    }
  } catch {
    // Either plain text, or JSON that Hermes cut at 500 characters. Recover what is there.
    const cut = /^\{\s*"output":\s*"((?:[^"\\]|\\.)*)/.exec(item.result);
    if (cut) {
      try {
        output = JSON.parse(`"${cut[1].replace(/\\$/, '')}"`) as string;
      } catch {
        output = cut[1].replace(/\\n/g, '\n');
      }
    }
    const code = /"exit_code":\s*(-?\d+)/.exec(item.result);
    if (code) exitCode = Number(code[1]);
  }
  // A real session runs dozens of commands; only the ones that failed earn a block of their own.
  const failed = exitCode != null ? exitCode !== 0 : item.status === 'error';
  if (!failed) return null;
  const lines: Segment[][] = [[{ text: `$ ${item.preview}`, tone: 'dim' }]];
  for (const l of output.split('\n')) if (l.trim() !== '') lines.push(toneLine(l));
  return { kind: 'terminal', id: `${item.id}:term`, cwd: item.cwd ?? null, end: 'failed', lines };
}

function diffBlock(item: Extract<TranscriptItem, { kind: 'tool' }>): ChatBlock | null {
  if (item.result == null) return null;
  const lines = item.result
    .split('\n')
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
    .map((l) => ({ text: l, sign: l[0] as '+' | '-' }));
  if (lines.length === 0) return null;
  return {
    kind: 'diff',
    id: `${item.id}:diff`,
    file: item.preview,
    added: lines.filter((l) => l.sign === '+').length,
    removed: lines.filter((l) => l.sign === '-').length,
    lines,
  };
}

const basename = (p: string) => p.split('/').pop() || p;

function stepDetail(item: Extract<TranscriptItem, { kind: 'tool' }>): string {
  const label = toolLabel(item.tool);
  if (label === 'LEER' || label === 'EDIT') return basename(item.preview);
  if (label === 'EJEC') return item.preview.split(' -- ')[0];
  return item.preview;
}

/**
 * Turns the flat transcript into what the chat screen draws. Within one assistant turn every tool
 * call collapses into a single ACTIVIDAD panel placed where the first call happened; terminal
 * output and patches additionally appear as their own blocks in chronological position.
 */
export function buildBlocks(items: ChatItem[], streaming: boolean): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  let activity: Extract<ChatBlock, { kind: 'activity' }> | null = null;

  for (const item of items) {
    if (item.kind === 'user') {
      activity = null;
      blocks.push({ kind: 'user', id: item.id, text: item.text, ...(item.redirected ? { redirected: true } : {}) });
    } else if (item.kind === 'assistant') {
      if (item.text.trim() !== '') blocks.push({ kind: 'text', id: item.id, text: item.text, streaming: false, ...(item.runtime ? { runtime: item.runtime } : {}) });
    } else {
      if (item.feedbackOnly) {
        const associated = items.some((it) => !it.feedbackOnly && it.approval?.id === item.approval?.id);
        const feedback = associated ? null : terminalBlock(item);
        if (feedback) blocks.push(feedback);
        continue;
      }
      if (!activity) {
        activity = { kind: 'activity', id: `${item.id}:act`, steps: [], totalSeconds: 0, running: false };
        blocks.push(activity);
      }
      activity.steps.push({
        id: item.id,
        label: `${toolLabel(item.tool)} · ${stepDetail(item)}`,
        status: item.status,
        seconds: item.durationSeconds,
        at: item.at,
        outcome: outcomeLabel(item.approval?.outcome),
      });
      activity.totalSeconds += item.durationSeconds ?? 0;
      if (item.status === 'running' || item.status === 'waiting') activity.running = true;

      const label = toolLabel(item.tool);
      const extra = label === 'EJEC' ? terminalBlock(item) : label === 'EDIT' ? diffBlock(item) : null;
      if (extra) blocks.push(extra);
    }
  }

  if (streaming) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === 'user') break;
      if (b.kind === 'text') {
        b.streaming = true;
        break;
      }
    }
  }
  return blocks;
}

/** Terminal events carry no ID; the live stream supplies its Turno's ID separately. */
function finishRunFeedback(items: ChatItem[], runId?: string): ChatItem[] {
  return items.flatMap((item): ChatItem[] => {
    if (!item.approval || item.approval.outcome || (runId !== undefined && item.approval.runId !== runId)) return [item];
    if (item.feedbackOnly) return [];
    return [item.kind === 'tool' ? { ...item, status: 'error', approval: undefined } : item];
  });
}

/** Applies one live run event to the transcript. Returns a new array; never mutates. */
export function applyRunEvent(items: ChatItem[], e: ChatRunEvent, now: number, runId?: string): ChatItem[] {
  if (e.type === 'run.cancelled' || e.type === 'run.failed' || e.type === 'run.completed') {
    items = finishRunFeedback(items, runId);
  }
  switch (e.type) {
    case 'message.delta': {
      const last = items[items.length - 1];
      if (last && last.kind === 'assistant' && (!runId || !last.runId || last.runId === runId)) return [...items.slice(0, -1), { ...last, text: last.text + e.text }];
      return [...items, { kind: 'assistant', id: `a${now}-${items.length}`, text: e.text, at: now, ...(runId ? { runId } : {}) }];
    }
    case 'tool.started':
      return [
        ...items,
        { kind: 'tool', id: e.toolCallId, tool: e.tool, preview: e.preview, status: 'running', durationSeconds: null, result: null, at: now },
      ];
    case 'tool.completed':
      return items.map((it) =>
        it.kind === 'tool' && it.id === e.toolCallId
          ? { ...it, status: e.error ? 'error' : 'done', durationSeconds: e.durationSeconds, result: e.preview }
          : it,
      );
    case 'approval.request': {
      // Keep approval evidence by its own ID; tool association is only a live display aid.
      const feedback: ChatItem = { kind: 'tool', id: `approval:${e.approval.id}`, tool: 'terminal', preview: e.approval.command, cwd: e.approval.cwd, at: now, status: 'waiting', durationSeconds: null, result: null, feedbackOnly: true, approval: { id: e.approval.id, runId: e.approval.runId ?? runId } };
      if (items.some((it) => it.approval?.id === e.approval.id)) return items;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === 'tool' && !it.feedbackOnly && it.status === 'running') {
          return [...items.map((x, j) => (j === i ? { ...it, status: 'waiting' as const, approval: { id: e.approval.id, runId: e.approval.runId ?? runId } } : x)), feedback];
        }
      }
      return [...items, feedback];
    }
    case 'approval.resolved': {
      const outcome = approvalOutcome(e.choice, e.resolution);
      return items.flatMap((it): ChatItem[] => {
        if (it.kind !== 'tool' || it.approval?.id !== e.approvalId) return [it];
        if (it.feedbackOnly && outcome !== 'expired') return [];
        return [{
          ...it, status: outcome === 'approved' ? 'running' : 'error',
          approval: { ...it.approval, outcome },
        }];
      });
    }
    case 'run.completed': {
      const last = items[items.length - 1];
      if (last && last.kind === 'assistant' && (!runId || !last.runId || last.runId === runId)) return e.runtime ? [...items.slice(0, -1), { ...last, runtime: e.runtime }] : items;
      return e.output.trim() ? [...items, { kind: 'assistant', id: `a${now}-${items.length}`, text: e.output, at: now, ...(runId ? { runId } : {}), ...(e.runtime ? { runtime: e.runtime } : {}) }] : items;
    }
    case 'run.failed':
      return [...items, { kind: 'assistant', id: `a${now}-${items.length}`, text: `Error: ${e.error}`, at: now }];
    case 'run.cancelled':
      return items;
    default:
      return items;
  }
}
