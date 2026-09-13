# Codebase OS — Release Procedure

Publishing is the final step of a verified release, not the verification step itself. Do not publish from a dirty working tree or from a commit whose GitHub Actions CI is red/pending.

## Release prerequisites

Before tagging or publishing a version:

1. The intended release commit is on a reviewed branch/PR.
2. GitHub Actions CI is green for the exact commit.
3. `npm run verify` succeeds from a clean checkout.
4. `npm pack --dry-run` contains only the intended package files.
5. README, SECURITY, LICENSE and `.env.example` match the implementation.
6. No active credentials or local `.cos` state are present in the package/repository diff.
7. Any compatibility/model-default change has been checked against provider documentation or live model discovery.
8. The version/changelog accurately describes breaking behavior.

## Local release verification

Use a clean clone or clean worktree:

```bash
npm ci
npm run verify
npm pack --dry-run
```

`npm run verify` executes typecheck, production build and the integration/regression tests. `prepublishOnly` invokes the same verification gate automatically, but that is a backstop rather than a replacement for reviewing the result.

## Package inspection

`package.json` restricts the package payload to the compiled distribution and release documentation. Still inspect the dry-run output before every release:

```bash
npm pack --dry-run
```

Reject the release if the payload contains development state, source credentials, `.env`, `.cos`, repository metadata, test fixtures containing secrets, or unexpected generated files.

## Versioning

Update the package version intentionally according to compatibility impact. Do not change versions merely to force a publish.

Example:

```bash
npm version patch   # compatible fixes
npm version minor   # backward-compatible capability
npm version major   # breaking CLI/storage/behavior contract
```

Review the generated version commit/tag before pushing it.

## npm publication

Authenticate using an npm account with MFA/appropriate publishing policy:

```bash
npm login
npm whoami
npm publish
```

If the unscoped package name is unavailable, choose and document a stable package scope rather than repeatedly renaming published artifacts.

The repository license is proprietary. Publishing to npm does not change the license or grant rights beyond `LICENSE`.

## Git tag / GitHub release

Create a release only for the commit that passed CI and package inspection. Release notes should include:

- user-visible changes;
- breaking changes/migrations;
- security changes;
- supported Node/Docker requirements;
- known limitations;
- verification evidence/CI commit.

## Rollback of a bad release

Do not silently overwrite an npm version. If a release is faulty:

1. stop promoting the affected version;
2. document the impact;
3. fix on a branch;
4. run the complete verification gate;
5. publish a new version;
6. deprecate the faulty npm version if appropriate.

## Branch protection recommendation

For `main`, require the CI workflow and review before merge when Codebase OS is being used as a production tool. Avoid direct pushes that bypass the same gate used for releases.
