const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { Database } = require('../dist/storage/Database.js');
const { EmbeddingIndex } = require('../dist/core/context/EmbeddingIndex.js');

function root(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-indexed-retrieval-'));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

function provider(queryVector = [1, 0, 0, 0]) {
  return {
    kind: 'openai',
    execute: async () => { throw new Error('not used'); },
    isAvailable: async () => true,
    embed: async () => queryVector,
    batchEmbed: async texts => texts.map(text => {
      if (text.includes('needle')) return [1, 0, 0, 0];
      const h = crypto.createHash('sha256').update(text).digest();
      return [0, 1 + h[0] / 255, h[1] / 255, h[2] / 255];
    }),
  };
}

test('large vector corpus uses indexed LSH candidates instead of loading every sketch', async t => {
  const dir = root(t);
  const db = new Database(path.join(dir, '.cos'));
  t.after(() => db.close());
  const index = new EmbeddingIndex(db, provider());
  const chunks = Array.from({ length: 1005 }, (_, i) => ({
    id: i === 1004 ? 'needle' : `chunk-${i}`,
    filePath: path.join(dir, 'src', `${i}.ts`),
    content: i === 1004 ? 'needle exact semantic target' : `unrelated implementation ${i}`,
  }));
  await index.embedAndStore(chunks);

  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embedding_lsh_buckets'").get();
  assert.ok(table, 'LSH bucket table must exist');
  const bucketCount = Number(db.prepare('SELECT COUNT(*) AS count FROM embedding_lsh_buckets').get().count);
  assert.ok(bucketCount >= chunks.length, 'vectors must be represented in the candidate index');

  const originalPrepare = db.prepare.bind(db);
  db.prepare = function(sql) {
    if (/SELECT\s+id\s*,\s*sketchBlob\s+FROM\s+embeddings_cache/i.test(String(sql))) {
      throw new Error('full sketch scan forbidden for large corpus');
    }
    return originalPrepare(sql);
  };
  const result = await index.search('needle', 5);
  assert.equal(result[0]?.id, 'needle');
});

test('invalidating a file removes its persisted vector candidate buckets', async t => {
  const dir = root(t);
  const db = new Database(path.join(dir, '.cos'));
  t.after(() => db.close());
  const index = new EmbeddingIndex(db, provider());
  const filePath = path.join(dir, 'src', 'target.ts');
  await index.embedAndStore([{ id: 'target', filePath, content: 'needle target' }]);
  assert.ok(Number(db.prepare("SELECT COUNT(*) AS count FROM embedding_lsh_buckets WHERE chunk_id='target'").get().count) > 0);
  index.invalidateFile(filePath);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM embedding_lsh_buckets WHERE chunk_id='target'").get().count), 0);
});

test('legacy persisted vectors are deterministically backfilled into the candidate index', t => {
  const dir = root(t);
  const dataDir = path.join(dir, '.cos');
  const db = new Database(dataDir);
  const vector = [1, 0, 0, 0];
  const blob = Buffer.from(new Float32Array(vector).buffer);
  db.prepare(`INSERT INTO embeddings_cache
    (id,filePath,contentHash,content,embeddingBlob,sketchBlob,dim,updatedAt)
    VALUES (?,?,?,?,?,?,?,?)`).run(
      'legacy', path.join(dir, 'legacy.ts'), 'legacy-hash', 'legacy target', blob, blob, vector.length, Date.now(),
    );
  new EmbeddingIndex(db, provider());
  const first = db.prepare("SELECT table_id,bucket_hash FROM embedding_lsh_buckets WHERE chunk_id='legacy' ORDER BY table_id").all();
  assert.ok(first.length > 0);
  db.prepare("DELETE FROM embedding_lsh_buckets WHERE chunk_id='legacy'").run();
  new EmbeddingIndex(db, provider());
  const second = db.prepare("SELECT table_id,bucket_hash FROM embedding_lsh_buckets WHERE chunk_id='legacy' ORDER BY table_id").all();
  db.close();
  assert.deepEqual(second, first);
});
