# Codebase OS Production Release Design

## Goal

Promote the existing production-hardening implementation into a defensible Codebase OS v1 release without expanding scope into a generic distributed agent platform. The release must preserve Codebase OS's core invariant: a model may propose and implement changes, but the runtime owns mutation safety, verification, recovery, and completion decisions.

## Release target

Codebase OS v1 is a local, Docker-isolated, evidence-gated software-change runtime for trusted/internal repositories. It must fail closed when it cannot safely execute or independently verify a code-changing task. Enterprise-scale features such as multi-node execution, million-file guarantees, remote fleet orchestration, and distributed state are explicitly outside this release.

## Current state

The production-hardening branch already contains the major correctness repairs: dependency-first planning, transactional patch application, fail-closed verification, unified SQLite state, durable scan hashes, conflict-aware rollback, sandbox path policy, provider/model instance separation, checkpoint restoration, recurring-failure memory, and a real CI/security gate. The current hardening head has passed Node 20 CI, all current integration/regression tests, package dry-run, and production dependency audit.

The principal release blockers are that hardened code is not on main, main is not protected, several audit-only artifacts remain in the source tree, the public website contradicts the proprietary license, the website points at a development branch, cross-platform/package-install qualification is too narrow, Docker/adversarial coverage is incomplete, and deployment provenance is not tied to the eventual release SHA.

## Architecture and boundaries

The release architecture remains local-first:

Repository -> scanner/AST analyzers -> persistent typed graph -> dependency/impact planner -> provider/context layer -> transactional mutation -> Docker sandbox -> independent verification -> durable change/checkpoint/rollback state.

SQLite remains the local durability boundary for v1. The graph may still be materialized in memory and semantic retrieval may remain O(N) for this release; the product must continue to disclose those scale constraints rather than making unsupported enterprise-scale claims.

Autonomous shell execution must use Docker by default. Missing Docker must fail closed unless the operator explicitly enables reduced-isolation native execution. Repository text and model output are untrusted. Path/root containment, sensitive-file policy, transactional patching, resource limits, network defaults, independent verification, and conflict-aware rollback are authoritative safety boundaries.

## Release engineering

Release qualification is performed on an isolated release-candidate branch derived from the last green hardening SHA. The branch is cleaned and strengthened first. Only an exact candidate SHA with green CI/security/package qualification may be merged into main.

The main branch is the release authority. A later production release must be created only from a green main SHA. The Vercel website must be rebuilt from the same release/main source and must not direct users to a temporary hardening branch.

## Required changes

1. Remove audit-only self-mutating workflows and stale committed verification artifacts. Verification evidence belongs in immutable GitHub Actions runs and release artifacts.
2. Remove empty audit debris that has no product purpose.
3. Correct website language from "Open source" to accurate source-available/proprietary language and point source/clone instructions to main after merge.
4. Strengthen CI to qualify Linux and Windows on Node 20 and 22, with macOS coverage where native dependency installation is practical. Keep one canonical Linux package/publish job to avoid redundant package artifacts.
5. Add a package-install smoke test that packs the npm tarball, installs it into a clean temporary prefix, runs `cos --help`/`cos --version`-class commands, and verifies the executable entrypoint resolves from the packed artifact rather than the working tree.
6. Add adversarial regression tests around sandbox command validation and release-facing safety invariants. Tests must be deterministic and must not require untrusted network access.
7. Keep production dependency audit as a required security gate.
8. Add release documentation describing supported platforms, Docker requirement, reduced-isolation override, known scale limits, and the exact verification contract.
9. Do not claim universal correctness, million-file support, O(1) retrieval, or superiority over external coding agents without reproducible benchmark evidence.
10. After exact-head qualification, merge the release candidate, re-run main CI, and deploy the website from the merged source.

## Governance

Main must be protected so direct pushes cannot bypass the release gate. Required checks should include the canonical CI verification job and production dependency audit, plus any new package/security qualification jobs introduced by this release. If repository-administration permissions are not available to the connected GitHub application, source changes may proceed, but main cannot be represented as fully governed until the protection rule is set by an administrator.

## Testing strategy

Safety-critical regression coverage has priority over raw test count. Release tests must cover at minimum: path traversal rejection, absolute-path rejection, shell-control-character rejection, sensitive credential argument rejection, Docker-unavailable fail-closed behavior where mockable, stale patch rejection, rollback conflicts, database migration preservation, provider/model cache separation, failover termination, dependency ordering/cycle surfacing, verification fail-closed semantics, package construction, and package installation/CLI startup.

Cross-platform CI must prove the package can install its native dependencies and complete the repository verification gate on each supported OS/runtime combination. Linux remains the canonical Docker execution platform for v1 security qualification; Windows/macOS qualification proves CLI/build/runtime compatibility but does not imply equivalent native container isolation semantics.

## Deployment

The public Vercel site is a product/documentation surface, not the execution runtime. It must return 200, retain strict security headers, accurately describe the proprietary/source-available licensing model, link to main or a release tag, and avoid claiming a branch-specific state after release.

A production deployment is accepted only when its content matches the merged release source and post-deploy smoke checks pass on the production domain.

## Deferred enterprise program

After v1, the next engineering program may add optional ANN retrieval, paged/lazy graph loading, content-addressed scan segments, copy-on-write/persistent per-task sandboxes, stronger container profiles, large-monorepo benchmarks, 24/72-hour soak tests, and distributed workers. These are not release blockers for a defensible local v1 and must not delay the current hardening release.

## Acceptance criteria

The release candidate is eligible to merge only when: all source/audit cleanup is complete; legal/product copy is internally consistent; CI and security are green on the exact head; package smoke succeeds from the built tarball; no release-critical regression is open; the PR is no longer draft; and the merge target is current main.

The release is eligible to call production-ready for its stated local/internal scope only after merged-main CI is green and the production website is redeployed and smoke-tested from the merged source.
