const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'src', 'ui');
const destination = path.join(root, 'dist', 'ui');

if (!fs.existsSync(source)) {
  console.error(`UI source directory not found: ${source}`);
  process.exit(1);
}

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
fs.cpSync(source, destination, { recursive: true });

if (!fs.existsSync(path.join(destination, 'index.html'))) {
  console.error('UI packaging failed: dist/ui/index.html was not produced.');
  process.exit(1);
}

console.log(`Copied UI assets: ${path.relative(root, source)} -> ${path.relative(root, destination)}`);
