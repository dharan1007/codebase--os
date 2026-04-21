# Codebase OS

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Node](https://img.shields.io/badge/Node-18+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-00d4ff?style=flat-square)](LICENSE)
[![Build](https://img.shields.io/badge/Build-Passing-10b981?style=flat-square)](#)

---

> **Every AI coding agent you've used starts completely blind.**
> It reads files as it goes. It makes changes in arbitrary, random order.
> It has zero memory of what happened last session.
> It has no concept of architectural boundaries.
> It leaves you to discover the breakage.
>
> **Codebase OS is built on an entirely different premise.**

---

## The core difference

Other agents read-then-write. Codebase OS **knows before it moves.**

Before executing a single change, Codebase OS computes the full **blast radius** of a task using a persistent, SQLite-backed relationship graph of your codebase. It then topologically sorts the affected files using Kahn's algorithm — so foundational modules are always updated before the files that depend on them.

The result: no partial states. No cascading breakage. No "let me try fixing that too."

This is not a prompt engineering trick. It is structural.

---

## What it does that nothing else does

#### `cos plan "refactor auth to use JWT"` — before writing a single line

```
Codebase OS — Topological Change Plan
────────────────────────────────────────────────────────────
  Task:    refactor auth to use JWT
  Graph:   1,284 nodes, 4,891 edges

Blast Radius Analysis
  14 files across database, backend, api layers
  Complexity: HIGH

Topological Execution Plan
  (leaf dependencies first — root executors last)

  [ 1]  src/utils/crypto.ts            [backend]   hub(9 dependents)
  [ 2]  src/storage/SessionStore.ts    [database]
  [ 3]  src/core/auth/TokenManager.ts  [backend]   (ROOT)
  [ 4]  src/core/auth/Middleware.ts    [backend]   (ROOT)
  [ 5]  src/api/routes/auth.ts         [api]
  [ 6]  src/api/routes/users.ts        [api]
  ...

  Architecture Warnings
  [!] UserController (api) -> SessionStore (database)  cross-layer direct access

  No circular dependencies detected.

  To execute: cos agent "refactor auth to use JWT"
```

No other coding agent exposes this. Claude Code doesn't have a graph. Codex reads files sequentially. Cursor uses a vector index with no topological ordering. This information — in this form — exists nowhere else.

---

#### `cos chat` — a live coding session with full memory

Not a one-shot command. A persistent, multi-turn terminal REPL that retains full conversation context across every exchange. Shows colored inline diffs on every file write. Runs `/plan <task>` mid-session. Remembers everything, including what you changed in previous sessions on this project.

```
cos chat

  Codebase OS — Interactive Chat
  ────────────────────────────────────────────────────────
  Project : aphelion
  Provider: anthropic/claude-3-5-sonnet-latest
  Graph   : 1,284 nodes
  Memory  : 47 changes across 6 sessions

  Type your request. Commands: /clear  /plan <task>  /exit

you  > extract the payment processing into its own service

  [1] READ     src/core/billing/PaymentHandler.ts
         Reading current implementation before proposing changes.
         OK
  [2] READ     src/api/routes/checkout.ts
         OK
  [3] PATCH    src/core/billing/PaymentService.ts
  @@ -0,0 +1,42 @@
  +export class PaymentService {
  +  async processCharge(amount: number, currency: string) {
  ...
         OK

you  > /plan add stripe webhooks

  Blast radius: 6 files
  [1] src/core/billing/PaymentService.ts  [backend]  (ROOT)
  [2] src/core/billing/WebhookHandler.ts  [backend]
  [3] src/api/routes/webhooks.ts          [api]
  ...
```

---

#### `cos propagate` — your changes, automatically propagated

Run `cos propagate` in a terminal. Keep working in your editor. The moment you save a TypeScript interface, a database schema, or an API type — Codebase OS detects the change, computes downstream impact, calls the AI to generate surgical patches for every affected file, and asks before applying.

```
17:34:22 CHANGED  src/types/User.ts

  Blast radius: 4 downstream files detected
    - src/core/auth/TokenManager.ts  [backend]  (dependent of root)
    - src/api/routes/users.ts        [api]
    - src/storage/UserStore.ts       [database]
    - src/core/notifications/Email.ts [backend]

  Analyze these 4 files for required updates? Yes

  ANALYZING src/core/auth/TokenManager.ts ... patch generated
    +3 -1 lines
  ANALYZING src/api/routes/users.ts ... no changes needed
  ANALYZING src/storage/UserStore.ts ... patch generated
    +7 -4 lines

  Apply patch to src/core/auth/TokenManager.ts? Yes
  Patched: src/core/auth/TokenManager.ts
  Apply patch to src/storage/UserStore.ts? Yes
  Patched: src/storage/UserStore.ts
```

This is not a feature that exists in Claude Code, Codex, Cursor, or Lovable. It cannot exist in those tools architecturally — they have no persistent graph to compute downstream impact from.

---

## Persistent memory across every session

| Tool | Knows what you did last session | Knows which files break most often | Topological execution order |
|:---|:---:|:---:|:---:|
| Claude Code | No | No | No |
| Codex | No | No | No |
| Cursor | No | No | No |
| Codebase OS | **Yes** | **Yes** | **Yes** |

Every session is recorded in a local SQLite database. When you run `cos agent` or `cos chat`, the agent reads the last 5 sessions — what files were changed, what failed, what was left unfinished — before writing a single character.

---

## Full command surface

| Command | What it does |
|:---|:---|
| `cos chat` | Interactive multi-turn coding session with full project memory |
| `cos agent "<task>"` | Autonomous one-shot agent — plans, writes, verifies, self-heals |
| `cos plan "<task>"` | Compute blast radius and topological execution plan — no changes made |
| `cos propagate` | Watch your files and auto-propagate changes to downstream dependents |
| `cos scan` | Build or refresh the persistent relationship graph |
| `cos fix [file]` | Detect and fix errors with root cause analysis |
| `cos serve` | Start the live dashboard at localhost:3000 — streams real agent steps via SSE |
| `cos analyze <file>` | Full impact report for a specific file |
| `cos visualize` | Interactive browser graph visualization |
| `cos rollback <id>` | Revert any AI-applied change, precisely and atomically |
| `cos history` | View every change made across all sessions |
| `cos sync` | Detect cross-layer architectural sync issues |

---

## Setup

```bash
git clone https://github.com/dharan1007/codebase--os.git
cd codebase-os
npm install
npm run build
npm link

# In your project
cos init
cos scan
cos chat
```

Configure your AI provider in `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
# or
OPENAI_API_KEY=sk-...
# or
GEMINI_API_KEY=...
# or point to a local Ollama instance — no API key required
OLLAMA_BASE_URL=http://localhost:11434
```

---

## Under the hood

- **Relationship graph**: persistent SQLite-backed directed graph with BFS, topological sort, centrality scoring, and cycle detection
- **Execution model**: unified diff patching on existing files (not full overwrites) with path sandbox validation on every tool call
- **Schema validation**: Zod-validated agent actions — every AI response is type-checked before execution
- **Memory**: cross-session SQLite change records — hot files, recurring failure zones, session history injected into every agent prompt
- **SSE dashboard**: real-time step streaming, diff viewer, task plan tracker — all live data, no polling
- **Sliding window context**: seed message always preserved + last 10 tool exchanges — no context overflow

---

## Providers

Works with every major provider and routes by task type:

| Provider | Models | Notes |
|:---|:---|:---|
| Anthropic | claude-3-5-sonnet, claude-3-5-haiku | Recommended for reasoning tasks |
| OpenAI | gpt-4o, gpt-4o-mini, o1 | Strong for code generation |
| Google | gemini-2.0-flash, gemini-1.5-pro | Fast, high context window |
| Ollama | qwen2.5-coder, deepseek-coder, llama3 | Fully local, zero API cost |

---

## Who this is for

Engineers who have used Claude Code and thought: *"Why does it keep making changes in the wrong order?"*

Engineers who have used Cursor and thought: *"Why doesn't it know what I did yesterday?"*

Engineers working on repositories too large for a context window.

Engineers who want a coding agent that runs fully locally, with zero subscription cost, using their own hardware.

---

**Built by Dharantej Reddy Poduvu**
[dharan.poduvu@gmail.com](mailto:dharan.poduvu@gmail.com) · [GitHub](https://github.com/dharan1007)
