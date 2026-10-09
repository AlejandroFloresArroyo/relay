// The terminal runs xterm in Expo's DOM WebView (@expo/dom-webview). Version 57.0.1 turns on
// allowFileAccess and allowFileAccessFromFileURLs for every page and no prop changes it, so a script
// in the page could read the app's private files with XMLHttpRequest (#77, docs/research/v3-xterm.md).
// CNG turns both off before the module is compiled; the bundle still loads from file:///android_asset,
// which these settings do not cover. Expo links the module as a prebuilt AAR unless package.json lists
// it under expo.autolinking.android.buildFromSource: without that the patched source is never compiled,
// so the build stops instead.
const fs = require('node:fs/promises');
const path = require('node:path');
const { withDangerousMod } = require('expo/config-plugins');

const OPEN = '      settings.allowFileAccess = true\n      settings.allowFileAccessFromFileURLs = true\n';
const CLOSED = '      // Relay: the page never reads the app\'s files (mobile/plugins/withDomWebViewFileAccess.js).\n      settings.allowFileAccess = false\n      settings.allowFileAccessFromFileURLs = false\n';

function closeFileAccess(source, version) {
  if (version !== '57.0.1') throw new Error('Relay DOM WebView: review @expo/dom-webview file access for this version before building.');
  const original = source.includes(CLOSED) ? source.replace(CLOSED, OPEN) : source;
  if (original.split(OPEN).length !== 2 || original.split('allowFileAccess').length !== 3) {
    throw new Error('Relay DOM WebView: the file access settings changed; review before building.');
  }
  return original.replace(OPEN, CLOSED);
}

function requireSourceBuild(packageJson) {
  const fromSource = packageJson.expo?.autolinking?.android?.buildFromSource;
  if (!Array.isArray(fromSource) || !fromSource.includes('expo-dom-webview')) {
    throw new Error('Relay DOM WebView: list expo-dom-webview in expo.autolinking.android.buildFromSource, or the prebuilt AAR keeps file access on.');
  }
}

function withDomWebViewFileAccess(config) {
  return withDangerousMod(config, ['android', async (config) => {
    const root = config.modRequest.projectRoot;
    requireSourceBuild(JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')));
    const packageFile = require.resolve('@expo/dom-webview/package.json', { paths: [require.resolve('expo/package.json', { paths: [root] })] });
    const { version } = JSON.parse(await fs.readFile(packageFile, 'utf8'));
    const file = path.join(path.dirname(packageFile), 'android/src/main/java/expo/modules/webview/DomWebView.kt');
    const source = await fs.readFile(file, 'utf8');
    const output = closeFileAccess(source, version);
    if (output !== source) await fs.writeFile(file, output, 'utf8');
    return config;
  }]);
}

module.exports = withDomWebViewFileAccess;
module.exports.closeFileAccess = closeFileAccess;
module.exports.requireSourceBuild = requireSourceBuild;
