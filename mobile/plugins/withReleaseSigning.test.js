const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { MARKER, appendReleaseSigning } = require('./withReleaseSigning');

// The shape that matters from the Expo 57 template: release is signed with the public debug key.
const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.debug
        }
    }
}
`;

test('appends a release signing override after the template, leaving the template intact', () => {
  const out = appendReleaseSigning(TEMPLATE);
  assert.ok(out.startsWith(TEMPLATE));
  const added = out.slice(TEMPLATE.length);
  assert.ok(added.includes(MARKER));
  assert.match(added, /release\s*\{\s*signingConfig signingConfigs\.relayRelease/);
});

test('reads the key location at Gradle time, from the env var or ~/.config/relay', () => {
  const added = appendReleaseSigning(TEMPLATE).slice(TEMPLATE.length);
  assert.ok(added.includes('System.getenv("RELAY_SIGNING_PROPERTIES")'));
  assert.ok(added.includes('.config/relay/signing.properties'));
});

test('never writes a secret or a machine path into the generated project', () => {
  const added = appendReleaseSigning(TEMPLATE).slice(TEMPLATE.length);
  assert.doesNotMatch(added, /storePassword\s+['"]/);
  assert.doesNotMatch(added, /keyPassword\s+['"]/);
  assert.ok(!added.includes(process.env.HOME ?? '/home/'));
});

test('fails the release build instead of falling back to the debug key', () => {
  const added = appendReleaseSigning(TEMPLATE).slice(TEMPLATE.length);
  assert.ok(added.includes('throw new GradleException'));
  assert.ok(!added.includes('signingConfigs.debug'));
});

test('is idempotent', () => {
  const once = appendReleaseSigning(TEMPLATE);
  assert.equal(appendReleaseSigning(once), once);
});


test('replaces an older bounded generated block while preserving surrounding Gradle code', () => {
  const old = TEMPLATE + `\n${MARKER} (older version)\noldSigningBehavior()\n// @end relay-release-signing\notherPluginBehavior()\n`;
  const updated = appendReleaseSigning(old);
  assert.ok(!updated.includes('oldSigningBehavior()'));
  assert.ok(updated.includes('signingConfigs.relayRelease'));
  assert.ok(updated.endsWith('otherPluginBehavior()\n'));
  assert.equal(appendReleaseSigning(updated), updated);
});


test('upgrades the original unbounded signing block without deleting a later plugin', () => {
  const original = fs.readFileSync(path.join(__dirname, 'fixtures/release-signing-v1.gradle'), 'utf8');
  const updated = appendReleaseSigning(TEMPLATE + original + 'otherPluginBehavior()\n');
  assert.ok(updated.includes('// @end relay-release-signing'));
  assert.ok(updated.endsWith('otherPluginBehavior()\n'));
  assert.equal(appendReleaseSigning(updated), updated);
});
