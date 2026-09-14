# Production Assurance Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bind completion to exact workspace evidence, strengthen local durability, align isolated execution with supported runtimes, and repair provider recovery.

**Architecture:** Extend the existing local runtime without replacing its public model. Add workspace identity to verification, schema versioning and stronger SQLite durability, a mutation state journal, Node 22 isolated-execution defaults, and recoverable provider cooldown state.

**Tech Stack:** TypeScript, Node 22/24, better-sqlite3, Docker, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-14-production-assurance-design.md`

## Tasks

### 1. Workspace-bound verification
- Test: verification must reject a result when repository state changes while checks run.
- Add `WorkspaceFingerprint.capture(rootDir): string`.
- Add `VerificationReport.workspaceFingerprint`.
- Add `VerificationEngine.isReportFresh(report): boolean`.
- Re-check freshness immediately before AgentLoop accepts completion.

### 2. Durable database contract
- Test: SQLite synchronous mode is FULL.
- Test: schema migration version 1 exists.
- Add `Database.quickCheck()`.
- Initialize schema changes transactionally.

### 3. Mutation state journal
- Test: prepared/applied state survives and can be reconciled.
- Add durable states `PREPARED`, `APPLIED`, `COMMITTED`, `ROLLED_BACK`, `DIVERGED`.
- Record PREPARED before file mutation and APPLIED immediately after it.
- Reconcile incomplete rows without overwriting later developer changes.

### 4. Supported isolated runtime
- Test: default Node image uses a supported release line.
- Change the default image from Node 20 to Node 22 while preserving existing restrictions.

### 5. Provider recovery
- Test: a rate-limited provider becomes eligible after cooldown instead of remaining blocked forever.
- Transition expired circuit state to a recoverable probe state.
- A successful probe restores HEALTHY.

### 6. Qualification
- Run the existing Ubuntu/Windows/macOS Node 22/24 matrix.
- Run the existing dependency gate and packed CLI smoke.
- Promote only the exact green branch SHA and re-check the resulting main SHA.
