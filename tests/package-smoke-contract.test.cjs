const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();

test('release package exposes an explicit packed-artifact smoke command', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts?.['package:smoke'], 'node scripts/package-smoke.cjs');
  assert.equal(fs.existsSync(path.join(root, 'scripts', 'package-smoke.cjs')), true);
});
