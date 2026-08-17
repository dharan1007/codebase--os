# Codebase OS

[![CI](https://github.com/dharan1007/codebase--os/actions/workflows/ci.yml/badge.svg)](https://github.com/dharan1007/codebase--os/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Node](https://img.shields.io/badge/Node-20%2B-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-Proprietary-6b7280?style=flat-square)](LICENSE)

**Codebase OS is a local software-change runtime for AI-assisted engineering.** It combines repository scanning, a persistent typed relationship graph, dependency-first planning, transactional file mutation, durable engineering memory, isolated command execution, independent verification, and conflict-safe rollback.

The core design rule is simple:

> A model may propose and implement a change. The runtime—not the model—decides whether observable evidence is sufficient to call the task complete.

## Production contract

Codebase OS intentionally distinguishes three states that AI tools often collapse together:

1. **Generated** — a model produced code or a patch.
2. **Applied** — the runtime safely mutated the working tree and recorded the transaction.
3. **Verified** — independently discovered project gates passed after the latest mutation.

`cos agent` and `cos chat` do not report verified completion after code changes unless the verification kernel succeeds. Reaching a step limit, a provider quota, a failed build/test, an unavailable sandbox, or an unknown verification strategy leaves the task incomplete instead of manufacturing success.

## Architecture

```text
Repository
   │
   ├── scanner / AST analyzers
   │       ↓
   ├── persistent SQLite graph + file analysis
   │       ↓
   ├── typed dependency / impact planning
   │       ↓
   ├── model provider + context retrieval
   │       ↓
   ├── transactional file tools
   │       ↓
   ├── isolated command sandbox
   │       ↓
   ├── independent verification kernel
   │       ↓
   └── durable history / checkpoint / rollback
```

### Repository intelligence

`cos scan` streams repository discovery in bounded file windows and persists per-file hashes. Incremental scans skip unchanged analysis, prune deleted files, rebuild symbol nodes for changed files, refresh import/call relationships, and optionally create code-body embeddings.

The relationship graph currently models source-level entities and typed relationships such as imports, calls, inheritance, implementation, type use, database use, API use, references, rendering, containment and tests. Planning uses only relationships that represent dependency semantics; containment and test-evidence edges are deliberately excluded from topological scheduling.

### Dependency-first planning

Graph convention is `consumer -> dependency`. Before Kahn topological sorting, Codebase OS converts the affected file graph to the scheduling direction `dependency -> consumer`. This makes dependencies precede consumers in acyclic affected subgraphs. Cycles are surfaced explicitly because a cyclic dependency graph has no valid total topological order.

`cos plan` is analysis, not an execution guarantee. The autonomous runtime receives the plan as evidence and may re-plan when new repository/runtime information contradicts it.

### Transactional mutations

Existing files are modified through a single-file unified diff. The runtime:

- controls the target path itself rather than trusting patch file headers;
- performs `git apply --check` before any write;
- rejects stale context;
- checks the file hash again between preflight and apply;
- prevents project-root and symlink path escapes;
- forbids `write_file` from silently overwriting an existing file.

Create, modify, delete and file-move operations are recorded separately in SQLite so rollback can invert the correct operation.

### Conflict-safe rollback

Rollback is optimistic-concurrency protected. Codebase OS first verifies that the current filesystem still equals the recorded post-change state. If a developer or later agent has changed the file, rollback stops with a conflict instead of overwriting newer work.

Session rollback runs newest transaction first and stops at the first conflict.

### Independent verification

After the latest mutation, a model can request `finish`, but it cannot certify itself. The verification kernel discovers applicable gates from the repository and runs them independently.

Supported discovery currently includes:

- Node package scripts: `typecheck`, `check`, `lint`, `test`, `build`;
- Python/pytest projects;
- Go modules;
- Rust/Cargo projects;
- Maven and Gradle projects;
- .NET solutions/projects;
- Dart/Flutter projects with a configured compatible sandbox image;
- direct JavaScript/TypeScript and JSON parse validation for changed files.

If code changed and no credible verification strategy can be discovered, completion fails closed.

## Command surface

| Command | Purpose |
|---|---|
| `cos init` | Initialize Codebase OS state for a repository |
| `cos scan` | Incrementally refresh persistent repository intelligence |
| `cos scan --force` | Force full analysis rather than hash-based skipping |
| `cos plan "<task>"` | Inspect typed blast radius and dependency-first ordering without changes |
| `cos agent "<task>"` | Run the transactional, evidence-gated autonomous agent |
| `cos chat` | Interactive session using the same hardened AgentLoop as `cos agent` |
| `cos propagate` | Watch changes and propose downstream compatibility patches |
| `cos propagate --auto` | Auto-apply candidates, retaining them only when independent verification passes |
| `cos propagate --dry-run` | Show propagation proposals without mutation |
| `cos fix [file]` | Run diagnostics and targeted repair workflow |
| `cos continue` | Resume the latest durable incomplete checkpoint |
| `cos history` | Inspect recorded Codebase OS transactions |
| `cos rollback [id]` | Conflict-safe rollback of a recorded transaction |
| `cos analyze <file>` | Inspect impact for a file |
| `cos sync` | Inspect cross-layer synchronization issues |
| `cos visualize` | Visualize the relationship graph |
| `cos serve` | Run the local dashboard |

## Installation

Prerequisites:

- Node.js 20 or newer
- Git
- Docker for isolated autonomous command execution

```bash
npm ci
npm run verify
npm link
```

Then in the repository you want Codebase OS to operate on:

```bash
cos init
cos scan
cos plan "describe the change"
cos agent "describe the change"
```

### Why Docker is required by default

Repository build/test scripts are arbitrary code. If Docker is unavailable, Codebase OS refuses native shell execution by default. Native execution is an explicit reduced-isolation opt-in:

```bash
COS_ALLOW_NATIVE_SANDBOX=1 cos agent "..."
```

Do not enable that mode for untrusted repositories.

## Sandbox security model

When Docker is available, command execution uses a disposable workspace rather than writing through the mounted source tree. The sandbox currently provides:

- read-only source bind mount;
- disposable writable workspace;
- read-only container root filesystem;
- network disabled unless the requested command is a recognized install/fetch operation;
- CPU, memory, PID, output-size and wall-time limits;
- dropped Linux capabilities and `no-new-privileges`;
- `.git` and `.cos` masking;
- credential-shaped file masking (`.env`, registry credentials, PEM/key files, service-account/credential JSON patterns);
- no inherited application credentials by default;
- explicit environment forwarding only through `COS_SANDBOX_ENV_ALLOW`;
- language-specific container images for supported verification commands.

The sandbox is a defense layer, not a proof that arbitrary build dependencies are benign. Network-enabled package installation still executes third-party package lifecycle code inside the isolated container.

## Provider configuration

Supported provider families are OpenAI, Anthropic, Gemini, OpenRouter and Ollama. Provider instances are cached per credential **and model**, preventing a request for one model from accidentally reusing an instance configured for another.

Codebase OS uses semantic roles (`reasoning-high`, `reasoning-fast`, `analysis-fast`, `design-premium`, `embedding-small`) rather than treating a permanent hard-coded model leaderboard as truth. Exact IDs can be pinned without changing source code, for example:

```bash
COS_OPENAI_REASONING_HIGH_MODEL=...
COS_ANTHROPIC_REASONING_HIGH_MODEL=...
COS_GEMINI_ANALYSIS_FAST_MODEL=...
OPENAI_EMBEDDING_MODEL=...
GEMINI_EMBEDDING_MODEL=...
```

Provider defaults are compatibility defaults, not benchmark claims. Model availability, account entitlements and provider limits can change independently of Codebase OS.

## Retrieval

Semantic retrieval is hybrid: code-body embeddings are combined with keyword retrieval and typed graph context. The current local vector implementation is **not an ANN index** and does not claim O(1) lookup. For larger corpora it performs an O(N) scan over compact deterministic sketches and loads full vectors only for the best candidates before exact cosine re-ranking.

This keeps full-vector memory bounded relative to corpus size, but it is not a substitute for HNSW/DiskANN-class infrastructure at very large enterprise scale.

## Persistent engineering memory

Durable state lives in `.cos/cos.db` and includes:

- graph nodes and edges;
- file analyses/hashes;
- change transactions;
- impact/synchronization reports;
- failure snapshots;
- checkpoints;
- response cache;
- embedding cache;
- cognitive summaries/facts.

Project memory is based on recorded engineering evidence such as changed files and recurring failure snapshots. It is not advertised as perfect recollection of every previous chat token.

## Propagation safety

`cos propagate` does not use a stale pre-save graph. Before impact planning it re-scans the changed dependency. It then analyzes only downstream dependents, applies candidate patches through the transactional patch tool, re-scans changed targets, and runs independent project verification.

If verification fails, the propagation batch is reverted when the files still match the generated post-change state. Conflicts are surfaced instead of overwriting newer work.

## Local dashboard

The dashboard binds only to `127.0.0.1`, applies browser security headers, constrains static file serving to the UI root, rejects non-local/cross-origin approval mutations, and falls back to an available loopback port if the preferred port is busy.

## CI and release gate

The repository CI runs on Node 20 and requires:

```text
npm ci
npm run typecheck
npm run build
npm test
npm pack --dry-run
```

`npm run verify` combines typecheck, build and tests, and `prepublishOnly` executes the same verification gate.

A green badge means the actual GitHub Actions workflow succeeded for that ref. This README deliberately does not use a static “passing” badge.

## Current scope and non-claims

Codebase OS is designed to be a trustworthy software-change runtime, but the following are **not** claimed by the current implementation:

- no claim of being “100× better” than another coding agent without controlled benchmark evidence;
- no guarantee that a one-million-file repository fits in Node memory—the persistent graph is still materialized in memory;
- no O(1) vector-search claim;
- no claim that LLM-generated summaries are lossless memory;
- no claim that static dependency connectivity alone proves causal impact;
- no claim that every programming language has equivalent diagnostic/build coverage;
- no claim that AI propagation is correct unless the independent verification evidence succeeds.

These are engineering constraints, not marketing footnotes. Future scale/accuracy claims should be attached to reproducible benchmark artifacts.

## Development

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run verify
```

Tests currently include regression coverage for dependency-first planning and context-validated transactional patches. Production changes should add regression tests for every repaired failure mode rather than relying on prompt behavior.

## License

This repository is distributed under the proprietary terms in [LICENSE](LICENSE). The license permits personal/internal business use and restricts modification/redistribution without permission. Do not rely on older references that described this repository as MIT licensed.

## Security

See [SECURITY.md](SECURITY.md) for reporting guidance and the supported security boundary.

---

Built by Dharantej Reddy Poduvu.
