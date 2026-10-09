/* global __dirname */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const plugin = require('./withVpnStatus');
test('the local plugin keeps network-state permission idempotent without privileged permissions or a VPN service', async () => {
  const input = { manifest: { $: {}, 'uses-permission': [{ $: { 'android:name': 'android.permission.INTERNET' } }, { $: { 'android:name': 'android.permission.ACCESS_NETWORK_STATE' } }], application: [{ $: { 'android:name': '.MainApplication' } }] } };
  const config = plugin({ name: 'Relay', slug: 'relay' });
  const out = await config.mods.android.manifest({ ...config, modResults: structuredClone(input), modRequest: {} });
  assert.deepEqual(out.modResults, input);
  const absent = structuredClone(input); absent.manifest['uses-permission'].pop();
  const first = await config.mods.android.manifest({ ...config, modResults: absent, modRequest: {} });
  assert.deepEqual(first.modResults, input);
  const twice = await config.mods.android.manifest({ ...config, modResults: first.modResults, modRequest: {} });
  assert.deepEqual(twice.modResults, input);
});
test('Expo discovers the local Android module from the project without Gradle or an external package', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [path.resolve(__dirname, '../node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js'), 'resolve', '--platform', 'android', '--json'], { cwd: path.resolve(__dirname, '..'), maxBuffer: 1024 * 1024 });
  const found = JSON.parse(stdout).modules.find(module => module.packageName === 'relay-vpn-status');
  assert.ok(found, 'Local VPN module must be autolinked');
  assert.deepEqual(found.projects.flatMap(project => project.modules.map(module => module.classifier)), ['expo.modules.relayvpn.RelayVpnStatusModule']);
});
