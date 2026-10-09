const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const transformer = require('./babel-transformer.cjs');
const rootDir = path.resolve(__dirname, '../..');
const options = { config: { cwd: rootDir, rootDir }, configString: '{}', instrument: false, supportsStaticESM: false };
const source = 'import { Text } from "react-native"; export function Example({name}) { return <Text>{name}</Text>; }';
const app = path.join(rootDir, 'src/Example.tsx');
const dependency = path.join(rootDir, 'node_modules/react-native/Example.tsx');
const fixture = path.join(rootDir, 'tests/support/Example.tsx');
(async () => {
  const launcherPath = path.join(rootDir, 'src/state/openTailscale.ts');
  const launcher = transformer.process(fs.readFileSync(launcherPath, 'utf8'), launcherPath, options).code;
  assert.match(launcher, /require\(["']react-native["']\)/);
  assert.doesNotMatch(launcher, /\bimport\s*\(/);
  const compiled = transformer.process(source, app, options).code;
  assert.match(compiled, /react\/compiler-runtime/);
  assert.doesNotMatch(compiled, /<Text>/);
  for (const filename of [dependency, fixture]) {
    assert.doesNotMatch(transformer.process(source, filename, options).code, /react\/compiler-runtime/);
    assert.notEqual(transformer.getCacheKey(source, app, options), transformer.getCacheKey(source, filename, options));
  }
  assert.equal((await transformer.processAsync(source, app, options)).code, compiled);
  assert.equal(await transformer.getCacheKeyAsync(source, app, options), transformer.getCacheKey(source, app, options));
})().catch((error) => { console.error(error); process.exitCode = 1; });
