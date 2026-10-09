const { test } = require('node:test');
const assert = require('node:assert/strict');
const plugin = require('./withAppUpdate');
test('APK configuration requests only explicit user-mediated installation permission, preserving other features and idempotence', () => {
  assert.equal(typeof plugin.configureAppUpdateManifest, 'function');
  const manifest = { manifest: { 'uses-permission': [{ $: { 'android:name': 'android.permission.CAMERA' } }], application: [{ $: { 'android:label': 'Relay fixture' } }] } };
  const result = plugin.configureAppUpdateManifest(manifest);
  const permissions = result.manifest['uses-permission'].map(entry => entry.$['android:name']);
  assert.deepEqual(permissions, ['android.permission.CAMERA', 'android.permission.REQUEST_INSTALL_PACKAGES']);
  assert.equal(result.manifest.application[0].$['android:label'], 'Relay fixture');
  assert.deepEqual(plugin.configureAppUpdateManifest(result), result);
  assert.ok(!permissions.includes('android.permission.INSTALL_PACKAGES')); assert.ok(!permissions.includes('android.permission.DELETE_PACKAGES'));
});
