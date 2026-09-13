const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('release website uses main repository links and accurate licensing language', () => {
  const html = fs.readFileSync('website/index.html', 'utf8');
  assert.equal(html.includes('Open source'), false);
  assert.equal(html.includes('agent/production-hardening'), false);
  assert.equal(html.includes('git clone -b'), false);
  assert.equal(html.includes('Source available'), true);
});
