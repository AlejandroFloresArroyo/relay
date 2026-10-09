import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoSpeech, DEMO_DICTATION_SCENARIOS, demoDictationScenario, resetDemoDictation, setDemoDictationScenario } from './demoDictation.ts';

test('demo dictation includes every canvas and keeps microphone state local to its server', () => {
  resetDemoDictation();
  assert.deepEqual(DEMO_DICTATION_SCENARIOS.map((scenario) => scenario.id), ['idle', 'listening', 'finishing', 'model-missing', 'permission-missing', 'checking', 'error', 'blocked']);
  setDemoDictationScenario('A', 'model-missing');
  assert.equal(demoDictationScenario('A'), 'model-missing'); assert.equal(demoDictationScenario('B'), 'idle');
  resetDemoDictation(); assert.equal(demoDictationScenario('A'), 'idle');
});
test('demo local capability and permissions reproduce both blocked canvases without recording', async () => {
  assert.deepEqual((await createDemoSpeech('model-missing').getSupportedLocales({})).installedLocales, []);
  assert.equal((await createDemoSpeech('permission-missing').getPermissionsAsync()).granted, false);
});
test('demo partial text grows and cancellation clears scheduled text', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const port = createDemoSpeech('listening'); const results: string[] = []; let ends = 0;
  port.addListener('result', (event) => { results.push(event.results[0].transcript); });
  port.addListener('end', () => { ends++; });
  port.start({ lang: 'es-US', requiresOnDeviceRecognition: true });
  assert.deepEqual(results, ['Revisa']);
  t.mock.timers.tick(500); assert.equal(results.length, 2);
  port.abort(); t.mock.timers.tick(2000); assert.equal(results.length, 2); assert.equal(ends, 1);
});
