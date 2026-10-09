import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { realExec } from '../src/exec.ts';
const fixture = fileURLToPath(new URL('../support/fixtures/exec-input.cjs', import.meta.url));
// Starting node takes seconds on a loaded machine; only the timeout test measures the timeout itself.
const generous = 10_000;

test('ExecOptions.input writes stdin bytes and ends the stream', async () => {
  for (const input of ['Fixture\ntexto español', '']) {
    const result = await realExec(process.execPath, [fixture, 'echo'], { input, timeoutMs: generous });
    assert.deepEqual(result, { code: 0, stdout: input, stderr: '' });
  }
});
test('stdin execution timeout kills its fixture child', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-exec-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'pid');
  // A timeout shorter than node's startup kills the child before it records its pid. Double it until
  // the child records one, staying below the fixture's own exit, so the kill is always observed.
  let pid = 0;
  for (let timeoutMs = 300; !pid; timeoutMs *= 2) {
    assert.ok(timeoutMs <= 4800, 'fixture never started within the timeout');
    await assert.rejects(realExec(process.execPath, [fixture, 'timeout', file], { input: 'Fixture', timeoutMs }), new RegExp(`timed out after ${timeoutMs} ms`));
    pid = Number(await fs.readFile(file, 'utf8').catch(() => ''));
  }
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
test('stdin execution rejects capped output without including input or output in the error', async () => {
  await assert.rejects(realExec(process.execPath, [fixture, 'overflow'], { input: 'private-fixture-sentinel', timeoutMs: generous }), (e: Error) => /output limit/.test(e.message) && !e.message.includes('private-fixture-sentinel') && !e.message.includes('AAAA'));
});
test('stdin execution retains a nonzero exit code', async () => {
  assert.equal((await realExec(process.execPath, [fixture, 'exit'], { input: '', timeoutMs: generous })).code, 7);
});


test('ExecOptions.signal terminates a synthetic child before its timeout', async t => {
  const directory = await fs.mkdtemp(path.join(import.meta.dirname, '../../.synthetic-exec-cancel-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'pid.log');
  const controller = new AbortController();
  const execution = realExec(process.execPath, [fixture, 'timeout', file], { timeoutMs: 5000, signal: controller.signal });
  void execution.catch(() => {});
  // The child is not ours to await and reports its start only through the file, so poll for it.
  let pid = 0;
  for (const deadline = Date.now() + 4000; !pid && Date.now() < deadline;) {
    try { pid = Number(await fs.readFile(file, 'utf8')); } catch { await sleep(5); }
  }
  assert.ok(pid, 'Synthetic child must start before cancellation');
  controller.abort();
  let timer!: ReturnType<typeof setTimeout>;
  try {
    await assert.rejects(Promise.race([execution, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Cancellation was ignored')), 3000); })]), /ABORT_ERR/);
  } finally { clearTimeout(timer); }
  for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
    try { process.kill(pid, 0); } catch { break; }
    await sleep(5);
  }
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
