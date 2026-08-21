const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'website');
const output = path.join(root, '.vercel-site');

if (!fs.existsSync(source)) {
  throw new Error(`Website source directory is missing: ${source}`);
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
  const from = path.join(source, entry.name);
  const to = path.join(output, entry.name);
  fs.cpSync(from, to, { recursive: true, force: true });
}

const required = ['index.html', 'styles.css', 'app.js', 'favicon.svg'];
for (const file of required) {
  const target = path.join(output, file);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new Error(`Static site build is missing required output: ${file}`);
  }
}

const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
for (const asset of ['/styles.css', '/app.js', '/favicon.svg']) {
  if (!html.includes(asset)) {
    throw new Error(`index.html does not reference required asset: ${asset}`);
  }
}

console.log(`Codebase OS site built to ${path.relative(root, output)} (${required.length} required assets verified).`);
