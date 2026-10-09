import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDemoClient, resetDemo } from './demo.ts';
import * as demo from './demoAppUpdate.ts';
test('APK demo uses the real client contract and presents publication, permission and verification-failure scenarios explicitly as simulation', async () => {
  resetDemo(); const client = createDemoClient('atlas');
  assert.equal(typeof client.appUpdate, 'function', 'Demo must implement APK metadata');
  const manifest = await client.appUpdate(); assert.equal(manifest.state, 'published');
  assert.equal(typeof demo.setDemoAppUpdateScenario, 'function');
  demo.setDemoAppUpdateScenario('atlas', 'unpublished'); assert.deepEqual(await client.appUpdate(), { state: 'unpublished' });
  demo.setDemoAppUpdateScenario('atlas', 'permission'); assert.equal((await demo.demoAppUpdateNative('atlas').info()).canInstall, false);
  demo.setDemoAppUpdateScenario('atlas', 'verify-error');
  const native = demo.demoAppUpdateNative('atlas'); const token = native.claim();
  assert.equal(manifest.state, 'published'); if (manifest.state !== 'published') throw new Error('Expected fixture');
  await native.open(token, manifest.artifact);
  await assert.rejects(native.verify(token)); native.retire(token);
});
