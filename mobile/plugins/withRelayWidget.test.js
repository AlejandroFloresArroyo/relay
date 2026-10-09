/* global __dirname */
const fs = require("node:fs");
const path = require("node:path");
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerWidget } = require('./withRelayWidget');
test('CNG registers one private widget receiver with resize metadata and no new service or permission, idempotently for either variant', () => {
  for (const packageName of ['io.fixture.relay', 'io.fixture.relay.dev']) {
    const input = { manifest: { $: { package: packageName }, application: [{ $: { 'android:name': '.MainApplication' }, receiver: [{ $: { 'android:name': 'ExistingReceiver' } }] }] } };
    const result = registerWidget(input);
    const app = result.manifest.application[0];
    assert.equal(app.receiver.length, 2);
    const widget = app.receiver.find(value => value.$['android:name'] === 'expo.modules.relaywidget.RelayWidgetProvider');
    assert.equal(widget.$['android:exported'], 'false');
    assert.deepEqual(widget['meta-data'], [{ $: { 'android:name': 'android.appwidget.provider', 'android:resource': '@xml/relay_widget_info' } }]);
    assert.equal(widget['intent-filter'][0].action[0].$['android:name'], 'android.appwidget.action.APPWIDGET_UPDATE');
    assert.equal(app.service, undefined); assert.equal(result.manifest['uses-permission'], undefined);
    assert.deepEqual(registerWidget(result), result);
  }
});

const res = path.join(__dirname, '../modules/relay-widget/android/src/main/res');

test('the widget picker describes the real behavior with no demo names, the same words as the preview', () => {
  assert.match(fs.readFileSync(path.join(res, 'xml/relay_widget_info.xml'), 'utf8'), /android:description="@string\/relay_widget_description"/);
  const description = fs.readFileSync(path.join(res, 'values/strings.xml'), 'utf8').match(/name="relay_widget_description">([^<]+)</)[1];
  assert.match(description, /un solo Servidor/); assert.match(description, /hasta tres de sus Agentes/);
  assert.doesNotMatch(description, /\b(atlas|dev|research|ops|homelab)\b/i);
  // Duplicated on purpose: the native picker cannot read the app's JS (WIDGET_EXPLANATION in src/core/widget.ts).
  const explanation = fs.readFileSync(path.join(__dirname, '../src/core/widget.ts'), 'utf8').match(/WIDGET_EXPLANATION = '([^']+)'/)[1];
  assert.equal(explanation, `El widget s${description.slice(1)}`);
});

test('an Agent name keeps to one line and ends in an ellipsis, never breaking mid-word', () => {
  for (const layout of ['relay_widget_compact.xml', 'relay_widget_wide.xml']) {
    const labels = fs.readFileSync(path.join(res, 'layout', layout), 'utf8').match(/<TextView android:id="@\+id\/relay_widget_label_\d"[^>]*>/g);
    assert.equal(labels.length, 3);
    for (const label of labels) { assert.match(label, /android:maxLines="1"/); assert.match(label, /android:ellipsize="end"/); }
  }
});
