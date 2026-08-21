const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  patchFileTool,
  readFileTool,
  writeFileTool,
} = require('../dist/core/ai/tools/localTools.js');

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-local-tools-'));
  const init = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
  if (init.status !== 0) throw new Error(init.stderr || 'git init failed');
  return root;
}

test('patch_file applies only when current context matches', async t => {
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const target = path.join(root, 'example.ts');
  fs.writeFileSync(target, 'const a = 1;\nconst b = 2;\n', 'utf8');

  const result = await patchFileTool(
    'example.ts',
    '@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;',
    root,
  );

  assert.equal(result.success, true, result.error);
  assert.equal(fs.readFileSync(target, 'utf8'), 'const a = 1;\nconst b = 3;\n');
});

test('patch_file rejects stale context without modifying the file', async t => {
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const target = path.join(root, 'example.ts');
  const original = 'const a = 9;\nconst b = 2;\n';
  fs.writeFileSync(target, original, 'utf8');

  const result = await patchFileTool(
    'example.ts',
    '@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;',
    root,
  );

  assert.equal(result.success, false);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
});

test('read_file rejects paths outside the project root', async t => {
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await readFileTool(path.resolve(root, '..', 'outside.txt'), root);
  assert.equal(result.success, false);
  assert.match(result.error || '', /sandbox violation/i);
});

test('write_file cannot overwrite an existing file', async t => {
  const root = makeRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const target = path.join(root, 'existing.ts');
  fs.writeFileSync(target, 'original\n', 'utf8');

  const result = await writeFileTool('existing.ts', 'replacement\n', root);
  assert.equal(result.success, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'original\n');
});
