const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { LocalServer } = require('../dist/core/server/LocalServer.js');

test('LocalServer serves API locally and blocks cross-origin mutation/path traversal', async t => {
  const dashboard = new LocalServer();
  // TypeScript private fields remain ordinary JS properties after compilation;
  // force an ephemeral port so the test cannot collide with a developer service.
  dashboard.port = 0;
  dashboard.start();
  await once(dashboard.server, 'listening');
  t.after(() => dashboard.stop());

  const address = dashboard.server.address();
  assert.equal(typeof address, 'object');
  const port = address.port;
  const base = `http://127.0.0.1:${port}`;

  const stats = await fetch(`${base}/api/stats`);
  assert.equal(stats.status, 200);
  assert.equal(stats.headers.get('x-frame-options'), 'DENY');
  assert.equal(stats.headers.get('x-content-type-options'), 'nosniff');
  assert.match(stats.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);

  const crossOriginMutation = await fetch(`${base}/api/approve`, {
    method: 'POST',
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(crossOriginMutation.status, 403);

  const traversal = await fetch(`${base}/%2e%2e/%2e%2e/package.json`);
  assert.equal(traversal.status, 403);
});
