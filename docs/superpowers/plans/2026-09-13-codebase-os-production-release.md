# Codebase OS Production Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the green production-hardening implementation into a clean, cross-platform-qualified, package-qualified, merged and deployed Codebase OS v1 release candidate.

**Architecture:** Preserve the existing local-first scanner/graph/planner/transaction/sandbox/verification/SQLite architecture. This plan changes release hygiene, test qualification, package smoke, CI, product copy and deployment provenance; it does not introduce distributed execution or enterprise-scale graph infrastructure.

**Tech Stack:** Node.js 20/22, TypeScript 5.x, Node test runner, GitHub Actions, Docker, npm packaging, Vercel static deployment.

**Spec:** `docs/superpowers/specs/2026-09-13-codebase-os-production-release-design.md`

## Global Constraints

- v1 remains a local software-change runtime; no distributed worker/fleet architecture in this release.
- Autonomous command execution must fail closed without Docker unless `COS_ALLOW_NATIVE_SANDBOX=1` is explicitly set.
- Main/release success may only be claimed from independent CI/security/package evidence for the exact commit.
- The website and repository must describe the actual proprietary/source-available license consistently.
- Unsupported million-file/O(1)/universal-correctness/superiority claims are forbidden.
- Node 20 is the compatibility floor; Node 20 and 22 are the release qualification matrix.

---

### Task 1: Remove audit-only repository state

**Files:**
- Delete: `.github/workflows/post-remediation-verify.yml`
- Delete: `.post-remediation-verification.txt`
- Delete: `artifacts/brutal_audit.md`

**Interfaces:**
- Consumes: existing GitHub Actions CI/security workflows.
- Produces: a source tree where release evidence is external/immutable rather than self-written into commits.

- [ ] **Step 1: Verify each artifact is audit-only**

Run by inspection: confirm the workflow only writes `.post-remediation-verification.txt`, the evidence file is stale, and `artifacts/brutal_audit.md` is empty.

- [ ] **Step 2: Delete all three artifacts**

Expected tree: no self-writing verification workflow, no stale verification file, no empty audit artifact.

- [ ] **Step 3: Re-run canonical CI**

Run: `npm ci && npm run verify && npm pack --dry-run`
Expected: all commands exit 0.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove audit-only release artifacts"
```

### Task 2: Make licensing and source links truthful

**Files:**
- Modify: `website/index.html`
- Modify: `README.md` only if wording/link parity requires it.

**Interfaces:**
- Consumes: proprietary `LICENSE` and current repository URL.
- Produces: a public site that says source-available/proprietary and links users to `main` rather than a development branch.

- [ ] **Step 1: Add a copy regression test**

Create `tests/release-copy.test.cjs` with assertions equivalent to:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('website does not describe proprietary Codebase OS as open source', () => {
  const html = fs.readFileSync('website/index.html', 'utf8');
  assert.equal(/open source/i.test(html), false);
  assert.equal(html.includes('/tree/agent/production-hardening'), false);
  assert.match(html, /source available|proprietary/i);
  assert.match(html, /github\.com\/dharan1007\/codebase--os/);
});
```

- [ ] **Step 2: Run the test and confirm it fails on current copy**

Run: `node --test tests/release-copy.test.cjs`
Expected: FAIL because the website currently contains `Open source` and hardening-branch links.

- [ ] **Step 3: Update website copy and commands**

Required changes:

```text
Open source / production-hardening branch
=> Source available / proprietary license

git clone -b agent/production-hardening https://github.com/dharan1007/codebase--os.git
=> git clone https://github.com/dharan1007/codebase--os.git

https://github.com/dharan1007/codebase--os/tree/agent/production-hardening
=> https://github.com/dharan1007/codebase--os
```

- [ ] **Step 4: Run copy test and full verification**

Run: `node --test tests/release-copy.test.cjs && npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add website/index.html tests/release-copy.test.cjs README.md
git commit -m "fix: align release copy with proprietary license"
```

### Task 3: Add package-install qualification

