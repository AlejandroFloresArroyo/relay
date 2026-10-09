const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { closeFileAccess, requireSourceBuild } = require('./withDomWebViewFileAccess');

const fixture = `    return WebView(context).apply {
      settings.javaScriptEnabled = true
      // API 30+ default disables file access; DOM bundles need it for sibling assets.
      settings.allowFileAccess = true
      settings.allowFileAccessFromFileURLs = true
      webViewClient = createWebViewClient()
    }`;

test('CNG turns off file access of the DOM WebView for the locked version, and is idempotent', () => {
  const output = closeFileAccess(fixture, '57.0.1');
  assert.match(output, /allowFileAccess = false\n {6}settings\.allowFileAccessFromFileURLs = false/);
  assert.doesNotMatch(output, /= true\n.*allowFileAccessFromFileURLs/);
  assert.equal(closeFileAccess(output, '57.0.1'), output);
});

test('another version or a changed source stops the build', () => {
  for (const [source, version] of [[fixture, '57.0.2'], [fixture.replace('allowFileAccessFromFileURLs = true', 'allowFileAccessFromFileURLs = isAllowed'), '57.0.1'],
    [fixture + '\n      settings.allowFileAccess = true', '57.0.1']]) {
    assert.throws(() => closeFileAccess(source, version), /Relay DOM WebView/);
  }
});

test('without building the module from source the patch would never be compiled: the build stops', () => {
  assert.throws(() => requireSourceBuild({}), /buildFromSource/);
  assert.throws(() => requireSourceBuild({ expo: { autolinking: { android: { buildFromSource: ['expo-camera'] } } } }), /buildFromSource/);
  // Relay's own package.json builds it from source.
  requireSourceBuild(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')));
});

test('the installed module source is supported', () => {
  const packageFile = require.resolve('@expo/dom-webview/package.json', { paths: [path.dirname(require.resolve('expo/package.json'))] });
  const source = fs.readFileSync(path.join(path.dirname(packageFile), 'android/src/main/java/expo/modules/webview/DomWebView.kt'), 'utf8');
  assert.match(closeFileAccess(source, require(packageFile).version), /allowFileAccess = false/);
});
