const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const commandsDir = path.resolve(__dirname, '..', 'src', 'cli', 'commands');

function commandSources() {
  return fs.readdirSync(commandsDir)
    .filter(name => name.endsWith('.ts'))
    .map(name => ({ name, content: fs.readFileSync(path.join(commandsDir, name), 'utf8') }));
}

test('registered CLI commands do not import legacy AI mutation engines', () => {
  const violations = [];
  for (const file of commandSources()) {
    if (/SelfHealingExecutor|ChangeExecutor/.test(file.content)) violations.push(file.name);
  }
  assert.deepEqual(
    violations,
    [],
    `Legacy mutation engines bypass AgentLoop hardening in: ${violations.join(', ')}`,
  );
});

test('CLI commands do not expose a verification bypass flag', () => {
  const violations = [];
  for (const file of commandSources()) {
    if (/--no-verify/.test(file.content)) violations.push(file.name);
  }
  assert.deepEqual(
    violations,
    [],
    `Verification bypass flag found in: ${violations.join(', ')}`,
  );
});
