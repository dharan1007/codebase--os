const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const website = fs.readFileSync(path.join(root, 'website', 'index.html'), 'utf8');

test('v1 release contract is documented and linked from the README', () => {
  const contractPath = path.join(root, 'docs', 'RELEASE_CONTRACT.md');
  assert.equal(fs.existsSync(contractPath), true);
  const contract = fs.readFileSync(contractPath, 'utf8');
  assert.match(contract, /Node(?:\.js)? 20.*22|Node 20 and 22/i);
  assert.match(contract, /Docker/i);
  assert.match(contract, /SQLite/i);
  assert.match(contract, /independent verification/i);
  assert.match(contract, /not an ANN index|ANN/i);
  assert.match(readme, /RELEASE_CONTRACT\.md/);
});

test('release-facing copy does not repeat legacy unsupported superiority claims', () => {
  const publicCopy = `${readme}\n${website}`.toLowerCase();
  for (const phrase of [
    'unlimited api keys',
    '100x better',
    'replaces your claude code',
    'replaces ur claude code',
    'guaranteed million-file',
  ]) {
    assert.equal(publicCopy.includes(phrase), false, `unsupported release claim found: ${phrase}`);
  }
});
