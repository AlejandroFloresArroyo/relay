// Additive Relay publication contract. All times are Unix milliseconds.
export const BOARD_FILE_MAX_BYTES = 32_768;
export const BOARD_MAX_CARDS_PER_AGENT = 32;
export const BOARD_MAX_AGENTS = 32;
export type NativeBoardContent =
  | { type: 'number'; value: string; unit: string; detail: string }
  | { type: 'meter'; value: number; max: number; unit: string }
  | { type: 'states'; items: { label: string; state: 'ok' | 'warning' | 'error' | 'off'; detail: string }[] }
  | { type: 'series'; unit: string; points: { at: number; value: number }[] }
  | { type: 'log'; lines: string[] }
  | { type: 'text'; text: string }
  | { type: 'action'; label: string; message: string };
export type BoardContent = NativeBoardContent | import('./boardWeb.ts').WebBoardContent;
export interface BoardPublication {
  title: string;
  updatedAt: number;
  maxAgeMs: number;
  state: 'ready' | 'updating' | 'error';
  content: BoardContent;
}
export interface PublishedBoardCard extends Omit<BoardPublication, 'updatedAt'> { updatedAt: number | null; id: string; status: 'ready' | 'updating' | 'stale' | 'error' }
export interface BoardCard extends PublishedBoardCard { agentId: string; agentName: string }
export interface BoardPage { cards: BoardCard[]; observedAt: number; failedAgents: string[] }
