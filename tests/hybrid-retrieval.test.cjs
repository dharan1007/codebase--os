const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Database } = require('../dist/storage/Database.js');
const { EmbeddingIndex } = require('../dist/core/context/EmbeddingIndex.js');

test('hybrid retrieval retains a lexical arm when provider has no embedding API', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-hybrid-retrieval-'));
  const db = new Database(path.join(root, '.cos'));
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const provider = {
    kind: 'anthropic',
    execute: async () => { throw new Error('not used'); },
    isAvailable: async () => true,
  };
  const index = new EmbeddingIndex(db, provider);
  await index.embedAndStore([
    {
      id: 'auth-refresh',
      filePath: path.join(root, 'src', 'auth.ts'),
      content: 'function rotateRefreshToken() { return invalidateConsumedRefreshToken(); }',
    },
    {
      id: 'billing-charge',
      filePath: path.join(root, 'src', 'billing.ts'),
      content: 'function chargeCard() { return paymentGateway.charge(); }',
    },
  ]);

  const result = await index.hybridSearch('invalidate refresh token', 3);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'auth-refresh');

  const stats = index.getStats();
  assert.equal(stats.totalChunks, 2);
  assert.equal(stats.vectorChunks, 0);
});
