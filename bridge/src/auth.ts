import crypto from 'node:crypto';
import net from 'node:net';
import { AUTH_FAILURE_LIMIT, AUTH_FAILURE_WINDOW_MS, AUTH_PENALTY_MS, DEVICE_KEY_BYTES, DEVICE_KEY_PREFIX } from '../../protocol/protocol.ts';
import type { DeviceState, DeviceStore } from './deviceStore.ts';

export type AuthResult = { ok: true; deviceId: string; deviceName: string } | { ok: false; code: 'key_unknown' | 'device_revoked' };
export interface LimitResult { blocked: boolean; retryAfter: number }

export function hashDeviceKey(value: string): Buffer {
  return crypto.createHash('sha256').update('relay.device.v1\0', 'utf8').update(value, 'utf8').digest();
}

export function checkBearer(header: string | undefined, devices: DeviceState['devices']): AuthResult {
  const match = /^Bearer (.+)$/i.exec(header ?? '');
  const presented = match?.[1] ?? '';
  const hash = hashDeviceKey(presented);
  let found: DeviceState['devices'][number] | undefined;
  for (const device of devices) {
    if (crypto.timingSafeEqual(hash, Buffer.from(device.keyHash, 'hex'))) found = device;
  }
  if (devices.length === 0) crypto.timingSafeEqual(hash, Buffer.alloc(32));
  const encoded = presented.slice(DEVICE_KEY_PREFIX.length);
  const valid = presented.startsWith(DEVICE_KEY_PREFIX) && /^[A-Za-z0-9_-]{43}$/.test(encoded)
    && Buffer.from(encoded, 'base64url').length === DEVICE_KEY_BYTES && Buffer.from(encoded, 'base64url').toString('base64url') === encoded;
  if (!valid || !found) return { ok: false, code: 'key_unknown' };
  if (found.revokedAt !== null) return { ok: false, code: 'device_revoked' };
  return { ok: true, deviceId: found.id, deviceName: found.name };
}

export function normalizePeerIp(address: string | undefined): string | null {
  if (!address || !net.isIP(address)) return null;
  if (net.isIP(address) === 4) return address;
  try {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical);
    if (!mapped) return canonical;
    const high = parseInt(mapped[1], 16); const low = parseInt(mapped[2], 16);
    return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  } catch { return null; }
}

// Snapshot callers must observe expiry without changing or clearing failure counts.
export function inspectAuthLimit(state: DeviceState, ip: string, now: number): LimitResult {
  const attempts = state.failedAttempts.filter((entry) => entry.blockedUntil !== null
    ? now < entry.blockedUntil : entry.failures.some((at) => at > now - AUTH_FAILURE_WINDOW_MS));
  const entry = attempts.find((entry) => entry.ip === ip);
  if (entry?.blockedUntil !== null && entry?.blockedUntil !== undefined) {
    return { blocked: true, retryAfter: Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000)) };
  }
  if (!entry && attempts.length >= 4096) return { blocked: true, retryAfter: 60 };
  return { blocked: false, retryAfter: 0 };
}

export interface AuthorizationContext { ip: string; deviceId?: string }

export class AuthorizationError extends Error {
  code: 'device_revoked' | 'rate_limited';
  retryAfter: number;
  constructor(code: AuthorizationError['code'], retryAfter = 0) {
    super(code === 'device_revoked' ? 'Device has been revoked.' : 'Too many failed attempts.');
    this.name = 'AuthorizationError'; this.code = code; this.retryAfter = retryAfter;
  }
}

// One synchronous guard for private continuations and queued public pairing transactions.
export function guardAuthorization(state: DeviceState, context: AuthorizationContext, now: number): void {
  if (context.deviceId !== undefined && !state.devices.some((device) => device.id === context.deviceId && device.revokedAt === null)) {
    throw new AuthorizationError('device_revoked');
  }
  const limit = inspectAuthLimit(state, context.ip, now);
  if (limit.blocked) throw new AuthorizationError('rate_limited', limit.retryAfter);
}

export function createAuthLimiter(store: DeviceStore) {
  return {
    check: (ip: string) => store.mutate((state, transaction) => inspectAuthLimit(state, ip, transaction.now)),
    success: (ip: string) => store.mutate((state, transaction) => {
      const limit = inspectAuthLimit(state, ip, transaction.now);
      if (!limit.blocked) state.failedAttempts = state.failedAttempts.filter((entry) => entry.ip !== ip);
      return limit;
    }),
    failure: (ip: string) => store.mutate((state, transaction): LimitResult => {
      const limit = inspectAuthLimit(state, ip, transaction.now);
      if (limit.blocked) return limit;
      let entry = state.failedAttempts.find((entry) => entry.ip === ip);
      if (!entry) { entry = { ip, failures: [], blockedUntil: null }; state.failedAttempts.push(entry); }
      entry.failures.push(transaction.now);
      if (entry.failures.length >= AUTH_FAILURE_LIMIT) {
        entry.blockedUntil = transaction.now + AUTH_PENALTY_MS;
        transaction.addChange({ actor: { kind: 'server' }, action: 'auth.rate_limited', target: { kind: 'ip', id: ip }, details: { blockedUntil: entry.blockedUntil } });
        return { blocked: true, retryAfter: AUTH_PENALTY_MS / 1000 };
      }
      return { blocked: false, retryAfter: 0 };
    }),
  };
}
