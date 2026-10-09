// Catalog absence must fail before an external request can be made.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RealHermes } from '../src/hermes_real.ts';
import { HermesError } from '../src/hermes.ts';
import { FakeHermes } from '../support/fake_hermes.ts';

const methods: [string, unknown[]][] = [
  ['models', ['default']],
];
for (const kind of ['real', 'fake']) test(`${kind} Hermes model catalog requires configured chat without external effects`, async (t) => {
  let effects = 0;
  const hermes = kind === 'fake' ? new FakeHermes() : new RealHermes({ home: '/fixture/not-an-install', bin: '/fixture/no-executable', exec: async () => { effects++; throw new Error('Unexpected exec'); }, fetch: (async () => { effects++; throw new Error('Unexpected fetch'); }) as typeof fetch });
  for (const [name, args] of methods) {
    const fn = (hermes as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name];
    assert.equal(typeof fn, 'function', name);
    await assert.rejects(fn.apply(hermes, args), (e: unknown) => e instanceof HermesError && e.code === (kind === 'fake' ? 'unavailable' : 'chat_unavailable'), name);
    assert.equal(effects, 0, name);
  }
});
