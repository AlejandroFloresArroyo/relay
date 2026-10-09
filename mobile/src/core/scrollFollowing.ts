import { nearEnd } from './format.ts';

export interface ScrollFollowing { following: boolean; pinned: boolean }
export type ScrollFollowingEvent =
  | { type: 'follow' }
  | { type: 'drag' }
  | { type: 'position'; offset: number; viewport: number; content: number };
export const initialScrollFollowing: ScrollFollowing = { following: true, pinned: true };

/** A send pins following until a new user gesture; stale native momentum cannot cancel it. */
export function followChatScroll(state: ScrollFollowing, event: ScrollFollowingEvent): ScrollFollowing {
  if (event.type === 'follow') return initialScrollFollowing;
  if (event.type === 'drag') return { ...state, pinned: false };
  if (state.pinned) return state;
  return { following: nearEnd(event), pinned: false };
}
