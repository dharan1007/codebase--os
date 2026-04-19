# Codebase OS — Sovereign Edition Manual

Welcome to the **Sovereign Edition** of Codebase OS. This is not just a tool; it is an autonomous engineering unit designed to understand your project as a coherent system, learn from failures, and enforce premium design standards.

---

## 🏗️ 1. The Sovereign Philosophy

Codebase OS operates on the principle of **Informed Engineering**. Unlike standard LLM assistants that generate isolated snippets, Codebase OS:
- **Builds a Topological Map**: Every file and function is a node in a relationship graph.
- **Analyzes Impact**: Before any change, it traces dependencies to predict regressions.
- **Self-Regulates**: It monitors its own failures and costs to maximize resource usage.

---

## 🚀 2. Getting Started

### Prerequisites
- **Node.js**: >= 18.0.0
- **TypeScript**: Latest (for type-safe engineering)
- **Local AI (Recommended)**: [Ollama](https://ollama.ai/) for cost-free `simple` tasks.

### Installation
```bash
git clone https://github.com/dharan1007/codebase--os.git
npm install
npm run build
npm link
```

### Initializing a Project
Navigate to your target codebase and run:
```bash
cos init     # Setup project config
cos scan     # Build the initial relationship graph
cos config   # Set your AI keys (OpenAI, Anthropic, Gemini, OpenRouter)
```

---

## 🤖 3. Core Execution Modes

### `cos agent "<task>"`
This is the primary Sovereign mode. The agent autonomously deconstructs the task into steps, discovers the architecture, and executes the changes.
- **Visual Dashboard**: Starts automatically at `http://localhost:3000`.
- **Safety Gates**: All high-impact changes (Write/Delete/Shell) are staged for your approval in the dashboard.

### `cos fix [file]`
Optimized for debugging. It evaluates diagnostics (Lints/Tests) and applies systemic fixes.
- **Root Cause Mode**: If a fix fails, the system scans Git history and dependency topology to find the true source of the issue.

---

## 🧠 4. Intelligence Layers

### Failure Intelligence
Codebase OS tracks the frequency and context of every error. 
> [!IMPORTANT]
> **Root Cause Analyzer**: When a threshold is met, the system stops patching and starts investigating. It generates multiple hypotheses, validates them in a sandbox, and applies the most stable solution.

### Design Intelligence
The system enforces a high-end design language automatically.
- **Style Engine**: Managed via `src/core/design/StyleEngine.ts`.
- **Design Critic**: Every UI change is audited by a secondary AI pass to ensure spacing consistency (8px grid) and accessibility.

### Resource Optimization
Your usage is governed by the **Resource Monitor**:
- **Budgets**: Set dollar caps per task to avoid runaway costs.
- **Rate Limits**: The system implements "Leaky Bucket" throttlers for every provider to avoid 429 errors.

---

## 🖥️ 5. The Sovereign Dashboard

The Visual Dashboard is your command center for transparency:
- **Reasoning Panel**: Real-time stream of what the agent is currently thinking.
- **Diff Viewer**: Side-by-side verification of code changes before application.
- **Telemetry**: Live tracking of token costs and recurring failure alerts.

---

## 🛡️ 6. Principal Engineering Standards

Codebase OS maintains a strict "Zero Regression" policy:
1. **Impact Validation**: No change is applied without scanning reverse-dependencies.
2. **Build Integrity**: Every turn includes a `tsc` check to prevent syntax drift.
3. **Regression Guard**: Automatic test generation for every resolved root-cause failure.

---

**Codebase OS — Software is a system. Treat it like one.**
