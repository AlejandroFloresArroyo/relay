import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Exec } from '../src/exec.ts';
import { createTailnet, isTailscaleIp } from '../src/tailnet.ts';

function fakeExec(stdout: string, code = 0) {
  const calls: { file: string; args: string[] }[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    return { code, stdout, stderr: '' };
  };
  return { calls, exec };
}

const WHOIS = JSON.stringify({
  Node: {
    Name: 'iphone-dev.tail0a1b2c.ts.net.',
    ComputedName: 'iphone-dev',
    Addresses: ['100.84.12.7/32'],
  },
  UserProfile: { LoginName: 'someone@example.com', DisplayName: 'Someone' },
});

test('isTailscaleIp accepts only the CGNAT range and the tailscale ULA prefix', () => {
  for (const ip of ['100.64.0.1', '100.84.12.7', '100.127.255.254', 'fd7a:115c:a1e0::1234:5678']) {
    assert.equal(isTailscaleIp(ip), true, ip);
  }
  for (const ip of ['100.63.0.1', '100.128.0.1', '127.0.0.1', '192.168.1.5', '::1', 'fd00::1', 'not-an-ip', '']) {
    assert.equal(isTailscaleIp(ip), false, ip);
  }
});

test('whois reads the device and tailnet from `tailscale whois --json`', async () => {
  const { calls, exec } = fakeExec(WHOIS);
  const tailnet = createTailnet(exec);
  assert.deepEqual(await tailnet.whois('100.84.12.7'), { device: 'iphone-dev', tailnet: 'tail0a1b2c.ts.net' });
  assert.deepEqual(calls, [{ file: 'tailscale', args: ['whois', '--json', '100.84.12.7'] }]);
});

test('whois caches per address, so an unauthenticated caller cannot spawn a process per request', async () => {
  const { calls, exec } = fakeExec(WHOIS);
  let now = 0;
  const tailnet = createTailnet(exec, 'tailscale', () => now);
  await tailnet.whois('100.84.12.7');
  await tailnet.whois('100.84.12.7');
  assert.equal(calls.length, 1);
  now += 61_000;
  await tailnet.whois('100.84.12.7');
  assert.equal(calls.length, 2);
});

test('whois never runs tailscale for an address outside the tailnet', async () => {
  const { calls, exec } = fakeExec(WHOIS);
  const tailnet = createTailnet(exec);
  assert.equal(await tailnet.whois('8.8.8.8'), null);
  assert.equal(await tailnet.whois('--json'), null);
  assert.equal(calls.length, 0);
});

test('whois is null when tailscale does not know the peer, fails, or is missing', async () => {
  assert.equal(await createTailnet(fakeExec('peer not found', 1).exec).whois('100.84.12.7'), null);
  assert.equal(await createTailnet(fakeExec('not json').exec).whois('100.84.12.7'), null);
  const missing: Exec = async () => {
    throw new Error('could not run tailscale: ENOENT');
  };
  assert.equal(await createTailnet(missing).whois('100.84.12.7'), null);
});
