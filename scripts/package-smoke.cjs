const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-os-package-smoke-'));
const prefix = path.join(temp, 'prefix');
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let tarball;

try {
  const packOutput = execFileSync(npmBin, ['pack', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const packResult = JSON.parse(packOutput);
  if (!Array.isArray(packResult) || !packResult[0]?.filename) {
    throw new Error('npm pack did not return a tarball filename');
  }

  tarball = path.join(root, packResult[0].filename);
  execFileSync(npmBin, ['install', '--prefix', prefix, tarball, '--ignore-scripts=false'], {
    cwd: temp,
    stdio: 'inherit',
  });

  const bin = process.platform === 'win32'
    ? path.join(prefix, 'node_modules', '.bin', 'cos.cmd')
    : path.join(prefix, 'node_modules', '.bin', 'cos');

  if (!fs.existsSync(bin)) {
    throw new Error(`Packed CLI executable was not installed at ${bin}`);
  }

  execFileSync(bin, ['--help'], {
    cwd: temp,
    stdio: 'inherit',
  });
} finally {
  if (tarball) fs.rmSync(tarball, { force: true });
  fs.rmSync(temp, { recursive: true, force: true });
}