**Files:**
- Create: `scripts/package-smoke.cjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `npm pack` tarball and `bin.cos = dist/cli/index.js`.
- Produces: `npm run package:smoke`, which proves the packed artifact installs and the CLI starts outside the working tree.

- [ ] **Step 1: Implement the package smoke script**

`scripts/package-smoke.cjs` must:

```js
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-os-package-smoke-'));
const prefix = path.join(temp, 'prefix');
try {
  const json = JSON.parse(execFileSync('npm', ['pack', '--json'], { cwd: root, encoding: 'utf8' }));
  const tarball = path.join(root, json[0].filename);
  execFileSync('npm', ['install', '--prefix', prefix, tarball], { stdio: 'inherit' });
  const bin = process.platform === 'win32'
    ? path.join(prefix, 'node_modules', '.bin', 'cos.cmd')
    : path.join(prefix, 'node_modules', '.bin', 'cos');
  execFileSync(bin, ['--help'], { cwd: temp, stdio: 'inherit' });
  fs.rmSync(tarball, { force: true });
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
```

- [ ] **Step 2: Add npm script**

Add to `package.json`:

```json
"package:smoke": "node scripts/package-smoke.cjs"
```

- [ ] **Step 3: Run package smoke locally/CI-compatible**

Run: `npm run build && npm run package:smoke`
Expected: packed tarball installs into the temp prefix and `cos --help` exits 0.

- [ ] **Step 4: Add smoke to canonical CI**

After `npm pack --dry-run`, run:

```yaml
- name: Install and smoke-test packed CLI
  run: npm run package:smoke
```

- [ ] **Step 5: Commit**

```bash
git add scripts/package-smoke.cjs package.json .github/workflows/ci.yml
git commit -m "test: qualify packed CLI installation"
```

### Task 4: Cross-platform compatibility matrix

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `npm ci`, `npm run verify`, package smoke.
- Produces: supported-OS/runtime evidence.

- [ ] **Step 1: Replace single-runner verification with matrix**

Use:

```yaml
strategy:
  fail-fast: false
  matrix:
    os: [ubuntu-latest, windows-latest, macos-latest]
    node: [20, 22]
runs-on: ${{ matrix.os }}
```

Set job name to `Verify ${{ matrix.os }} / Node ${{ matrix.node }}`.

- [ ] **Step 2: Keep deterministic install/build/test on every matrix cell**

Each matrix cell runs:

```yaml
- run: npm ci
- run: npm run verify
```

- [ ] **Step 3: Run package dry-run and package smoke on Ubuntu Node 20 only**

Gate with:

```yaml
if: matrix.os == 'ubuntu-latest' && matrix.node == 20
```

for `npm pack --dry-run` and `npm run package:smoke`.

- [ ] **Step 4: Push and inspect every matrix cell**

Expected: all supported cells green. If native dependency installation fails on one platform, fix the dependency/build issue rather than removing that platform silently.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: qualify Node 20 and 22 across supported platforms"
```

### Task 5: Expand deterministic sandbox adversarial tests

**Files:**
- Modify: `tests/security-runtime.test.cjs`
- Modify: `src/core/sandbox/SandboxManager.ts` only if a new test exposes a real defect.

**Interfaces:**
- Consumes: current command validator and fail-closed sandbox behavior.
- Produces: regression evidence for hostile command inputs without requiring live malicious execution.

- [ ] **Step 1: Add blocked-command cases through the public execution path**

Add table-driven assertions covering:

```js
[
  'node -e "process.exit(0)"; echo owned',
  'cat ../../etc/passwd',
  'cat /etc/passwd',
  'cat .env',
  'echo $(whoami)',
  'echo `whoami`',
  'echo hello && echo world',
]
```

Each must return `success === false` and an error containing `SANDBOX BLOCKED` without executing the payload.

- [ ] **Step 2: Add native fallback fail-closed test**

Temporarily clear `COS_ALLOW_NATIVE_SANDBOX` and mock/force Docker-unavailable state using the existing test seam if available. Assert execution does not run natively and returns the Docker-unavailable block message.

If no seam exists, add a minimal injectable/overridable Docker-availability method rather than invoking the host Docker daemon from the unit test.

- [ ] **Step 3: Run security tests**

Run: `node --test tests/security-runtime.test.cjs`
Expected: all cases pass.

- [ ] **Step 4: Run full verification**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/security-runtime.test.cjs src/core/sandbox/SandboxManager.ts
git commit -m "test: expand sandbox adversarial coverage"
```

### Task 6: Add release-contract tests and documentation

**Files:**
- Create: `docs/RELEASE_CONTRACT.md`
- Create or modify: `tests/release-contract.test.cjs`
- Modify: `README.md` with a short link to the release contract.

**Interfaces:**
- Produces: explicit supported scope and machine-checkable absence of forbidden marketing claims.

- [ ] **Step 1: Write release contract**

The document must state:

```text
Supported runtime: Node 20 and 22.
Primary isolation: Docker; native fallback is explicit reduced-isolation mode.
State: local SQLite under .cos.
Verification: successful completion after code mutation requires independently discovered executable gates.
Known scale constraint: graph is materialized in memory and vector shortlist is not an ANN index.
No claims: universal correctness, million-file guarantee, O(1) semantic search, or benchmark superiority without published evidence.
```

- [ ] **Step 2: Add regression assertions**

Test README + website for forbidden phrases such as `100x better`, `unlimited API keys`, `million-file guarantee`, and `O(1) vector` unless they occur in a negated/non-claim context. Prefer exact current known-bad legacy phrases rather than a broad natural-language censor.

- [ ] **Step 3: Run tests and full verification**

Run: `node --test tests/release-contract.test.cjs && npm run verify`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/RELEASE_CONTRACT.md tests/release-contract.test.cjs README.md
git commit -m "docs: define Codebase OS v1 release contract"
```

### Task 7: Final release-candidate qualification

**Files:**
- No feature changes unless qualification exposes a defect.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: exact green release-candidate SHA.

- [ ] **Step 1: Run exact local-compatible gate**

```bash
npm ci
npm run verify
npm audit --omit=dev --audit-level=high
npm pack --dry-run
npm run package:smoke
```

Expected: every command exits 0.

- [ ] **Step 2: Push release-candidate head and wait for GitHub Actions**

Expected: all matrix CI cells and Security workflow green for the exact head SHA.

- [ ] **Step 3: Confirm PR diff contains no audit debris or active credentials**

Inspect changed filenames and package payload. Expected: no `.env`, `.cos` database, credential files, generated tarballs, or audit-only self-writing workflow.

- [ ] **Step 4: Commit any qualification-only corrections as separate commits and repeat Steps 1-3**

No release proceeds on a red or unqualified SHA.

### Task 8: Merge hardened release candidate into main

**Files:**
- Git history/PR metadata only.

**Interfaces:**
- Consumes: exact green release-candidate SHA.
- Produces: main containing hardened release source.

- [ ] **Step 1: Open/update release PR from `agent/production-hardening-final` to `main`**

PR body must enumerate release scope, tests, security gate, known limitations and exact candidate SHA.

- [ ] **Step 2: Confirm mergeability and exact-head CI**

Expected: mergeable, non-draft, green exact head.

- [ ] **Step 3: Squash merge**

Use a production-focused title such as:

```text
release: harden Codebase OS verification, sandbox and packaging
```

- [ ] **Step 4: Run/inspect main CI on the resulting main SHA**

Expected: green main qualification before any production-ready claim.

### Task 9: Main-branch governance

**Files:**
- Repository settings, not source files.

**Interfaces:**
- Produces: no direct bypass of release gates.

- [ ] **Step 1: Configure main protection/ruleset if API permissions allow**

Require pull requests and successful CI/Security checks; prevent direct bypass pushes for normal development.

- [ ] **Step 2: If connected GitHub permissions do not expose administration writes, record this as the only external admin action remaining**

Do not falsely claim branch governance is active until GitHub reports it.

### Task 10: Deploy and verify production website

**Files:**
- Vercel deployment generated from merged repository source.

**Interfaces:**
- Consumes: merged main/release source.
- Produces: `codebase-os.vercel.app` matching the merged release copy.

- [ ] **Step 1: Deploy merged release website**

Use the `codebase-os` Vercel project and its existing `vercel.json` build (`node scripts/build-site.cjs`, output `.vercel-site`).

- [ ] **Step 2: Fetch production URL**

Expected HTTP 200.

- [ ] **Step 3: Verify content**

Production HTML must contain source-available/proprietary wording and no `agent/production-hardening` link or `Open source` release claim.

- [ ] **Step 4: Verify headers**

Confirm CSP, HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, restrictive Permissions-Policy, and strict referrer policy remain present.

- [ ] **Step 5: Verify source link and clone command**

All public instructions must resolve to the merged repository/release rather than a development branch.

---

## Self-review

Spec coverage: release hygiene, licensing, package smoke, cross-platform CI, sandbox regression coverage, explicit release scope, merge qualification, governance and Vercel deployment are each mapped to tasks above.

Placeholder scan: no TBD/TODO/implement-later placeholders are present.

Interface consistency: all tasks preserve the existing `cos` CLI package entrypoint, Docker-default sandbox policy, GitHub Actions release authority, and Vercel static-site build contract.
