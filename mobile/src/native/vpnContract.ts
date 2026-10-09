export type VpnAvailability = 'available' | 'absent' | 'unknown';
export type VpnReason = 'capabilities' | 'no-default-or-blocked' | 'blocked' | 'transition' | 'inactive' | 'unavailable';
export interface VpnReading {
  version: 1;
  scope: 'relay-default-network';
  generation: number;
  sequence: number;
  vpn: VpnAvailability;
  reason: VpnReason;
}
export interface VpnNativePort {
  observe(generation: number): Promise<VpnReading>;
  snapshot(generation: number): Promise<VpnReading>;
  stop(generation: number): Promise<void>;
  addListener(event: 'onNetworkChanged', listener: (reading: VpnReading) => void): { remove(): void };
}
