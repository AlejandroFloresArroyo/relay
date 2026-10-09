import assert from 'node:assert/strict';
import test from 'node:test';
import { filterModelOptions } from './modelOptions.ts';

const models = [
  { provider: 'openrouter', model: 'anthropic/claude-sonnet', label: 'Sonnet' },
  { provider: 'anthropic', model: 'claude-sonnet', label: 'Claude Sonnet' },
  { provider: 'ollama', model: 'llama:latest', label: 'Llama local' },
];
test('search matches model name or identifier, ignores case and combines with exact provider', () => {
  assert.deepEqual(filterModelOptions(models, ' SONNET ', null), [models[0], models[1]]);
  assert.deepEqual(filterModelOptions(models, 'ANTHROPIC/', null), [models[0]]);
  assert.deepEqual(filterModelOptions(models, 'local', 'ollama'), [models[2]]);
  assert.deepEqual(filterModelOptions(models, 'sonnet', 'ollama'), []);
  assert.deepEqual(filterModelOptions(models, '', 'anthropic'), [models[1]]);
  assert.deepEqual(filterModelOptions(models, '  ', null), models);
});
