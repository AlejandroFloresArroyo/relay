import type { Approval, ApprovalChoice, RunEvent } from '../../../protocol/protocol.ts';
import { applyRunEvent, type ChatItem } from './transcript.ts';

export function demoApprovalDecision(approvalId: string, choice: ApprovalChoice): Extract<RunEvent, { type: 'approval.resolved' }> {
  return { type: 'approval.resolved', approvalId, choice, resolution: 'decision' };
}

export function demoExpiredTranscript(now: number): ChatItem[] {
  const expiresAt = now - 60_000;
  let items: ChatItem[] = [
    { kind: 'user', id: 'expired-user', text: 'Limpia los documentos temporales del resumen.', at: expiresAt - 300_000 },
  ];
  items = applyRunEvent(items, { type: 'approval.request', approval: { id: 'ap-demo-expired', runId: 'demo-expired-run', agentId: 'research', agentName: 'Research', command: 'rm -rf ./papers/tmp', cwd: null, reason: null, affects: null, risk: null, createdAt: expiresAt - 299_000, expiresAt, choices: ['once', 'session', 'deny'] } satisfies Approval }, expiresAt - 299_000);
  return applyRunEvent(items, { type: 'approval.resolved', approvalId: 'ap-demo-expired', choice: 'deny', resolution: 'expired' }, expiresAt);
}
