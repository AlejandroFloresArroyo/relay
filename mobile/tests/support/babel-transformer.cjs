const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createTransformer } = require('babel-jest');

const projectRoot = path.resolve(__dirname, '../..');
const adapter = fs.readFileSync(__filename);
const appConfig = fs.readFileSync(path.join(projectRoot, 'app.json'));
function makeTransformer(supportsReactCompiler, isNodeModule) {
  return createTransformer({
    babelrc: false,
    configFile: false,
    presets: [require.resolve('babel-preset-expo')],
    plugins: supportsReactCompiler ? [require.resolve('@babel/plugin-transform-dynamic-import')] : [],
    caller: {
      bundler: 'metro', platform: 'android', isDev: true, projectRoot,
      supportsStaticESM: false, supportsReactCompiler, isNodeModule,
    },
  });
}
const app = makeTransformer(true, false);
let externalIsNodeModule = false;
let external = makeTransformer(false, externalIsNodeModule);
function select(filename) {
  const isNodeModule = filename.includes(`${path.sep}node_modules${path.sep}`);
  if (!isNodeModule && filename.startsWith(`${projectRoot}${path.sep}src${path.sep}`)) return app;
  if (externalIsNodeModule !== isNodeModule) {
    externalIsNodeModule = isNodeModule;
    external = makeTransformer(false, isNodeModule);
  }
  return external;
}
function key(upstream) {
  return createHash('sha256').update(adapter).update(appConfig).update(upstream).digest('hex');
}
module.exports = {
  canInstrument: true,
  process(source, filename, options) { return select(filename).process(source, filename, options); },
  processAsync(source, filename, options) { return select(filename).processAsync(source, filename, options); },
  getCacheKey(source, filename, options) { return key(select(filename).getCacheKey(source, filename, options)); },
  async getCacheKeyAsync(source, filename, options) { return key(await select(filename).getCacheKeyAsync(source, filename, options)); },
};
