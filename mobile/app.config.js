// Keep variant selection explicit; build mode and NODE_ENV do not change Relay's identity or network rules.
function resolveVariant(variant) {
  if (variant === undefined || variant === 'release') return 'release';
  if (variant === 'development') return 'development';
  throw new Error('APP_VARIANT must be unset, release or development.');
}

function resolveAppConfig(config, appVariant) {
  const variant = resolveVariant(appVariant);
  const isDevelopment = variant === 'development';
  const plugins = (config.plugins ?? [])
    .filter((plugin) => !isDevelopment || plugin !== './plugins/withReleaseSigning')
    .map((plugin) => plugin === './plugins/withTailnetCleartext'
      ? ['./plugins/withTailnetCleartext', { variant }]
      : plugin);
  if (isDevelopment) plugins.push('expo-dev-client');
  return {
    ...config,
    ...(isDevelopment ? {
      name: 'Relay Dev',
      scheme: 'relay-dev',
      android: { ...config.android, package: 'io.github.alejandrofloresarroyo.relay.dev' },
    } : {}),
    plugins,
  };
}

module.exports = ({ config }) => resolveAppConfig(config, process.env.APP_VARIANT);
module.exports.resolveVariant = resolveVariant;
module.exports.resolveAppConfig = resolveAppConfig;
