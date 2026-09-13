const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderRegistry } = require('../dist/core/ai/ProviderRegistry.js');

test('ProviderRegistry reuses the same provider/model instance', () => {
  const registry = ProviderRegistry.getInstance();
  registry.reset();

  const first = registry.getProvider('openai', 'test-key', 'model-a');
  const second = registry.getProvider('openai', 'test-key', 'model-a');

  assert.strictEqual(first, second);
  registry.reset();
});

test('ProviderRegistry does not reuse a provider configured for a different model', () => {
  const registry = ProviderRegistry.getInstance();
  registry.reset();

  const first = registry.getProvider('openai', 'test-key', 'model-a');
  const second = registry.getProvider('openai', 'test-key', 'model-b');

  assert.notStrictEqual(first, second);
  registry.reset();
});
