const { withAndroidManifest } = require('expo/config-plugins');
const PERMISSION = 'android.permission.REQUEST_INSTALL_PACKAGES';
function configureAppUpdateManifest(manifest) {
  const permissions = manifest.manifest['uses-permission'] ?? [];
  if (!permissions.some(entry => entry.$?.['android:name'] === PERMISSION)) permissions.push({ $: { 'android:name': PERMISSION } });
  manifest.manifest['uses-permission'] = permissions;
  return manifest;
}
function withAppUpdate(config) {
  return withAndroidManifest(config, config => { config.modResults = configureAppUpdateManifest(config.modResults); return config; });
}
module.exports = withAppUpdate;
module.exports.configureAppUpdateManifest = configureAppUpdateManifest;
