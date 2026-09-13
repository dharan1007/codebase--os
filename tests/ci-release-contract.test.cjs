const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');

test('CI qualifies supported OS and Node release matrix', () => {
  assert.match(ci, /ubuntu-latest/);
  assert.match(ci, /windows-latest/);
  assert.match(ci, /macos-latest/);
  assert.match(ci, /node:\s*\[20,\s*22\]/);
  assert.match(ci, /npm run package:smoke/);
});
