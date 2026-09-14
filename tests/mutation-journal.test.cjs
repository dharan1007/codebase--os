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
  const root = tempRoot(t), dataDir = path.join(root, '.cos'), target = path.join(root, 'a.txt');
  fs.writeFileSync(target, 'before\n');
  let db = new Database(dataDir), journal = new MutationJournal(db);
  const id = journal.begin({ sessionId:'s1', step:1, operation:'modify', destinationPath:target, originalContent:'before\n' });
  fs.writeFileSync(target, 'after\n'); journal.markApplied(id, 'after\n'); db.close();
  db = new Database(dataDir); journal = new MutationJournal(db);
  const recovery = journal.recoverIncomplete(root), restored = fs.readFileSync(target, 'utf8'), state = journal.getById(id).state;
  db.close();
  assert.equal(recovery.rolledBack, 1); assert.equal(recovery.diverged, 0); assert.equal(restored, 'before\n'); assert.equal(state, 'ROLLED_BACK');
});

test('recovery refuses to overwrite a later developer edit', t => {
  const root = tempRoot(t), db = new Database(path.join(root, '.cos')), target = path.join(root, 'a.txt');
  fs.writeFileSync(target, 'before\n'); const journal = new MutationJournal(db);
  const id = journal.begin({ sessionId:'s2', step:2, operation:'modify', destinationPath:target, originalContent:'before\n' });
  fs.writeFileSync(target, 'agent\n'); journal.markApplied(id, 'agent\n'); fs.writeFileSync(target, 'developer\n');
  const recovery=journal.recoverIncomplete(root), current=fs.readFileSync(target,'utf8'), state=journal.getById(id).state; db.close();
  assert.equal(recovery.rolledBack,0); assert.equal(recovery.diverged,1); assert.equal(current,'developer\n'); assert.equal(state,'DIVERGED');
});

test('successful mutation transaction reaches committed journal state', async t => {
  const root=tempRoot(t), db=new Database(path.join(root,'.cos')), journal=new MutationJournal(db);
  const tx=new MutationTransaction(root,new ChangeHistory(db),'s3','openai',journal);
  const result=await tx.execute(3,{tool:'write_file',args:{path:'created.txt',content:'durable\n'}}), rows=journal.getBySession('s3'); db.close();
  assert.equal(result.success,true); assert.equal(rows.length,1); assert.equal(rows[0].state,'COMMITTED'); assert.equal(rows[0].updatedContent,'durable\n');
});

test('recovery refuses to follow a repository symlink outside the project root', t => {
  const root=tempRoot(t), outside=fs.mkdtempSync(path.join(os.tmpdir(),'cos-journal-outside-'));
  t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  const link=path.join(root,'escape');
  try { fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir'); }
  catch(error) { t.skip(`symlinks unavailable: ${error.code||error.message}`); return; }
  const external=path.join(outside,'target.txt'); fs.writeFileSync(external,'agent\n');
  const db=new Database(path.join(root,'.cos')), journal=new MutationJournal(db);
  const id=journal.begin({sessionId:'s4',step:4,operation:'modify',destinationPath:path.join(link,'target.txt'),originalContent:'before\n'});
  journal.markApplied(id,'agent\n');
  const recovery=journal.recoverIncomplete(root), externalContent=fs.readFileSync(external,'utf8'), state=journal.getById(id).state; db.close();
  assert.equal(recovery.rolledBack,0); assert.equal(recovery.diverged,1); assert.equal(externalContent,'agent\n'); assert.equal(state,'DIVERGED');
});

test('recovery fsyncs restored contents before reporting rollback success', t => {
  const root=tempRoot(t), target=path.join(root,'a.txt'); fs.writeFileSync(target,'before\n');
  const db=new Database(path.join(root,'.cos')), journal=new MutationJournal(db);
  const id=journal.begin({sessionId:'s5',step:5,operation:'modify',destinationPath:target,originalContent:'before\n'});
  fs.writeFileSync(target,'agent\n'); journal.markApplied(id,'agent\n');
  const originalFsync=fs.fsyncSync; let calls=0;
  fs.fsyncSync=function(fd){calls++;return originalFsync.call(fs,fd);};
  let recovery, restored;
  try { recovery=journal.recoverIncomplete(root); restored=fs.readFileSync(target,'utf8'); }
  finally { fs.fsyncSync=originalFsync; db.close(); }
  assert.equal(recovery.rolledBack,1); assert.ok(calls>=1); assert.equal(restored,'before\n');
});
