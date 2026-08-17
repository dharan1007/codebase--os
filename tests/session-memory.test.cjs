const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Database } = require('../dist/storage/Database.js');
const { SessionMemory } = require('../dist/core/context/SessionMemory.js');

test('SessionMemory reads recurring failures from failure_snapshots', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-session-memory-'));
  const dataDir = path.join(root, '.cos');
  const db = new Database(dataDir);
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const filePath = path.join(root, 'src', 'auth.ts');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'export const auth = true;\n', 'utf8');

  db.prepare(`
    INSERT INTO failure_snapshots
      (id, category, filePath, signature, message, stackTrace, contextBefore, timestamp, frequency)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('f1', 'runtime_crash', filePath, 'sig-auth', 'refresh token regression', null, '', Date.now(), 3);

  const memory = new SessionMemory(db, root).load(5);
  assert.equal(memory.recurringFailureFiles.length, 1);
  assert.equal(memory.recurringFailureFiles[0].file, 'src/auth.ts');
  assert.equal(memory.recurringFailureFiles[0].failureCount, 3);
  assert.match(memory.recurringFailureFiles[0].lastError, /refresh token regression/);
  assert.match(memory.formatted, /Recurring failure zones/);
});
