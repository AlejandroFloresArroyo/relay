export const RELAY_LAYOUT = {
  railMinWidth: 760,
  splitMinWidth: 1000,
  contentMaxWidth: 820,
} as const;

export function relayLayout(width: number, fontScale = 1) {
  const usefulWidth = width / Math.max(1, fontScale);
  const kind = usefulWidth >= RELAY_LAYOUT.splitMinWidth ? 'split'
    : usefulWidth >= RELAY_LAYOUT.railMinWidth ? 'rail' : 'compact';
  return { kind, contentMaxWidth: RELAY_LAYOUT.contentMaxWidth } as const;
}

/** The tablet frame of ADR 0007, in dp: window edge, gaps, rail, list limits and the detail's minimum. */
export const FRAME = { edge: 16, gutter: 12, rail: { collapsed: 72, expanded: 240 }, list: { min: 280, max: 560 }, detailMin: 390 } as const;

/** 294 in Agentes (T-1), 320 elsewhere. */
export const listDefault = (section: string) => section === 'agents' ? 294 : 320;

/** The list's limits beside a rail of `railWidth`; null when rail, a 280 list and a 390 detail do not fit. */
export function listBounds(windowWidth: number, railWidth: number): { min: number; max: number } | null {
  const room = windowWidth - 2 * FRAME.edge - railWidth - 2 * FRAME.gutter - FRAME.detailMin;
  return room < FRAME.list.min ? null : { min: FRAME.list.min, max: Math.min(FRAME.list.max, room) };
}

export const clampWidth = (width: number, bounds: { min: number; max: number }) => Math.min(bounds.max, Math.max(bounds.min, width));

/** Remembered list widths by section. */
export type ListWidths = Readonly<Record<string, number>>;
export const LIST_WIDTHS_KEY = 'relay.listWidths.v1';
export const listWidth = (widths: ListWidths, section: string) => widths[section] ?? listDefault(section);
export const rememberWidth = (widths: ListWidths, section: string, width: number): ListWidths => ({ ...widths, [section]: Math.round(width) });
export function forgetWidth(widths: ListWidths, section: string): ListWidths {
  const { [section]: _forgotten, ...rest } = widths;
  return rest;
}

/** Stored widths, keeping only finite ones inside 280–560; never throws. */
export function parseWidths(raw: string | null): ListWidths {
  let value: unknown;
  try { value = JSON.parse(raw ?? ''); } catch { return {}; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, width]) =>
    typeof width === 'number' && Number.isFinite(width) && width >= FRAME.list.min && width <= FRAME.list.max));
}
