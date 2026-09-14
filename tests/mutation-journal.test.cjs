const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Database } = require('../dist/storage/Database.js');
const { MutationJournal } = require('../dist/storage/MutationJournal.js');
const { ChangeHistory } = require('../dist/storage/ChangeHistory.js');
const { MutationTransaction } = require('../dist/core/ai/MutationTransaction.js');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('applied mutation is rolled back safely after restart', t => {
  const root = tempRoot(t);
  const dataDir = path.join(root, '.cos');
  const target = path.join(root, 'a.txt');
  fs.writeFileSync(target, 'before\n');
  let db = new Database(dataDir);
  let journal = new MutationJournal(db);
  const id = journal.begin({ sessionId:'s1', step:1, operation:'modify', destinationPath:target, originalContent:'before\n' });
  fs.writeFileSync(target, 'after\n');
  journal.markApplied(id, 'after\n');
  db.close();
  db = new Database(dataDir);
  journal = new MutationJournal(db);
  const recovery = journal.recoverIncomplete(root);
  const restored = fs.readFileSync(target, 'utf8');
  const state = journal.getById(id).state;
  db.close();
  assert.equal(recovery.rolledBack, 1);
  assert.equal(recovery.diverged, 0);
  assert.equal(restored, 'before\n');
  assert.equal(state, 'ROLLED_BACK');
});

test('recovery refuses to overwrite a later developer edit', t => {
  const root = tempRoot(t);
  const db = new Database(path.join(root, '.cos'));
  const target = path.join(root, 'a.txt');
  fs.writeFileSync(target, 'before\n');
  const journal = new MutationJournal(db);
  const id = journal.begin({ sessionId:'s2', step:2, operation:'modify', destinationPath:target, originalContent:'before\n' });
  fs.writeFileSync(target, 'agent\n');
  journal.markApplied(id, 'agent\n');
  fs.writeFileSync(target, 'developer\n');
  const recovery = journal.recoverIncomplete(root);
  const current = fs.readFileSync(target, 'utf8');
  const state = journal.getById(id).state;
  db.close();
  assert.equal(recovery.rolledBack, 0);
  assert.equal(recovery.diverged, 1);
  assert.equal(current, 'developer\n');
  assert.equal(state, 'DIVERGED');
});

test('successful mutation transaction reaches committed journal state', async t => {
  const root = tempRoot(t);
  const db = new Database(path.join(root, '.cos'));
  const journal = new MutationJournal(db);
  const tx = new MutationTransaction(root, new ChangeHistory(db), 's3', 'openai', journal);
  const result = await tx.execute(3, { tool:'write_file', args:{ path:'created.txt', content:'durable\n' } });
  const rows = journal.getBySession('s3');
  db.close();
  assert.equal(result.success, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'COMMITTED');
  assert.equal(rows[0].updatedContent, 'durable\n');
});
