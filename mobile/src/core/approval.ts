import type { ApprovalChoice, ApprovalResolution } from '../../../protocol/protocol.ts';

export type ApprovalOutcome = 'approved' | 'rejected' | 'expired';

/** Only the Puente's explicit resolution proves expiry, including with a legacy event. */
export function approvalOutcome(choice: ApprovalChoice, resolution?: ApprovalResolution): ApprovalOutcome {
  if (resolution === 'expired') return 'expired';
  return choice === 'deny' ? 'rejected' : 'approved';
}
