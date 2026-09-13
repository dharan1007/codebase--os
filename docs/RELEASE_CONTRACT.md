# Codebase OS v1 Release Contract

Codebase OS v1 is a local, evidence-gated software-change runtime for AI-assisted engineering. This document defines the scope that a v1 production-ready claim covers and, equally importantly, the claims it does not cover.

## Supported runtime

- Node 20 and 22 are the supported Node.js release lines for v1.
- Git is required.
- Docker is the primary isolation boundary for autonomous repository command execution.
- Windows, macOS and Linux CLI/build compatibility are qualified in CI. Docker-based isolation is the authoritative autonomous execution model; platform compatibility does not imply identical host/container behavior on every operating system.

## Execution and isolation

Repository build, test and package scripts are arbitrary code. Codebase OS therefore runs autonomous shell work in Docker by default with a disposable writable workspace, read-only source mount/container root, resource limits, dropped Linux capabilities, `no-new-privileges`, credential-aware masking and network-off defaults for normal verification commands.

If Docker is unavailable, native execution is blocked by default. `COS_ALLOW_NATIVE_SANDBOX=1` is an explicit reduced-isolation override and must not be treated as equivalent to the Docker boundary or used for untrusted repositories.

## State and durability

Project state is local and stored under `.cos`, with the durable database at `.cos/cos.db`. SQLite stores graph state, file-analysis hashes, change transactions, checkpoints, failure snapshots, caches and other engineering evidence used by the runtime.

Rollback is conflict-aware: Codebase OS refuses to overwrite later developer or automation changes when the current filesystem no longer matches the recorded post-change state.

## Verification contract

A model may propose a change and request completion, but the model does not certify its own mutation. After a code-changing operation, successful completion requires independent verification using executable gates discovered from the repository. When code changed and no supported credible verification strategy can be discovered, completion fails closed.

A green verification result proves only the checks that actually ran. It is evidence that the configured/discovered gates passed; it is not a mathematical proof of correctness, security or completeness.

## Repository intelligence and scale

Codebase OS combines lexical retrieval, typed graph context and optional semantic embeddings. The current local semantic shortlist is not an ANN index. Large-corpus vector retrieval may perform an O(N) scan over compact sketches before exact re-ranking of selected candidates.

The persistent relationship graph is still materialized in process memory for active analysis. v1 therefore does not guarantee that a one-million-file repository, or any arbitrary repository size, will fit within a given machine's memory or latency budget.

## Provider contract

Provider families supported by the runtime include OpenAI, Anthropic, Gemini, OpenRouter and Ollama. Exact model availability, account entitlement, quotas and provider behavior are external dependencies and can change independently of Codebase OS. Provider defaults are compatibility defaults, not benchmark-superiority claims.

## Security boundary

Repository text, source comments, generated files, dependencies, build scripts and model responses are treated as potentially untrusted inputs. Important safety boundaries include project-root/realpath containment, sensitive-path policy, context-validated transactional mutation, Docker isolation, bounded command execution, independent verification and conflict-aware rollback.

Pattern-based prompt-injection scrubbing and secret detection are defense-in-depth measures, not completeness guarantees.

## Explicit non-claims

Codebase OS v1 does not claim:

- universal correctness or zero-defect autonomous coding;
- a guaranteed million-file operating envelope;
- O(1) semantic/vector search;
- equivalent diagnostic/build depth for every programming language;
- that static dependency connectivity alone proves causal impact;
- perfect memory of every prior conversation token;
- superiority over external coding agents without reproducible controlled benchmark evidence;
- multi-node, fleet-scale or distributed durable execution.

Those capabilities may be evaluated or engineered in later enterprise-scale work, but they are outside the v1 production contract.

## Release evidence

A release is eligible for production use within this stated scope only when the exact release/main commit passes the repository CI matrix, the production dependency security audit, package construction and packed-CLI installation smoke qualification. Public website/deployment copy must describe this scope and the proprietary/source-available licensing model accurately.
