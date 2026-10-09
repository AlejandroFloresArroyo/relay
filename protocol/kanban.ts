// Relay-owned manual work metadata. Types and side-effect-free constants only.
// UI vocabulary: Trabajo / elemento. This is independent of the published Board contract.
// All timestamps are Unix milliseconds from the Server; null never means zero or success.
// Additive authenticated routes use the existing X-Relay-Protocol. No version bump.
import type { RunPhase } from './protocol.ts';

export const KANBAN_COLUMNS = ['todo', 'in_progress', 'review', 'blocked', 'done'] as const;
export type KanbanColumn = typeof KANBAN_COLUMNS[number];
export const KANBAN_MAX_ITEMS = 500;
export const KANBAN_MAX_BLOCKERS_PER_ITEM = 16;
export const KANBAN_MAX_COMMENTS_PER_ITEM = 200;
export const KANBAN_MAX_COMMENTS = 10_000;
// Shared capacity for every durable mutation/notification receipt. Never evict silently:
// reject new requests when full; replay/read existing receipts must remain possible.
export const KANBAN_MAX_RECEIPTS = 20_000;
export const KANBAN_STATE_MAX_BYTES = 16 * 1024 * 1024;
export const KANBAN_REQUEST_MAX_BYTES = 80_000;
export const KANBAN_RESPONSE_MAX_BYTES = 1_048_576;
export const KANBAN_TITLE_MAX_CHARS = 200; // UTF-16 code units, trimmed and nonempty.
export const KANBAN_COMMENT_MAX_BYTES = 4_096; // UTF-8, nonempty after trimming.
export const KANBAN_NOTIFY_INPUT_MAX_BYTES = 64_000; // UTF-8; preview/send this exact input.
export const KANBAN_REQUEST_ID_MIN_CHARS = 8;
export const KANBAN_REQUEST_ID_MAX_CHARS = 128;
export const KANBAN_AGENT_ID_MAX_CHARS = 64;
export const KANBAN_CURSOR_MAX_CHARS = 512;
export const KANBAN_PAGE_DEFAULT_LIMIT = 50;
export const KANBAN_PAGE_MAX_LIMIT = 100;
export const KANBAN_MIN_TIMESTAMP_MS = 946_684_800_000;
export const KANBAN_MAX_TIMESTAMP_MS = 4_102_444_800_000;

// item/comment IDs are canonical lowercase UUIDs; display numbers are positive safe integers,
// allocated durably per Server and never reused. They are not paths or Hermes task IDs.
// Revision = opaque lowercase 64-hex digest of committed metadata. Clients only compare it.
// Request IDs match [A-Za-z0-9_-]{8,128}; Agent IDs match [A-Za-z0-9][A-Za-z0-9._-]{0,63}.
// Bodies reject unknown keys. Titles reject control characters; input/comments must be nonempty after trimming and allow TAB/LF/CR
// but reject other C0 controls and DEL. Byte limits apply before parsing/materialization.
export interface KanbanDeviceAuthor { kind: 'device'; id: string; name: string }
export interface KanbanItem {
  id: string;
  number: number;
  revision: string;
  title: string;
  agentId: string | null; // Null means deliberately unassigned, not an invented Agent.
  column: KanbanColumn; // Manual metadata; never inferred from a Turn's phase.
  blockedBy: string[];
  commentCount: number;
  createdAt: number;
  updatedAt: number;
}
export interface KanbanDependency {
  id: string;
  number: number;
  title: string;
  column: KanbanColumn;
}
export interface KanbanComment {
  id: string;
  number: number; // Monotonic per item; comments are returned oldest first.
  author: KanbanDeviceAuthor; // Derived from authentication, never from a request body.
  text: string; // Plain human text; @mentions do not initiate a Turn.
  createdAt: number;
}
export interface KanbanItemDetail {
  item: KanbanItem;
  blockers: KanbanDependency[];
  blocks: KanbanDependency[];
  latestNotification: KanbanNotifyReceipt | null;
  observedAt: number;
}
export interface KanbanItemsQuery { column?: KanbanColumn; cursor?: string; limit?: number }
export interface KanbanPageQuery { cursor?: string; limit?: number }
export interface KanbanItemsPage {
  items: KanbanItem[]; // Newest createdAt first, then id ascending as a stable tie-breaker.
  counts: Record<KanbanColumn, number>; // Full Server totals, not just this page.
  revision: string;
  observedAt: number;
  nextCursor: string | null;
}
export interface KanbanCommentsPage {
  comments: KanbanComment[];
  itemRevision: string;
  observedAt: number;
  nextCursor: string | null;
}
// Cursors are opaque bounded base64url tokens, scoped to resource/filter/revision. A changed
// dataset returns kanban_conflict instead of mixing pages. No client-chosen filesystem paths.

export interface KanbanCreateItemRequest {
  requestId: string;
  title: string;
  agentId: string | null;
  column: KanbanColumn;
  blockedBy: string[];
}
export interface KanbanUpdateItemRequest {
  requestId: string;
  revision: string; // Expected item revision; stale writes fail without mutation.
  title?: string;
  agentId?: string | null;
  column?: KanbanColumn;
  blockedBy?: string[]; // Replacement set, not append/remove commands.
}
export interface KanbanCommentRequest { requestId: string; revision: string; text: string }
export interface KanbanItemMutationResult { requestId: string; item: KanbanItem }
export interface KanbanCommentMutationResult extends KanbanItemMutationResult { comment: KanbanComment }
// An update must include at least one editable field. Validate the resulting whole item:
// only existing same-Server Agents/items; distinct blockers; no self-edge or directed cycle.
// column=blocked requires a nonempty blockedBy set. Blockers can remain in other columns.
// Moving/unlinking/completing/reassigning changes metadata only: no start, stop, steer, profile
// change, auto-unblock or dispatch. An existing Turn stays attached to its original Agent.

