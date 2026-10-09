const { withAndroidManifest } = require('expo/config-plugins');
module.exports = function withVpnStatus(config) {
  return withAndroidManifest(config, config => {
    const permissions = config.modResults.manifest['uses-permission'] ?? [];
    if (!permissions.some(permission => permission.$['android:name'] === 'android.permission.ACCESS_NETWORK_STATE')) {
      permissions.push({ $: { 'android:name': 'android.permission.ACCESS_NETWORK_STATE' } });
    }
    config.modResults.manifest['uses-permission'] = permissions;
    return config;
  });
};
