const { withAndroidManifest } = require('expo/config-plugins');
const RECEIVER = 'expo.modules.relaywidget.RelayWidgetProvider';
function registerWidget(manifest) {
  const app = manifest.manifest.application[0];
  app.receiver = (app.receiver ?? []).filter(value => value.$['android:name'] !== RECEIVER);
  app.receiver.push({ $: { 'android:name': RECEIVER, 'android:exported': 'false', 'android:label': 'Relay' },
    'intent-filter': [{ action: [{ $: { 'android:name': 'android.appwidget.action.APPWIDGET_UPDATE' } }] }],
    'meta-data': [{ $: { 'android:name': 'android.appwidget.provider', 'android:resource': '@xml/relay_widget_info' } }],
  });
  return manifest;
}
module.exports = config => withAndroidManifest(config, config => { config.modResults = registerWidget(config.modResults); return config; });
module.exports.registerWidget = registerWidget;