export interface KanbanNotifyRequest {
  requestId: string;
  revision: string;
  agentId: string; // Must match the item's non-null assignment at admission.
  input: string; // Human-confirmed exact input; no hidden prompt expansion or image attachments.
}
export type KanbanNotifyRejection =
  | 'server_paused' | 'agent_unavailable' | 'configuration_conflict'
  | 'conversation_unavailable' | 'dependency_blocked' | 'upstream_rejected';
export interface KanbanTurnObservation {
  phase: RunPhase;
  observedAt: number;
}
interface KanbanNotifyReceiptBase {
  requestId: string;
  itemId: string;
  itemRevision: string;
  agentId: string; // Pinned even if the element is reassigned later.
  requestedBy: KanbanDeviceAuthor;
  requestedAt: number;
  updatedAt: number;
}
export type KanbanNotifyReceipt = KanbanNotifyReceiptBase & (
  | { state: 'pending'; conversationId: string | null; runId: null; errorCode: null }
  | { state: 'started'; conversationId: string; runId: string; errorCode: null;
      turn: KanbanTurnObservation | null } // Accepted Turn, not proof of completion/consumption.
  | { state: 'rejected'; conversationId: string | null; runId: null; errorCode: KanbanNotifyRejection }
  | { state: 'uncertain'; conversationId: string | null; runId: string | null;
      errorCode: 'kanban_notification_uncertain' }
);

// All writes bind a durable receipt to (authenticated device, requestId) and a fingerprint of
// method/resource/exact validated body. Same identity/body replays its committed result without
// effects, even after revision changes or pause; a different body/resource returns conflict.
// Check authentication/revocation before every replay. Replays never constitute new permission.
// Create-and-notify is two explicit operations: a saved element survives notification failure.
// Notify requires visible human confirmation scoped to Server/device/element/revision/Agent/input.
// It reuses chat policy, not cron policy; no new biometric rule or autonomous Agent write channel.
// Check Pausa general and dependencies before any new conversation or pending config effect,
// after asynchronous boundaries and immediately before createRun, using existing control admission.
// The target must not be blocked and all blockers must be done. No implicit unblock or override.
// Use only the existing authorized pending-config path and Hermes conversation/Turn API ports;
// no direct Hermes SQL writes, Kanban dispatcher, tools/config changes or external conversations.
// Reserve one notification per item: pending/uncertain or a started Turn without confirmed terminal
// status blocks another requestId. A repeated requestId only reads its own receipt. Fresh work
// needs a fresh explicit human action after a confirmed terminal/rejected outcome.
// Persist intent before upstream effects. A fresh notice opens a NEW Relay-owned conversation;
// only its recorded Turn supplies observations. No events or work from other channels are imported.
// Restart performs no POST/retry/resume: interrupted pending work becomes uncertain; known IDs may
// be reconciled via readonly status. Missing evidence is null/unknown, never an invented completion.
// Reconciliation/terminal events never move columns or append an Agent-authored manual comment.

export const KANBAN_ROUTES = {
  items: '/v1/kanban/items',
  item: '/v1/kanban/items/:itemId',
  comments: '/v1/kanban/items/:itemId/comments',
  notify: '/v1/kanban/items/:itemId/notify',
  notification: '/v1/kanban/items/:itemId/notifications/:requestId',
} as const;
// GET items -> 200 KanbanItemsPage; GET item -> 200 KanbanItemDetail.
// POST items -> 201 KanbanItemMutationResult; PATCH item -> 200 KanbanItemMutationResult.
// GET comments -> 200 KanbanCommentsPage; POST comments -> 201 KanbanCommentMutationResult.
// POST notify -> 202 KanbanNotifyReceipt once intent is durable (any receipt state).
// GET notification -> 200 KanbanNotifyReceipt, scoped to the requesting device's receipt.
// Failures BEFORE intent/metadata commit use the error envelope; no fake success receipt.
// No delete/archive, automatic comment, schedule, dispatch or profile mutation route in this cut.

export const KANBAN_ERROR_STATUS = {
  kanban_invalid_request: 400,
  kanban_not_found: 404,
  kanban_agent_unavailable: 409,
  kanban_conflict: 409,
  kanban_dependency_blocked: 409,
  kanban_notification_busy: 409,
  kanban_notification_uncertain: 409,
  server_paused: 409,
  kanban_store_unavailable: 503,
  kanban_store_full: 503,
} as const;
export type KanbanErrorCode = keyof typeof KANBAN_ERROR_STATUS;
export interface KanbanApiError { error: { code: KanbanErrorCode; message: string } }
// Existing auth/protocol errors still apply. Messages are Spanish and opaque: no input bodies,
// filesystem paths, configuration contents or upstream errors in HTTP errors/audit/logs.
// Metadata revisions, previous snapshots and audit outbox must commit together; retain the prior
// private snapshot before replacement. Audit identifies device/action/item/request/receipt outcome,
// never comment/input text. Capacity/corruption/audit failures fail closed, never reset to empty.
// Offline cache is dated and readonly. Disconnect/revocation/scope change cancels pending UI
// confirmations; never queue offline mutations/notifications for replay on reconnection.
