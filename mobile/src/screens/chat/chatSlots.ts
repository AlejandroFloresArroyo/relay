import type { ReactNode } from 'react';
import type { ChatRunEvent, RunCreated, RunRequest } from '../../../../protocol/protocol.ts';
// Owned by IMAGES (#39); consumed by TURN (#37). Inactive default: no attachment, identity decorator.
export interface ImagesSlot {
  hasAttachment: boolean;
  prepareSend(request: RunRequest): RunRequest;
  control?: ReactNode;
  preview?: ReactNode;
  renderUserAttachment?: (itemId: string) => ReactNode;
  preparing?: boolean;
  moveDraft?: (conversationId: string) => void;
  rejected?: (request: RunRequest) => void;
  overlay?: ReactNode;
  accepted?: (request: RunRequest, receipt: RunCreated, conversationId: string, messageId: string) => void;
  inputReceipt?: (event: Extract<ChatRunEvent, { type: 'run.input' }>) => void;
}
// Owned by DICTATION (#41); consumed by TURN (#37). While listening, nothing is sent or steered.
export interface DictationSlot {
  listening: boolean;
  control?: ReactNode;
}
export const inactiveImages: ImagesSlot = { hasAttachment: false, prepareSend: (request) => request };
export const inactiveDictation: DictationSlot = { listening: false };
// Pure gate used by TURN for the button, the keyboard submit and steer. Stop is never blocked by it.
export function canSubmit(s: { draft: string; hasAttachment: boolean; listening: boolean; running: boolean; chatOff: boolean }): boolean {
  return (s.draft.trim() !== '' || s.hasAttachment) && !s.listening && !s.running && !s.chatOff;
}
