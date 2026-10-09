let current: Record<string, unknown> | null = null;
let request: unknown = null;
const listeners = new Set<() => void>();
export const widgetNative = {
  target: jest.fn((raw: string | null) => { current = raw === null ? null : JSON.parse(raw); }),
  takeOpenRequest: jest.fn(() => { const value = request; request = null; return value; }),
  addListener: jest.fn((_event: string, listener: () => void) => { listeners.add(listener); return { remove: () => listeners.delete(listener) }; }),
};
/** The Servidor the native widget follows, as last handed over; null when retired. */
export function widgetFollows() { return current; }
export function widgetListenerCount() { return listeners.size; }
export function openWidget(value: unknown) { request = value; for (const listener of listeners) listener(); }
export function resetWidget() { current = null; request = null; for (const mock of Object.values(widgetNative)) mock.mockClear(); }
