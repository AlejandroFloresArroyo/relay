import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDemoClient, demoVpnAvailability } from './demo.ts';
import { vpnConnectionDiagnosis } from './vpn.ts';
import { DEMO_CONNECTION_SCENARIOS, setDemoConnection } from './demoConnection.ts';
import { pollConnection } from './connection.ts';

test('every demo connection scenario is reachable through the demo client', async () => {
  const client = createDemoClient('atlas', () => 1_000_000);
  for (const scenario of DEMO_CONNECTION_SCENARIOS) {
    setDemoConnection('atlas', scenario.id);
    const snap = await pollConnection(client, 'http://atlas.example.ts.net:8650');
    assert.equal(snap.protocol?.kind ?? null, scenario.protocolKind, scenario.id);
    assert.equal(snap.down?.label ?? null, scenario.label, scenario.id);
  }
  setDemoConnection('atlas', 'compatible');
});

test('offline VPN demos expose all three honest default-network readings without a Servidor', async () => {
  const client = createDemoClient('atlas', () => 1_000_000);
  for (const [id, vpn, label] of [['offline_vpn_available', 'available', 'SERVIDOR SIN RESPUESTA'], ['offline_vpn_absent', 'absent', 'SIN VPN PARA RELAY'], ['offline_vpn_unknown', 'unknown', 'SIN RESPUESTA']] as const) {
    setDemoConnection('atlas', id);
    const snap = await pollConnection(client, 'http://atlas.example.ts.net:8650');
    assert.equal(demoVpnAvailability('atlas'), vpn);
    assert.equal(snap.reachable, false); assert.equal(snap.protocolStale, true);
    assert.equal(vpnConnectionDiagnosis(snap.down!, demoVpnAvailability('atlas')).label, label);
  }
  setDemoConnection('atlas', 'compatible');
});
