/* global __dirname */
// Pure native decisions compiled and run on the JVM, as shareNative.test.js does for SharePolicy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const modules = path.join(__dirname, '../modules');
const bin = (tool) => process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', tool) : tool;
function runJava(sources, main) {
  fs.mkdirSync(path.join(__dirname, '../.expo'), { recursive: true });
  const output = fs.mkdtempSync(path.join(__dirname, '../.expo/jvm-test-'));
  try {
    const compile = spawnSync(bin('javac'), ['-d', output, ...sources.map((file) => path.join(modules, file))], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync(bin('java'), ['-cp', output, main], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /GREEN/);
  } finally { fs.rmSync(output, { recursive: true, force: true }); }
}

test('the Avisos snapshot is discarded only for a GCM tag mismatch, never for another Keystore error', () => {
  runJava(['relay-notifications/android/src/main/java/expo/modules/relaynotifications/SnapshotDecryption.java', 'relay-notifications/test/SnapshotDecryptionTest.java'],
    'expo.modules.relaynotifications.SnapshotDecryptionTest');
});

test('the APK update rejects wrong metadata, signer, package, versionCode, hash and lengths before Android sees it', () => {
  runJava(['relay-apk-update/android/src/main/java/expo/modules/relayapkupdate/ApkVerification.java', 'relay-apk-update/test/ApkVerificationTest.java'],
    'expo.modules.relayapkupdate.ApkVerificationTest');
});

test('the widget converts Puente time by durations, never shows an expired reading as current, and retires on refusal', () => {
  runJava(['relay-widget/android/src/main/java/expo/modules/relaywidget/WidgetReading.java', 'relay-widget/test/WidgetReadingTest.java'],
    'expo.modules.relaywidget.WidgetReadingTest');
});

test('the widget coalesces push signals: one read in flight, at most one pending, the rest return at once', () => {
  runJava(['relay-widget/android/src/main/java/expo/modules/relaywidget/RefreshFlight.java', 'relay-widget/test/RefreshFlightTest.java'],
    'expo.modules.relaywidget.RefreshFlightTest');
});
