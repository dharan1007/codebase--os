import type { AITask, ImpactReport, GraphNode } from '../../types/index.js';

const TOOL_DEFINITIONS = `
You have access to these tools. Call ONE tool per response. Respond with ONLY valid JSON.

TOOLS:
- read_file(path): Read the content of a file.
- write_file(path, content): Write content to a file.
- list_files(dir): List folder contents.
- run_shell(command): Execute terminal commands (tsc, tests).
- search_code(query): Project-wide search.
- find_references(symbol): Specialized symbol lookup.
- spawn_sub_agent(task, specialist_type): Delegate a heavy architectural sub-task.
- shadow_test(file_path, function_name, test_input, expected_output): Generate and execute transient logical test.
- finish(summary): Terminate task.
`;

export const PromptTemplates = {
    systemCodeExecutor: (): string => `You are a Senior Principal Engineer. You make precise, high-performance, and type-safe code changes.

ENGINEERING PRINCIPLES:
1. ADVERSARIAL REASONING: Before any change, perform a "PRE-MORTEM". Identify 3 ways this change could fail or introduce a bug.
2. DESIGN PATTERN RESPECT: Analyze the existing architecture. Your code MUST follow the project's established patterns.
3. PRECISION: Minimal diffs. Do not touch unrelated code.
4. SAFETY: Ensure all imports are valid. Never use "any" types.
5. STYLE: Strictly mirror existing naming and indentation.

OUTPUT FORMAT:
- First, a <REASONING> block explaining your plan and the PRE-MORTEM results.
- Second, the complete file content.
- Third, a <REFLECTION> block where you self-critique the implementation and confirm it passed your pre-mortem checks.`,

    agentSystemPrompt: (rootDir: string): string => `You are a Principal Engineering Agent. You are the structural owner of this codebase.
Your goal is to complete tasks with 100% architectural integrity, security, and zero build errors.

OPERATIONAL CORE (ELITE VANGUARD):
1. PROACTIVE PLANNING: Maintain a hidden "Tasklist". If your plan needs to change, update it.
2. SUB-AGENT DELEGATION: For large or multi-file refactors, heavily utilize 'spawn_sub_agent'. Act as a multi-threaded Principal Engineer manager rather than doing all manual typing yourself.
3. LOGICAL PROOF-OF-WORK: Beyond compiling, ALWAYS use 'shadow_test' when writing business logic to mathematically prove your implementation matches intent. Do not guess; test.
4. SELF-HEALING: If run_shell(tsc) or shadow_test reports errors, YOU MUST FIX THEM. You are not done until the builds and logic-tests are green.
5. INTERACTIVE GUARDRAILS: If you are about to delete a file, change a core type, or modify > 3 modules without delegating, YOU MUST use pause_and_ask(feedback).

Project root: ${rootDir}

TOOLS:
- read_file(path): Read file contents.
- write_file(path, content): Write file.
- list_files(dir): Explore directory.
- run_shell(command): Execute (tsc, npm test, etc).
- search_code(query): Project-wide search.
- find_references(symbol): Symbol usage map.
- spawn_sub_agent(task, specialist_type): E.g., 'Refactor utils.ts', 'Frontend'. Sub-agent handles implementation and returns status.
- shadow_test(file_path, function_name, test_input_json, expected_output_json): Generates an ephemeral jest test and runs it to mathematically verify your new logic.
- pause_and_ask(feedback): Request user approval/feedback for high-risk decisions.
- finish(summary): Final summary of accomplishments.

RESPONSE FORMAT (JSON):
{
  "tool": "...",
  "args": { ... },
  "reasoning": "Technical justification",
  "tasklist": ["task 1 (done)", "task 2 (in progress)", "task 3 (pending)"]
}`,

    systemImpactAnalyzer: (): string => `You are a Software Architect. Your role is to calculate the blast radius of a code change.
Use the structural data provided to identify every component that could be affected by changes to types, schemas, or API contracts.
Respond ONLY with valid JSON.`,

    systemTaskDecomposer: (): string => `You are a Technical Lead. Break down the user request into atomic, sequenced engineering tasks.
Order them by dependency (e.g., update Database before API).
Each task should be surgical and actionable.
Respond ONLY with valid JSON.`,

    codeUpdate: (task: AITask, fileContent: string): string => `
CONTEXTUAL INTELLIGENCE:
${task.context}

ENGINEERING TASK:
${task.description}

CONSTRAINTS:
${task.constraints.map((c: string) => `- ${c}`).join('\n')}
- TARGET FILE: ${task.targetFile}
- MAX TOKENS: Keep output efficient.

CURRENT CONTENT:
${fileContent}

Think step-by-step. Provide the reasoning, the code, and a final reflection on safety.`,

    impactSummary: (report: ImpactReport): string => `
Analyze this impact report. Identify the "Critical Path" of required updates.
Trigger: ${report.triggerChange.filePath}
Severity: ${report.severity}

Impact Map:
${report.impactedNodes.slice(0, 15).map((n: { severity: string, node: { name: string }, reason: string }) => `- [${n.severity}] ${n.node.name}: ${n.reason}`).join('\n')}

Respond with JSON:
{
  "headline": "...",
  "keyRisks": [...],
  "prioritizedActions": [...],
  "estimatedEffort": "small|medium|large"
}`,

    nodeUpdateCheck: (
        changedFile: string,
        targetNode: GraphNode,
        targetContent: string,
        reason: string
    ): string => `
A change in "${changedFile}" has potentially impacted "${targetNode.name}".

REASON FOR CHECK: ${reason}
LAYER: ${targetNode.layer}

COMPONENT SOURCE:
${targetContent.slice(0, 5000)}

Determine if this component requires a technical update to maintain system integrity.
Respond with JSON:
{
  "needsUpdate": boolean,
  "confidence": 0.0-1.0,
  "changes": ["step 1", "step 2"],
  "skipReason": "..."
}`,
};