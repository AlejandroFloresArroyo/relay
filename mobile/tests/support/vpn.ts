import type { VpnReading, VpnAvailability } from '@/native/vpnContract';
const listeners = new Set<(reading: VpnReading) => void>();
export function vpnReading(generation: number, vpn: VpnAvailability = 'unknown', sequence = 1): VpnReading {
  return { version: 1, scope: 'relay-default-network', generation, sequence, vpn, reason: vpn === 'unknown' ? 'unavailable' : 'capabilities' };
}
export const vpn = {
  observe: jest.fn(async (generation: number) => vpnReading(generation)),
  snapshot: jest.fn(async (generation: number) => vpnReading(generation)),
  stop: jest.fn(async (_generation: number) => {}),
  addListener: jest.fn((_event: string, listener: (reading: VpnReading) => void) => { listeners.add(listener); return { remove: () => listeners.delete(listener) }; }),
};
export function emitVpn(reading: VpnReading) { for (const listener of listeners) listener(reading); }
export function vpnListeners() { return listeners.size; }
export function resetVpn() {
  listeners.clear(); vpn.observe.mockReset().mockImplementation(async generation => vpnReading(generation));
  vpn.snapshot.mockReset().mockImplementation(async generation => vpnReading(generation)); vpn.stop.mockReset().mockResolvedValue(undefined);
  vpn.addListener.mockClear();
}
