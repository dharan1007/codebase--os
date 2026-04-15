import type { AITask, ImpactReport, GraphNode } from '../../types/index.js';

export const PromptTemplates = {
    systemCodeExecutor: (): string => `You are an expert software engineer tasked with making precise, minimal, production-quality code changes.

RULES:
1. Output ONLY the complete updated file content — no markdown fences, no explanations, no commentary.
2. Never add placeholder comments like "// TODO", "// implement later", or "// rest of code here".
3. Maintain existing code style, indentation, and formatting patterns.
4. Only change what is strictly necessary to fulfill the task.
5. Preserve all existing functionality unless explicitly instructed to remove it.
6. Never introduce new dependencies not already present in the file.
7. The output must be valid, production-ready code that compiles without errors.`,

    systemImpactAnalyzer: (): string => `You are an expert software architect analyzing codebase changes.
Your role is to determine exactly which files and components need to be updated when a change is made.
Be precise, conservative, and only flag genuinely impacted components.
Always respond with valid JSON.`,

    systemTaskDecomposer: (): string => `You are a senior software engineer decomposing code change requirements into structured tasks.
Analyze the impact report and determine the exact set of atomic changes needed.
Be specific, actionable, and conservative — only create tasks for changes that are truly necessary.
Always respond with valid JSON.`,

    codeUpdate: (task: AITask, fileContent: string): string => `
TASK: ${task.description}
KIND: ${task.kind}
FILE: ${task.targetFile}

CONTEXT:
${task.context}

CONSTRAINTS:
${task.constraints.map(c => `- ${c}`).join('\n')}

EXPECTED OUTPUT:
${task.expectedOutput}

CURRENT FILE CONTENT:
${fileContent}

Output the complete updated file with minimal necessary changes.`,

    impactSummary: (report: ImpactReport): string => `
Analyze this impact report and provide a concise, actionable summary for developers.

Trigger change: ${report.triggerChange.filePath} (${report.triggerChange.changeType})
Severity: ${report.severity}
Scopes: ${report.scope.join(', ')}
Affected layers: ${report.affectedLayers.join(', ')}

Impacted nodes (top ${Math.min(report.impactedNodes.length, 10)}):
${report.impactedNodes
            .slice(0, 10)
            .map(n => `- ${n.node.name} (${n.node.kind}, ${n.node.layer}): ${n.reason}`)
            .join('\n')}

Cross-layer issues:
${report.crossLayerIssues.map(i => `- [${i.sourceLayer}→${i.targetLayer}] ${i.description}`).join('\n')}

Provide a concise JSON object:
{
  "headline": "one-line summary",
  "keyRisks": ["risk1", "risk2"],
  "prioritizedActions": ["action1", "action2"],
  "estimatedEffort": "small|medium|large"
}`,

    nodeUpdateCheck: (
        changedFile: string,
        targetNode: GraphNode,
        targetContent: string,
        reason: string
    ): string => `
A change was made to: ${changedFile}

The following component may need updates:
- Name: ${targetNode.name}
- Kind: ${targetNode.kind}
- Layer: ${targetNode.layer}
- File: ${targetNode.filePath}
- Reason: ${reason}

Current content of ${targetNode.filePath}:
${targetContent.slice(0, 4000)}

Respond with JSON:
{
  "needsUpdate": boolean,
  "confidence": 0.0-1.0,
  "changes": ["specific change 1", "specific change 2"],
  "risks": ["risk1"],
  "skipReason": "why no update needed if needsUpdate=false"
}`,
};