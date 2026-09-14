const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { VerificationEngine } = require('../dist/core/verification/VerificationEngine.js');
const { Database } = require('../dist/storage/Database.js');
const { SandboxManager } = require('../dist/core/sandbox/SandboxManager.js');
const { ProviderHealthTracker } = require('../dist/core/orchestrator/ProviderHealthTracker.js');

function tempRoot(t, prefix = 'cos-assurance-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function initGitRepo(root) {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'assurance@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Codebase OS Assurance'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
}

test('verification rejects evidence when repository state changes while gates execute', async t => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export const value = 1;\n');
  initGitRepo(root);
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export const value = 2;\n');

  let calls = 0;
  const sandbox = {
    async execute() {
      calls++;
      fs.writeFileSync(path.join(root, 'src', 'a.js'), `export const value = ${2 + calls};\n`);
      return { success: true, output: 'ok', exitCode: 0 };
    },
  };

  const engine = new VerificationEngine(root, {}, sandbox);
  const report = await engine.verify(['src/a.js']);

  assert.equal(report.success, false);
  assert.ok(report.checks.some(check => check.name === 'workspace-freshness' && check.success === false));
  assert.equal(typeof report.workspaceFingerprint, 'string');
  assert.ok(report.workspaceFingerprint.length >= 32);
});

test('database enables full synchronous durability and versioned schema metadata', t => {
  const root = tempRoot(t);
  const db = new Database(root);
  t.after(() => db.close());

  const synchronous = db.raw.pragma('synchronous', { simple: true });
  assert.equal(Number(synchronous), 2);

  const migrationTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get();
  assert.ok(migrationTable);

  assert.equal(typeof db.quickCheck, 'function');
  if (typeof db.quickCheck === 'function') {
    const result = db.quickCheck();
    assert.equal(result.ok, true);
    assert.equal(result.message.toLowerCase(), 'ok');
  }
});

test('default Node sandbox image stays on a supported runtime line', t => {
  const root = tempRoot(t);
  const sandbox = new SandboxManager(root);
  const image = sandbox.imageForCommand('node');
  assert.match(image, /^node:(?:22|24)(?:[.-]|$)/);
});

test('rate-limit circuit becomes eligible again after its cooldown expires', t => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });

  const tracker = new ProviderHealthTracker();
  tracker.reportFailure('openai', new Error('429 rate limit'));
  tracker.reportFailure('openai', new Error('429 rate limit'));
  tracker.reportFailure('openai', new Error('429 rate limit'));
  assert.equal(tracker.isHealthy('openai'), false);

  now += 136_000;
  assert.equal(tracker.isHealthy('openai'), true);
  assert.ok(tracker.getWeight('openai') > 0);
});
