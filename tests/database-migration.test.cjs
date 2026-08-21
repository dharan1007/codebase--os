const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BetterSQLite3 = require('better-sqlite3');
const { Database } = require('../dist/storage/Database.js');

test('Database migrates legacy change_records without deleting existing rows', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-db-migration-'));
  const dataDir = path.join(root, '.cos');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'cos.db');

  const legacy = new BetterSQLite3(dbPath);
  legacy.exec(`
    CREATE TABLE change_records (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      original_content TEXT NOT NULL,
      updated_content TEXT NOT NULL,
      diff TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      rolled_back INTEGER NOT NULL DEFAULT 0,
      rolled_back_at INTEGER,
      provider TEXT NOT NULL,
      confidence REAL NOT NULL,
      impact_report_id TEXT
    );
  `);
  legacy.prepare(`
    INSERT INTO change_records
      (id, session_id, task_id, file_path, original_content, updated_content, diff,
       applied_at, rolled_back, provider, confidence, impact_report_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)
  `).run('legacy-1', 's1', 't1', path.join(root, 'a.ts'), 'a', 'b', '-a\n+b', Date.now(), 'openai', 0.8);
  legacy.close();

  const db = new Database(dataDir);
  t.after(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const columns = db.prepare('PRAGMA table_info(change_records)').all().map(row => row.name);
  assert.ok(columns.includes('operation'));
  assert.ok(columns.includes('source_path'));

  const row = db.prepare('SELECT id, operation, source_path FROM change_records WHERE id = ?').get('legacy-1');
  assert.equal(row.id, 'legacy-1');
  assert.equal(row.operation, 'modify');
  assert.equal(row.source_path, null);
});
