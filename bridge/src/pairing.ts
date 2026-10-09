import crypto from 'node:crypto';
import { DEVICE_KEY_BYTES, DEVICE_KEY_PREFIX, PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH, PAIRING_QR_TYPE, PAIRING_QR_VERSION, PAIRING_TTL_MS } from '../../protocol/protocol.ts';
import type { PairedDevice, PairingQrPayload, PairingResponse } from '../../protocol/protocol.ts';
import { guardAuthorization, hashDeviceKey } from './auth.ts';
import { isDeviceName } from './changeLog.ts';
import type { DeviceState, DeviceStore } from './deviceStore.ts';

export class PairingError extends Error {
  code: 'pairing_invalid' | 'device_not_found' | 'unavailable' | 'rate_limited';
  retryAfter: number;
  constructor(code: PairingError['code'], retryAfter = 0) {
    super({ pairing_invalid: 'Invalid pairing code.', device_not_found: 'Device not found.', unavailable: 'Pairing is unavailable.', rate_limited: 'Too many failed attempts.' }[code]);
    this.name = 'PairingError'; this.code = code; this.retryAfter = retryAfter;
  }
}

export function normalizePairingCode(value: string): string | null {
  const code = value.replace(/[ -]/g, '').replace(/[a-z]/g, (letter) => letter.toUpperCase()).replace(/O/g, '0').replace(/[IL]/g, '1');
  return code.length === PAIRING_CODE_LENGTH && [...code].every((letter) => PAIRING_CODE_ALPHABET.includes(letter)) ? code : null;
}

export function generatePairingCode(): string {
  return [...crypto.randomBytes(PAIRING_CODE_LENGTH)].map((byte) => PAIRING_CODE_ALPHABET[byte & 31]).join('');
}

export function pairingOrigin(dnsName: string, port: number): string {
  if (!/^[\x00-\x7f]+$/.test(dnsName)) throw new PairingError('unavailable');
  const name = dnsName.replace(/\.$/, '').toLowerCase();
  const labels = name.split('.');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || name.length > 253 || labels.length < 4
    || labels.slice(-2).join('.') !== 'ts.net' || !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new PairingError('unavailable');
  return `http://${name}:${port}`;
}

export function isPairingOrigin(value: string): boolean {
  const match = /^http:\/\/([^/:]+):([0-9]+)$/.exec(value);
  if (!match) return false;
  try { return value === pairingOrigin(match[1], Number(match[2])); }
  catch { return false; }
}

function hashCode(code: string): Buffer {
  return crypto.createHash('sha256').update('relay.pair.v1\0', 'utf8').update(code, 'utf8').digest();
}

function matches(state: DeviceState, value: string, now: number): boolean {
  const canonical = normalizePairingCode(value);
  const equal = crypto.timingSafeEqual(hashCode(canonical ?? ''), state.pendingPairing ? Buffer.from(state.pendingPairing.codeHash, 'hex') : Buffer.alloc(32));
  return equal && canonical !== null && state.pendingPairing !== null && now < state.pendingPairing.expiresAt;
}

function publicDevice(device: DeviceState['devices'][number]): PairedDevice {
  return { id: device.id, name: device.name, pairedAt: device.pairedAt, revokedAt: device.revokedAt };
}

export function createPairing(options: { store: DeviceStore; origin: () => Promise<string>; serverName: string }) {
  const { store } = options;
  return {
    async pair(): Promise<{ payload: PairingQrPayload; expiresAt: number }> {
      const url = await options.origin();
      if (!isPairingOrigin(url)) throw new PairingError('unavailable');
      return store.mutate((state, transaction) => {
        const code = generatePairingCode();
        const expiresAt = transaction.now + PAIRING_TTL_MS;
        state.pendingPairing = { codeHash: hashCode(code).toString('hex'), createdAt: transaction.now, expiresAt };
        return { payload: { type: PAIRING_QR_TYPE, version: PAIRING_QR_VERSION, url, code }, expiresAt };
      });
    },
    verify: (code: string, ip: string) => store.mutate((state, transaction) => {
      guardAuthorization(state, { ip }, transaction.now);
      return matches(state, code, transaction.now);
    }),
    /**
     * `peer` is the Tailscale name of the address the request came from. A device that reaches
     * the Puente through the Servidor itself (an emulator on it) arrives from the Servidor's own
     * address, so Tailscale names the Servidor: that device gets a generic name instead.
     */
    redeem(code: string, peer: string, ip: string): Promise<PairingResponse> {
      // Tailscale names a machine after the first label of its hostname.
      const name = peer.toLowerCase() === options.serverName.split('.')[0].toLowerCase() ? 'teléfono' : peer;
      return store.mutate((state, transaction) => {
        guardAuthorization(state, { ip }, transaction.now);
        if (!matches(state, code, transaction.now)) throw new PairingError('pairing_invalid');
        if (!isDeviceName(name)) throw new PairingError('unavailable');
        const deviceKey = DEVICE_KEY_PREFIX + crypto.randomBytes(DEVICE_KEY_BYTES).toString('base64url');
        const device = { id: crypto.randomUUID(), name, pairedAt: transaction.now, revokedAt: null, keyHash: hashDeviceKey(deviceKey).toString('hex') };
        state.pendingPairing = null;
        state.devices.push(device);
        state.failedAttempts = state.failedAttempts.filter((entry) => entry.ip !== ip);
        transaction.addChange({ actor: { kind: 'device', id: device.id, name }, action: 'device.paired', target: { kind: 'device', id: device.id } });
        return { deviceKey, device: { ...publicDevice(device), revokedAt: null }, server: { name: options.serverName } };
      });
    },
    devices: () => store.mutate((state) => ({ devices: state.devices.map(publicDevice) })),
    revoke: (id: string) => store.mutate((state, transaction) => {
      const device = state.devices.find((device) => device.id === id);
      if (!device) throw new PairingError('device_not_found');
      if (device.revokedAt === null) {
        device.revokedAt = transaction.now;
        transaction.addChange({ actor: { kind: 'server' }, action: 'device.revoked', target: { kind: 'device', id } });
      }
      return { device: publicDevice(device) };
    }),
  };
}

export type Pairing = ReturnType<typeof createPairing>;
