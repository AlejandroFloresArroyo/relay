const assert = require('node:assert/strict');
const { test } = require('node:test');

const base = require('../app.json').expo;

test('unset and release variants preserve Relay identity, assets, camera and signing', () => {
  const { resolveAppConfig } = require('../app.config');
  const expected = {
    ...base,
    plugins: base.plugins.map((plugin) => plugin === './plugins/withTailnetCleartext'
      ? ['./plugins/withTailnetCleartext', { variant: 'release' }]
      : plugin),
  };
  for (const variant of [undefined, 'release']) {
    const config = resolveAppConfig(base, variant);
    assert.equal(config.name, 'Relay');
    assert.equal(config.android.package, 'io.github.alejandrofloresarroyo.relay');
    assert.equal(config.scheme, 'relay');
    assert.ok(config.plugins.includes('./plugins/withReleaseSigning'));
    assert.ok(!config.plugins.includes('expo-dev-client'));
    assert.deepEqual(config, expected);
  }
});

test('unknown APP_VARIANT fails instead of falling back to release', () => {
  const { resolveAppConfig } = require('../app.config');
  for (const variant of ['', 'debug', 'Development', 'production']) {
    assert.throws(() => resolveAppConfig(base, variant), /APP_VARIANT/);
  }
});

test('development changes only identity, dev-client and variant plugins without mutating the base', () => {
  const { resolveAppConfig } = require('../app.config');
  const original = structuredClone(base);
  const config = resolveAppConfig(base, 'development');
  assert.equal(config.name, 'Relay Dev');
  assert.equal(config.android.package, 'io.github.alejandrofloresarroyo.relay.dev');
  assert.equal(config.scheme, 'relay-dev');
  assert.ok(config.plugins.includes('expo-dev-client'));
  assert.ok(!config.plugins.includes('./plugins/withReleaseSigning'));
  assert.deepEqual(config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === './plugins/withTailnetCleartext'),
    ['./plugins/withTailnetCleartext', { variant: 'development' }]);
  assert.deepEqual(config, {
    ...base,
    name: 'Relay Dev',
    scheme: 'relay-dev',
    android: { ...base.android, package: 'io.github.alejandrofloresarroyo.relay.dev' },
    plugins: [
      ...base.plugins.filter((plugin) => plugin !== './plugins/withReleaseSigning')
        .map((plugin) => plugin === './plugins/withTailnetCleartext'
          ? ['./plugins/withTailnetCleartext', { variant: 'development' }]
          : plugin),
      'expo-dev-client',
    ],
  });
  assert.deepEqual(base, original);
  assert.deepEqual(resolveAppConfig(base), resolveAppConfig(original, 'release'));
});

test('Expo config reads only APP_VARIANT and passes its resolved value to the network plugin', () => {
  const appConfig = require('../app.config');
  const previousVariant = process.env.APP_VARIANT;
  const previousMode = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'development';
    delete process.env.APP_VARIANT;
    assert.equal(appConfig({ config: base }).name, 'Relay');
    process.env.APP_VARIANT = 'release';
    assert.equal(appConfig({ config: base }).name, 'Relay');
    process.env.APP_VARIANT = 'development';
    const development = appConfig({ config: base });
    assert.equal(development.name, 'Relay Dev');
    assert.deepEqual(development.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === './plugins/withTailnetCleartext'),
      ['./plugins/withTailnetCleartext', { variant: 'development' }]);
    process.env.APP_VARIANT = 'debug';
    assert.throws(() => appConfig({ config: base }), /APP_VARIANT/);
  } finally {
    if (previousVariant === undefined) delete process.env.APP_VARIANT;
    else process.env.APP_VARIANT = previousVariant;
    if (previousMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousMode;
  }
});


test('release update keeps the installed identity and advances its Android build', () => {
  const { resolveAppConfig } = require('../app.config');
  const config = resolveAppConfig(base, 'release');
  assert.equal(config.android.package, 'io.github.alejandrofloresarroyo.relay');
  // 7 is the last installed build (3.0.0); updates must exceed it.
  assert.ok(Number.isSafeInteger(config.android.versionCode) && config.android.versionCode > 7);
  assert.equal(config.version, require('../package.json').version);
  assert.equal(config.version, require('../package-lock.json').packages[''].version);
});
