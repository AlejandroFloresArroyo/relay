import http from 'node:http';
import net from 'node:net';
import type { DiscoveryResult, DiscoveredBridge } from '../../protocol/discovery.ts';
import type { Exec } from './exec.ts';
import { isTailscaleIp } from './tailnet.ts';

export interface Discovery { discover(signal?: AbortSignal): Promise<DiscoveryResult> }
type Probe = (url: string, address: string, signal?: AbortSignal) => Promise<unknown>;
const fqdn = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const name = value.toLowerCase().replace(/\.$/, '');
  return name.length <= 253 && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/.test(name) ? name : null;
};

// Pin the connection to the validated peer address; never resolve through ambient DNS.
// Node HTTP does not follow redirects and receives no incoming headers or credentials.
export const probeHealth: Probe = (url, address, signal) => new Promise((resolve, reject) => {
  if (!isTailscaleIp(address)) return reject(new Error('Invalid peer.'));
  const target = new URL(url);
  if (target.protocol !== 'http:' || !fqdn(target.hostname) || target.pathname !== '/health' || target.search || target.username || target.password) return reject(new Error('Invalid candidate.'));
  const request = http.get(target, {
    agent: false, signal,
    lookup: (_host, _options, callback) => callback(null, [{ address, family: net.isIP(address) }]),
  }, response => {
    if (response.statusCode !== 200) { reject(new Error('Health unavailable.')); response.destroy(); request.destroy(); return; }
    const chunks: Buffer[] = []; let size = 0;
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4096) { reject(new Error('Health too large.')); response.destroy(); request.destroy(); }
      else chunks.push(chunk);
    });
    response.on('error', () => { reject(new Error('Health unavailable.')); request.destroy(); });
    response.on('aborted', () => { reject(new Error('Health unavailable.')); request.destroy(); });
    response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid health.')); } });
  });
  const timer = setTimeout(() => request.destroy(new Error('Health timeout.')), 1500);
  request.on('error', () => reject(new Error('Health unavailable.')));
  request.on('close', () => clearTimeout(timer));
});

export function createDiscovery({ exec, port, probe = probeHealth }: { exec: Exec; port: number; probe?: Probe }): Discovery {
  let pending: { controller: AbortController; consumers: number; result: Promise<DiscoveryResult> } | undefined;
  async function search(signal: AbortSignal): Promise<DiscoveryResult> {
    try {
      const result = await exec('tailscale', ['status', '--json'], { timeoutMs: 3000, signal });
      signal.throwIfAborted();
      if (result.code !== 0 || result.stdout.length > 1024 * 1024) throw new Error();
      const status = JSON.parse(result.stdout);
      const self = fqdn(status.Self?.DNSName);
      if (!self || status.BackendState !== 'Running' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
      const suffix = self.slice(self.indexOf('.'));
      const peers = new Map<string, string>();
      if (!status.Peer || typeof status.Peer !== 'object' || Array.isArray(status.Peer)) throw new Error();
      for (const peer of Object.values(status.Peer) as { DNSName?: unknown; TailscaleIPs?: unknown }[]) {
        const name = fqdn(peer?.DNSName);
        if (!name || name === self || !name.endsWith(suffix) || !Array.isArray(peer.TailscaleIPs)) continue;
        const address = peer.TailscaleIPs.find((ip: unknown) => typeof ip === 'string' && isTailscaleIp(ip));
        if (address) peers.set(name, address);
      }
      const candidates = [...peers].slice(0, 24); const bridges: DiscoveredBridge[] = [];
      let next = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (!signal.aborted && next < candidates.length) {
          const [name, address] = candidates[next++];
          const url = `http://${name}:${port}`;
          try {
            const health = await probe(url + '/health', address, signal) as Record<string, unknown>;
            signal.throwIfAborted();
            if (health?.ok !== true || health.service !== 'relayd') continue;
            const version = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0 ? Number(v) : null;
            bridges.push({ name: name.split('.')[0], url, protocolVersion: version(health.protocolVersion), minAppProtocolVersion: version(health.minAppProtocolVersion) });
          } catch { /* A peer without a responding Puente is not a discovered Puente. */ }
        }
      }));
      signal.throwIfAborted();
      return { bridges: bridges.sort((a, b) => a.url.localeCompare(b.url)), truncated: peers.size > 24 };
    } catch { throw new Error('Discovery unavailable.'); }
  }
  return { discover(signal) {
    if (signal?.aborted) return Promise.reject(new Error('Discovery cancelled.'));
    if (!pending) {
      const controller = new AbortController();
      const job = { controller, consumers: 0, result: search(controller.signal) };
      pending = job;
      void job.result.finally(() => { if (pending === job) pending = undefined; }).catch(() => {});
    }
    const job = pending;
    job.consumers++;
    return new Promise<DiscoveryResult>((resolve, reject) => {
      let settled = false;
      const finish = (result?: DiscoveryResult, error?: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        if (--job.consumers === 0) {
          job.controller.abort();
          if (pending === job) pending = undefined;
        }
        if (error) reject(error); else resolve(result!);
      };
      const abort = () => finish(undefined, new Error('Discovery cancelled.'));
      signal?.addEventListener('abort', abort, { once: true });
      job.result.then(result => finish(result), error => finish(undefined, error));
    });
  } };
}
