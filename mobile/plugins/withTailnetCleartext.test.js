const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const withTailnetCleartext = require('./withTailnetCleartext');

const {
  CLEARTEXT_DOMAINS,
  RESOURCE,
  networkSecurityConfigXml,
  setNetworkSecurityConfig,
} = require('./withTailnetCleartext');

// The part of the Expo 57 template's manifest the plugin touches.
const manifest = (attrs = {}) => ({
  manifest: {
    $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
    application: [{ $: { 'android:name': '.MainApplication', ...attrs } }],
  },
});

test('release XML permits only ts.net subdomains and never local hosts or a permissive base', () => {
  const xml = networkSecurityConfigXml('release');
  assert.deepEqual(CLEARTEXT_DOMAINS, ['ts.net']);
  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>\n<network-security-config>/);
  assert.match(
    xml,
    /<domain-config cleartextTrafficPermitted="true">\s*<domain includeSubdomains="true">ts\.net<\/domain>\s*<\/domain-config>/,
  );
  assert.equal(xml.match(/<domain[ >]/g).length, 1);
  assert.equal(xml.match(/cleartextTrafficPermitted="true"/g).length, 1);
  assert.doesNotMatch(xml, /localhost|127\.0\.0\.1/);
  assert.doesNotMatch(xml, /<base-config[^>]*cleartextTrafficPermitted="true"/);
  assert.equal(networkSecurityConfigXml(), xml);
});

test('development XML adds exactly localhost and 127.0.0.1 without their subdomains', () => {
  const xml = networkSecurityConfigXml('development');
  assert.match(xml, /<base-config cleartextTrafficPermitted="false"\s*\/>/);
  assert.deepEqual([...xml.matchAll(/<domain includeSubdomains="(true|false)">([^<]+)<\/domain>/g)]
    .map((match) => ({ host: match[2], subdomains: match[1] })), [
    { host: 'ts.net', subdomains: 'true' },
    { host: 'localhost', subdomains: 'false' },
    { host: '127.0.0.1', subdomains: 'false' },
  ]);
  assert.equal(xml.match(/<domain[ >]/g).length, 3);
  assert.equal(xml.match(/cleartextTrafficPermitted="true"/g).length, 1);
});

test('network XML rejects unknown variants', () => {
  assert.throws(() => networkSecurityConfigXml('debug'), /APP_VARIANT/);
});

test('the plugin uses explicit variants and overwrites development XML when returning to release', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-network-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'app/src/main/res/xml/network_security_config.xml');
  for (const variant of ['development', 'release', undefined]) {
    const config = withTailnetCleartext({ name: 'Relay', slug: 'relay' }, { variant });
    await config.mods.android.dangerous({ ...config, modRequest: { platformProjectRoot: root } });
    const xml = await fs.readFile(file, 'utf8');
    assert.equal(xml, networkSecurityConfigXml(variant));
    if (variant === 'development') assert.match(xml, /localhost/);
    else assert.doesNotMatch(xml, /localhost|127\.0\.0\.1/);
  }
});

test('the plugin rejects unknown variants before registering native changes', () => {
  assert.throws(() => withTailnetCleartext({ name: 'Relay', slug: 'relay' }, { variant: 'debug' }), /APP_VARIANT/);
});

test('everything outside the domain rule stays blocked, stated in the file instead of left to the platform default', () => {
  assert.match(networkSecurityConfigXml(), /<base-config cleartextTrafficPermitted="false"\s*\/>/);
});

test('the manifest points at the generated resource and never turns cleartext on globally', () => {
  const out = setNetworkSecurityConfig(manifest());
  const app = out.manifest.application[0].$;
  assert.equal(RESOURCE, '@xml/network_security_config');
  assert.equal(app['android:networkSecurityConfig'], RESOURCE);
  assert.equal(app['android:usesCleartextTraffic'], undefined);
  assert.equal(app['android:name'], '.MainApplication');
});

test('refuses to overwrite a network security config that something else already set', () => {
  assert.throws(() => setNetworkSecurityConfig(manifest({ 'android:networkSecurityConfig': '@xml/other' })), /already/);
  // its own value is fine: prebuild without --clean runs the plugin over its previous output
  const once = setNetworkSecurityConfig(manifest());
  assert.deepEqual(setNetworkSecurityConfig(once), once);
});

test('the app warns about exactly the hosts this config blocks', async () => {
  const { cleartextWillBeBlocked } = await import('../src/core/connection.ts');
  for (const domain of CLEARTEXT_DOMAINS) {
    assert.equal(cleartextWillBeBlocked(`http://arch.tailnet.${domain}:8650`), false);
  }
  assert.equal(cleartextWillBeBlocked('http://100.64.0.10:8650'), true);
});
