import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFailureLogger, serve } from '../src/main.ts';
import type { Exec } from '../src/exec.ts';
import { ConfigError } from '../src/config.ts';

test('production run logger suppresses arbitrary upstream identifiers errors and secrets', () => {
  const output: string[] = []; const logger = runFailureLogger(line => output.push(line));
  for (const value of ['synthetic-code', 'rly1_synthetic-key', 'a'.repeat(64), '{"input":"synthetic-body"}']) logger(`run ${value}: upstream failed: ${value}`);
  assert.deepEqual(output, Array(4).fill('Run processing failed.'));
});

test('production serve checks the local Tailscale bind before opening listeners or initializing Hermes', async () => {
  let starts = 0; const stop = new Error('Fake startup boundary');
  const exec: Exec = async (_file, args) => ({ code: 0, stderr: '', stdout: args[0] === 'status'
    ? JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'arch.example.ts.net.' } }) : '100.64.0.1\n' });
  const start: typeof import('../src/control.ts').startService = async (options) => {
    starts++; assert.equal(options.host, '100.64.0.1'); throw stop;
  };
  for (const host of [undefined, '127.0.0.1', '0.0.0.0', '192.168.1.1', '100.64.0.2']) await assert.rejects(serve({ env: { RELAY_HOST: host }, exec, start }), ConfigError);
  assert.equal(starts, 0);
  await assert.rejects(serve({ env: { RELAY_HOST: '100.64.0.1' }, exec, start }), error => error === stop); assert.equal(starts, 1);
});
