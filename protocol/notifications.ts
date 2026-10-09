import type { Approval } from './protocol.ts';

// Additive API: X-Relay-Protocol plus X-Relay-Notifications: 1; never fall back to legacy decisions.
export const NOTIFICATIONS_SCHEMA = 1;
export const NOTIFICATIONS_HEADER = 'X-Relay-Notifications';
export const NOTIFICATION_KINDS = ['approval', 'task', 'error', 'server'] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];
export const NOTIFICATION_REGISTRATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const NOTIFICATION_REQUEST_MAX_BYTES = 4096;
export interface NotificationPreferences {
  enabled: boolean;
  types: Record<NotificationKind, boolean>;
  preview: 'generic';
}
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: false, types: { approval: true, task: true, error: true, server: true }, preview: 'generic',
};
export interface NotificationRegistrationInput {
  schema: 1;
  revision: number;
  endpoint: string;
  preferences: NotificationPreferences;
}
export interface NotificationStatus {
  schema: 1;
  configured: boolean;
  transport: 'ntfy-unifiedpush';
  availableKinds: NotificationKind[];
  preferences: NotificationPreferences;
  revision: number;
  registration: { id: string; expiresAt: number } | null;
  delivery: 'disabled' | 'unknown' | 'accepted' | 'failed';
  serverNow: number;
}
// The private distributor carries no command, result, device key, pairing code or private name.
export interface NotificationEnvelope {
  schema: 1;
  kind: NotificationKind;
  noticeId: string;
  registrationId: string;
  expiresAt: number | null; // Puente epoch milliseconds; delivery is never consent.
}
export interface NotificationApprovalTarget {
  agentId: string;
  runId: string;
  approvalId: string;
}
export interface NotificationNotice {
  schema: 1;
  noticeId: string;
  registrationId: string;
  kind: 'approval';
  target: NotificationApprovalTarget;
  approval: Approval;
  expiresAt: number | null;
  serverNow: number;
  state: 'pending' | 'approved' | 'rejected' | 'expired' | 'uncertain' | 'unknown';
}
export interface NotificationDecisionInput {
  schema: 1;
  registrationId: string;
  target: NotificationApprovalTarget;
  choice: 'once' | 'deny';
}
export interface NotificationDecisionResult { ok: true; outcome: 'approved' | 'rejected' }
