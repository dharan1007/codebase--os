import type { AIProvider } from '../../types/index.js';
import type { AITask } from '../../types/index.js';
import { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { GraphContextBuilder } from './GraphContextBuilder.js';
import { extractJSONFromAIOutput } from '../../utils/validation.js';
import { logger } from '../../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';

export interface PlanResult {
    tasks: AITask[];
    summary: string;
    affectedFiles: string[];
    canCreateFiles: boolean;
    estimatedEffort: 'small' | 'medium' | 'large';
}

export class ConversationalPlanner {
    constructor(
        private provider: AIProvider,
        private graph?: RelationshipGraph
    ) {}

    async plan(request: string, rootDir: string, focusFile?: string): Promise<PlanResult> {
        // Step 1: Build project context — use graph if available, else fall back to flat file list
        let graphContextBlock = '';
        let relevantFiles: string[] = [];

        if (this.graph && this.graph.nodes.size > 0) {
            const builder = new GraphContextBuilder(this.graph);
            const ctx = builder.build(request, rootDir, focusFile ? [focusFile] : undefined);
            graphContextBlock = builder.format(ctx);
            relevantFiles = ctx.relevantFiles;
        } else {
            relevantFiles = this.buildFlatFileList(rootDir);
        }

        // Step 2: Build file list context
        const fileContext = relevantFiles.join('\n') || '(project files not yet scanned — run cos scan first)';

        // Step 3: Call AI with rich, structured prompt
        const planningResponse = await this.provider.complete({
            systemPrompt: `You are an elite software engineer AI assistant embedded in a coding agent called Codebase OS.
You analyze a developer's plain-English request and produce a precise, actionable change plan.
You have been given structural intelligence about the project — including cross-layer dependencies and cyclic warnings.
You MUST use this intelligence when deciding which files to change.

RULES:
1. Respond with valid JSON only — no markdown, no extra text.
2. Only reference files that actually exist in the project file list below.
3. Prioritize files shown in the Graph Context over the plain file list.
4. If the request is ambiguous, make a conservative, minimal-impact plan.
5. Never hallucinate file paths that don't appear in the context.`,
            userPrompt: `Developer request: "${request}"

Project root: ${rootDir}

${graphContextBlock}

Full project file list:
${fileContext}

Produce a structured change plan. Respond with ONLY this JSON (no comments, no extra text):
{
  "summary": "one-sentence description of what will be changed",
  "estimatedEffort": "small|medium|large",
  "canCreateFiles": true or false,
  "tasks": [
    {
      "description": "exact, atomic description of what to change in this file",
      "targetFile": "absolute path to the target file",
      "kind": "fix|update|generate|refactor|sync",
      "context": "why this file needs to change, referencing the graph data if relevant",
      "constraints": ["constraint 1", "constraint 2"],
      "expectedOutput": "what the updated file should accomplish",
      "priority": 1,
      "isNewFile": false
    }
  ]
}`,
            temperature: 0.15,
            maxTokens: 3000,
            responseFormat: 'json',
        });

        try {
            const parsed = extractJSONFromAIOutput(planningResponse.content) as {
                summary: string;
                estimatedEffort: 'small' | 'medium' | 'large';
                canCreateFiles: boolean;
                tasks: Array<{
                    description: string;
                    targetFile: string;
                    kind: AITask['kind'];
                    context: string;
                    constraints: string[];
                    expectedOutput: string;
                    priority: number;
                    isNewFile?: boolean;
                }>;
            };

            const tasks: AITask[] = parsed.tasks
                .filter(t => t.targetFile && t.description)
                .map(t => ({
                    id: uuidv4(),
                    kind: t.kind ?? 'update',
                    description: t.description,
                    targetFile: t.targetFile,
                    context: t.context ?? request,
                    constraints: t.constraints ?? [],
                    expectedOutput: t.expectedOutput ?? 'Updated file implementing the requested change',
                    priority: t.priority ?? 5,
                }));

            return {
                tasks,
                summary: parsed.summary ?? 'Plan ready',
                affectedFiles: tasks.map(t => t.targetFile),
                canCreateFiles: parsed.canCreateFiles ?? false,
                estimatedEffort: parsed.estimatedEffort ?? 'medium',
            };
        } catch (err) {
            logger.error('Failed to parse planning response', { error: String(err) });
            return {
                tasks: [],
                summary: 'Could not generate a plan. Please try again with a clearer description.',
                affectedFiles: [],
                canCreateFiles: false,
                estimatedEffort: 'small',
            };
        }
    }

    private buildFlatFileList(rootDir: string): string[] {
        const allFiles: string[] = [];
        this.walkDir(rootDir, allFiles, 0, 3, [
            'node_modules', 'dist', '.git', '.cos', 'coverage', '__pycache__', '.dart_tool', 'build',
        ]);
        return allFiles.slice(0, 60).map(f => path.relative(rootDir, f));
    }

    private walkDir(dir: string, results: string[], depth: number, maxDepth: number, ignore: string[]): void {
        if (depth > maxDepth) return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (ignore.some(i => entry.name === i || entry.name.startsWith('.'))) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                this.walkDir(full, results, depth + 1, maxDepth, ignore);
            } else {
                results.push(full);
            }
        }
    }
}
