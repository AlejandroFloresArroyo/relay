const rows = new Map<string, unknown>();
const listeners = new Set<() => void>();
export const externalShare = {
  pending: jest.fn(async () => [...rows.keys()]),
  read: jest.fn(async (token: string): Promise<unknown> => rows.get(token) ?? null),
  discard: jest.fn(async (token: string) => { rows.delete(token); }),
  addListener: jest.fn((_name: string, listener: () => void) => { listeners.add(listener); return { remove: () => listeners.delete(listener) }; }),
};
export function receiveShare(token: string, payload: unknown) { rows.set(token, payload); for (const listener of listeners) listener(); }
export function resetExternalShare() {
  rows.clear(); listeners.clear();
  externalShare.pending.mockClear(); externalShare.read.mockClear(); externalShare.discard.mockClear(); externalShare.addListener.mockClear();
}
