import type { BoardCard } from '../../../protocol/board.ts';
export interface BoardPreferences { order: string[]; hidden: string[]; removed: string[]; seen: string[] }
export const emptyBoardPreferences: BoardPreferences = { order: [], hidden: [], removed: [], seen: [] };
export const cardKey = (card: BoardCard) => `${card.agentId}/${card.id}`;
export function parseBoardPreferences(raw: string | null): BoardPreferences {
  try {
    const value = JSON.parse(raw ?? 'null');
    if (value && ['order', 'hidden', 'removed', 'seen'].every(k => Array.isArray(value[k]) && value[k].length <= 1024 && value[k].every((v: unknown) => typeof v === 'string' && v.length <= 256))) return value;
  } catch { /* Invalid local preferences return to the published order. */ }
  return emptyBoardPreferences;
}
export function orderedCards(cards: BoardCard[], preferences: BoardPreferences): BoardCard[] {
  const positions = new Map(preferences.order.map((key, i) => [key, i]));
  return cards.filter(c => !preferences.removed.includes(cardKey(c))).sort((a, b) => (positions.get(cardKey(a)) ?? 1024) - (positions.get(cardKey(b)) ?? 1024));
}
export function moveBoardCard(cards: BoardCard[], preferences: BoardPreferences, key: string, offset: number): BoardPreferences {
  const order = orderedCards(cards, preferences).map(cardKey), index = order.indexOf(key), target = index + offset;
  if (index < 0 || target < 0 || target >= order.length) return preferences;
  [order[index], order[target]] = [order[target], order[index]];
  return { ...preferences, order };
}
const MONTHS = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
/** «5 OCT 22:20»: 24 h in the phone's zone, es-MX month, no am/pm. Built by hand so ICU versions cannot change it. */
export function boardTime(at: number): string {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** The caption under the header: «7 TARJETAS · 3 NUEVAS», without «NUEVAS» when none. */
export function boardTitle(cards: number, fresh: number, editing: boolean): string {
  if (editing) return 'EDITANDO EL TABLERO';
  return `${cards} ${cards === 1 ? 'TARJETA' : 'TARJETAS'}${fresh ? ` · ${fresh} ${fresh === 1 ? 'NUEVA' : 'NUEVAS'}` : ''}`;
}
