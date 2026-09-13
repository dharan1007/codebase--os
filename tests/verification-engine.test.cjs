const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VerificationEngine } = require('../dist/core/verification/VerificationEngine.js');

function tempProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-verification-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeGraph() {
  return {};
}

test('discovers repository gates and requires all of them to pass', async t => {
  const root = tempProject(t);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'tsc --noEmit',
      test: 'node --test',
      build: 'tsc',
    },
  }), 'utf8');
  fs.writeFileSync(path.join(root, 'index.ts'), 'export const answer: number = 42;\n', 'utf8');

  const seen = [];
  const sandbox = {
    execute: async command => {
      seen.push(command);
      return { success: true, output: `passed ${command}`, exitCode: 0 };
    },
  };

  const engine = new VerificationEngine(root, fakeGraph(), sandbox);
  const report = await engine.verify(['index.ts']);

  assert.equal(report.success, true);
  assert.deepEqual(seen, ['npm run typecheck', 'npm test', 'npm run build']);
  assert.deepEqual(report.commands, seen);
});

test('fails closed when a discovered gate fails', async t => {
  const root = tempProject(t);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: { test: 'node --test', build: 'tsc' },
  }), 'utf8');
  fs.writeFileSync(path.join(root, 'index.ts'), 'export const ok = true;\n', 'utf8');

  const seen = [];
  const sandbox = {
    execute: async command => {
      seen.push(command);
      if (command === 'npm test') return { success: false, output: '', error: 'test failed', exitCode: 1 };
      return { success: true, output: 'ok', exitCode: 0 };
    },
  };

  const report = await new VerificationEngine(root, fakeGraph(), sandbox).verify(['index.ts']);
  assert.equal(report.success, false);
  assert.deepEqual(seen, ['npm test']);
  assert.match(report.summary, /failed/i);
});

test('fails closed when code changed but no executable verification strategy exists', async t => {
  const root = tempProject(t);
  fs.writeFileSync(path.join(root, 'note.txt'), 'changed\n', 'utf8');
  const sandbox = { execute: async () => ({ success: true, output: '', exitCode: 0 }) };

  const report = await new VerificationEngine(root, fakeGraph(), sandbox).verify(['note.txt']);
  assert.equal(report.success, false);
  assert.ok(report.checks.some(check => check.name === 'verification-strategy' && !check.success));
});
