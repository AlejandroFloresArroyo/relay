// Real Chromium against the lab. The target configuration must pass every check; serving the
// dev server directly must fail the guarantees, which shows the checks can fail at all.
// CHROMIUM=/path/to/chrome picks the browser (default /usr/bin/chromium).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLab, type Config } from '../src/lab.ts';
import { runScenario } from '../src/scenario.ts';

const executablePath = process.env.CHROMIUM ?? '/usr/bin/chromium';

async function run(config: Config) {
  let offset = 0;
  const lab = await startLab(config, { now: () => Date.now() + offset });
  try {
    const { results } = await runScenario(lab, { executablePath, advanceClock: (ms) => { offset += ms; } });
    return Object.fromEntries(results.map((r) => [r.id, r]));
  } finally {
    await lab.close();
  }
}

test('servicios-puente: every check passes in a real browser', async () => {
  const results = await run('servicios-puente');
  const failed = Object.values(results).filter((r) => !r.pass);
  assert.deepEqual(failed, []);
});

test('serve-directo: the same checks catch the missing Puente', async () => {
  const results = await run('serve-directo');
  for (const id of ['acceso', 'sin-escape', 'padre-http', 'reservadas', 'cruzadas']) {
    assert.equal(results[id].pass, false, `${id}: ${results[id].detail}`);
  }
});
