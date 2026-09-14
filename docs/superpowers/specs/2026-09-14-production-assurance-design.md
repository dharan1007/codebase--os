# Codebase OS Production Assurance Design

## Goal

Evolve Codebase OS into an evidence-bound engineering runtime. A capability is called complete only when its published acceptance gates pass on the exact release commit.

## Core architecture

The local assurance kernel owns repository identity, change authorization, transactional mutation, independent verification, rollback, isolated execution, provider scheduling, durable jobs and evidence. AI models only propose actions; the runtime decides whether work is accepted.

A successful mutation progresses through durable states `PREPARED -> APPLIED -> VERIFIED -> COMMITTED`. Failure states are `ROLLBACK_REQUIRED`, `ROLLED_BACK`, and `DIVERGED`. Each transition binds the transaction to affected paths, pre/post hashes, workspace identity, verification identity and timestamps.

Verification is valid only for the exact workspace state that was checked. Any repository mutation after verification invalidates completion. Final success therefore re-checks the workspace identity before returning.

Critical SQLite state uses WAL plus full durability, a versioned migration ledger, startup integrity validation, explicit transaction boundaries, and recovery of incomplete mutation-journal rows.

Docker remains the authoritative boundary for untrusted repository commands. The default runtime uses a supported Node release line. Resource limits, read-only source, disposable workspace, no-new-privileges, dropped capabilities, bounded output/time and network-off verification defaults remain mandatory.

Provider scheduling becomes provider+model aware with recoverable circuit breakers, clear error classes, deadlines, bounded retries, cancellation, half-open recovery probes and measurable outcomes.

Repository scale work moves graph access toward lazy/paged reads and semantic retrieval behind an indexed backend interface. Published scale claims require reproducible benchmark evidence for explicit repository tiers.

Long-running work becomes a durable job state machine with idempotent steps, restart-safe checkpoints and explicit terminal states. Operational evidence includes structured events, health/readiness, provider outcomes, verification outcomes, recovery events and resource usage.

## Later control plane

The optional enterprise control plane manages organizations, workspaces, policies, jobs, workers, quotas and audit records while preserving the local kernel as the safety authority. Control-plane services may schedule the kernel but cannot bypass its completion rules.

## Competitive direction

Parallel agents operate in isolated workspaces. A dependency/conflict graph allocates work and a merge planner combines compatible changes before independent verification. Competitive claims against Codex or Claude Code require controlled head-to-head evaluation on identical repositories and tasks using task success, regression rate, false-success rate, human intervention, recovery, cost, latency, conflict rate, outage survival and containment metrics.

## Delivery order

1. workspace-bound verification and final freshness re-check;
2. versioned database schema and stronger durability;
3. durable mutation journal and recovery;
4. supported sandbox defaults and containment qualification;
5. provider circuit recovery and error taxonomy;
6. indexed retrieval and scale benchmarks;
7. durable jobs and operational telemetry;
8. enterprise control plane;
9. dependency-aware multi-agent workspaces and competitive benchmarks.

## Invariants

- Models never certify their own mutations.
- Stale verification cannot authorize completion.
- A failed durable write cannot be reported as a successful mutation.
- Recovery never overwrites concurrent developer work silently.
- Untrusted project commands remain isolated by default.
- Provider failure cannot silently weaken verification or safety policy.
- Scale, reliability and competitive claims require reproducible release evidence.
