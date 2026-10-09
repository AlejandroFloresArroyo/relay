import net from 'node:net';

import type { Exec } from './exec.ts';

export interface TailnetPeer {
  device: string | null;
  tailnet: string | null;
}

export interface Tailnet {
  // Who owns this tailnet address, or null when tailscale does not know it (or is not running).
  whois(ip: string): Promise<TailnetPeer | null>;
}

// Tailscale hands out 100.64.0.0/10 (CGNAT range) and fd7a:115c:a1e0::/48.
export function isTailscaleIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  if (family === 6) return ip.toLowerCase().startsWith('fd7a:115c:a1e0:');
  return false;
}

const CACHE_MS = 60_000;

// Asks the local tailscaled through `tailscale whois --json <ip>`. /v1/whoami is unauthenticated,
// so answers are cached per address and only well-formed tailnet addresses ever reach the CLI.
export function createTailnet(exec: Exec, bin = 'tailscale', now: () => number = Date.now): Tailnet {
  const cache = new Map<string, { at: number; peer: TailnetPeer | null }>();
  return {
    async whois(ip: string): Promise<TailnetPeer | null> {
      if (!isTailscaleIp(ip)) return null;
      const cached = cache.get(ip);
      if (cached && now() - cached.at < CACHE_MS) return cached.peer;

      let peer: TailnetPeer | null = null;
      try {
        const result = await exec(bin, ['whois', '--json', ip], { timeoutMs: 3000 });
        if (result.code === 0) peer = parseWhois(result.stdout);
      } catch {
        peer = null; // tailscale not installed or not answering
      }
      if (cache.size > 500) cache.clear();
      cache.set(ip, { at: now(), peer });
      return peer;
    },
  };
}

function parseWhois(stdout: string): TailnetPeer | null {
  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const node = parsed?.Node;
  if (!node || typeof node !== 'object') return null;
  // Node.Name is the MagicDNS name: "iphone-dev.tail0a1b2c.ts.net."
  const fqdn = typeof node.Name === 'string' ? node.Name.replace(/\.$/, '') : '';
  const dot = fqdn.indexOf('.');
  const device =
    (typeof node.ComputedName === 'string' && node.ComputedName) || (dot > 0 ? fqdn.slice(0, dot) : fqdn) || null;
  return { device, tailnet: dot > 0 ? fqdn.slice(dot + 1) : null };
}
