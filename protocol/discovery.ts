// Additive discovery metadata. Candidate health is public and never carries credentials.
export interface DiscoveredBridge {
  name: string;
  url: string;
  protocolVersion: number | null;
  minAppProtocolVersion: number | null;
}
export interface DiscoveryResult { bridges: DiscoveredBridge[]; truncated: boolean }
