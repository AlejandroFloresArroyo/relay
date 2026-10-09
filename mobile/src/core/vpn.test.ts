import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyConnectionError } from './connectionStatus.ts';
import { vpnConnectionDiagnosis, validVpnReading } from './vpn.ts';
test('VPN status only refines an unknown failed connection and never claims the provider or a down Server', () => {
  const down = classifyConnectionError(null);
  const absent = vpnConnectionDiagnosis(down, 'absent');
  assert.equal(absent.label, 'SIN VPN PARA RELAY'); assert.equal(absent.action, 'tailscale');
  const available = vpnConnectionDiagnosis(down, 'available');
  assert.equal(available.label, 'SERVIDOR SIN RESPUESTA'); assert.equal(available.action, 'retry');
  assert.match(available.hint, /VPN activa para Relay/); assert.doesNotMatch(available.hint, /Tailscale está|Servidor caído/);
});
test('only the exact metadata contract for the current generation is accepted', () => {
  const reading = { version: 1, scope: 'relay-default-network', generation: 3, sequence: 1, vpn: 'available', reason: 'capabilities' };
  assert.deepEqual(validVpnReading(reading, 3), reading);
  for (const bad of [{ ...reading, generation: 2 }, { ...reading, address: 'synthetic-address' }, { ...reading, sequence: -1 },
    { ...reading, reason: 'inactive' }, { ...reading, vpn: { toString: () => 'available' } }, { ...reading, reason: { toString: () => 'capabilities' } }, { ...reading, vpn: 'tailscale' }, { ...reading, scope: 'global-vpn' }]) assert.equal(validVpnReading(bad, 3), null);
});
