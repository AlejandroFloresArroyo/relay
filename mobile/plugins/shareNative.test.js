/* global __dirname */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '../modules/relay-share');
test('native public policy rejects unauthorized destinations, grants, files and oversized/mismatched streams', () => {
  fs.mkdirSync(path.join(__dirname, '../.expo'), { recursive: true });
  const output = fs.mkdtempSync(path.join(__dirname, '../.expo/share-test-'));
  try {
    const compile = spawnSync(process.env.RELAY_SHARE_JAVA_BIN || process.env.JAVA_HOME ? path.join(process.env.RELAY_SHARE_JAVA_BIN || path.join(process.env.JAVA_HOME, 'bin'), 'javac') : 'javac', ['-d', output, path.join(root, 'android/src/main/java/relay/modules/share/SharePolicy.java'), path.join(root, 'test/SharePolicyTest.java')], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync(process.env.RELAY_SHARE_JAVA_BIN || process.env.JAVA_HOME ? path.join(process.env.RELAY_SHARE_JAVA_BIN || path.join(process.env.JAVA_HOME, 'bin'), 'java') : 'java', ['-cp', output, 'relay.modules.share.SharePolicyTest'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /GREEN/);
  } finally { fs.rmSync(output, { recursive: true, force: true }); }
});

test('SDK57 autolinking resolves the separate receiver module without modifying app registration', () => {
  const cli = require.resolve('expo-modules-autolinking/bin/expo-modules-autolinking.js');
  const result = spawnSync(process.execPath, [cli, 'resolve', '--platform', 'android', '--json'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const modules = JSON.parse(result.stdout).modules;
  const receiver = modules.find((row) => row.packageName === 'relay-share');
  assert.ok(receiver, 'receiver module was not autolinked');
  assert.equal(receiver.projects[0].modules[0].classifier, 'relay.modules.share.RelayShareModule');
  const manifest = fs.readFileSync(path.join(root, 'android/src/main/AndroidManifest.xml'), 'utf8');
  assert.match(manifest, /relay.modules.share.ShareReceiverActivity/);
  assert.doesNotMatch(manifest, /SEND_MULTIPLE|VIEW|READ_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE|MainActivity/);
});
