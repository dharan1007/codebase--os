const test = require('node:test');
const assert = require('node:assert/strict');

const { ProviderError, classifyProviderError } = require('../dist/core/ai/providers/ProviderError.js');
const { ProviderHealthTracker } = require('../dist/core/orchestrator/ProviderHealthTracker.js');
const { TrafficController } = require('../dist/core/orchestrator/TrafficController.js');

function request(overrides = {}) {
  return {
    taskType: 'reasoning',
    priority: 'high',
    context: 'test',
    maxTokens: 32,
    ...overrides,
  };
}

test('insufficient quota is fatal even when provider reports HTTP 429', () => {
  const raw = Object.assign(new Error('You exceeded your current quota; check billing'), {
    status: 429,
    code: 'insufficient_quota',
  });
  const error = classifyProviderError(raw, 'openai');
  assert.equal(error.code, 'QUOTA_EXCEEDED');
  assert.equal(error.isRetryable, false);
  assert.equal(error.isFatal, true);
});

test('classified rate limits preserve explicit retry-after delay', () => {
  const raw = Object.assign(new Error('rate limit'), { status: 429, retryAfterMs: 2750 });
  const error = classifyProviderError(raw, 'openai');
  assert.equal(error.code, 'RATE_LIMIT');
  assert.equal(error.retryAfterMs, 2750);
});

test('scheduler aborts an in-flight provider call at the request deadline', async () => {
  const controller = TrafficController.createIsolated();
  let aborted = false;
  controller.setNetworkExecutor(req => new Promise((_resolve, reject) => {
    const signal = req.requestDetails.signal;
    if (!signal) return;
    signal.addEventListener('abort', () => {
      aborted = true;
      reject(new Error('aborted by deadline'));
    }, { once: true });
  }));

  await assert.rejects(
    controller.schedule(request({ timeoutMs: 60 }), ['openai']),
    /PROVIDER_TIMEOUT/,
  );
  assert.equal(aborted, true);
});

test('fatal provider failures are excluded instead of retried in later rounds', async () => {
  const controller = TrafficController.createIsolated();
  const seen = [];
  controller.setNetworkExecutor(async (_req, provider) => {
    seen.push(provider);
    throw new ProviderError('AUTH_ERROR', 'bad key', provider, 401);
  });

  await assert.rejects(
    controller.schedule(request({ timeoutMs: 1000 }), ['openai', 'anthropic']),
    /PROVIDER_EXHAUSTED/,
  );
  assert.deepEqual(seen, ['openai', 'anthropic']);
});

test('provider health is isolated by model identity', () => {
  const tracker = new ProviderHealthTracker();
  const error = new ProviderError('RATE_LIMIT', 'limited', 'openai', 429);
  tracker.reportFailure('openai', error, 'model-a');
  tracker.reportFailure('openai', error, 'model-a');
  tracker.reportFailure('openai', error, 'model-a');

  assert.equal(tracker.isHealthy('openai', 'model-a'), false);
  assert.equal(tracker.isHealthy('openai', 'model-b'), true);
});
