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
    answer?: string;
    affectedFiles: string[];
    canCreateFiles: boolean;
    estimatedEffort: 'small' | 'medium' | 'large';
}

export class ConversationalPlanner {
    constructor(
        private provider: AIProvider,
        private graph?: RelationshipGraph,
        private store?: any
    ) {}

    async plan(request: string, rootDir: string, focusFile?: string): Promise<PlanResult> {
        let graphContextBlock = '';
        let relevantFiles: string[] = [];

        if (this.graph && this.graph.nodes.size > 0 && this.store) {
            const builder = new GraphContextBuilder(this.graph, this.store, this.provider);
            const ctx = await builder.build(request, rootDir, focusFile ? [focusFile] : undefined);
            graphContextBlock = builder.format(ctx);
            relevantFiles = ctx.relevantFiles;
        } else {
            relevantFiles = this.buildFlatFileList(rootDir);
        }

        const fileContext = relevantFiles.join('\n') || '(no files found)';

        const result = await this.provider.execute({
            taskType: 'analysis',
            priority: 'medium',
            context: `Developer request: "${request}"\n\nProject root: ${rootDir}\n${graphContextBlock}\n\nFILES:\n${fileContext}`,
            systemPrompt: `You are the Sovereign Principal Engineer of Codebase OS. 

Your goal is to guide the user through codebase evolutions with elite technical precision and a sophisticated, helpful tone.

- If the user asks a question (inquiry), provide a deep, elegant "answer".
- If the user requests a change, generate a structured list of "tasks".
- ALWAYS respond with ONLY valid JSON.

JSON SCHEMA:
{
  "summary": "Elegant headline of the plan or answer",
  "answer": "Cohesive, principal-grade explanation or analysis",
  "tasks": []
}`,
            maxTokens: 1500,
        });

        try {
            let parsed: any;
            try {
                parsed = extractJSONFromAIOutput(result.content);
            } catch (e) {
                logger.warn('JSON extraction failed, falling back to raw answer', { error: String(e) });
                return {
                    tasks: [],
                    summary: 'Direct Text Response',
                    answer: result.content,
                    affectedFiles: [],
                    canCreateFiles: false,
                    estimatedEffort: 'small'
                };
            }
            
            if (parsed.answer && (!parsed.tasks || parsed.tasks.length === 0)) {
                return {
                    tasks: [],
                    summary: parsed.summary ?? 'Analysis Complete',
                    answer: parsed.answer,
                    affectedFiles: [],
                    canCreateFiles: false,
                    estimatedEffort: 'small',
                };
            }

            const tasks: AITask[] = (parsed.tasks || [])
                .filter((t: any) => {
                    if (!t.targetFile || !t.description) return false;
                    const pathLower = t.targetFile.toLowerCase();
                    if (pathLower.includes('absolute path')) return false;
                    if (pathLower.includes('file_path')) return false;
                    if (pathLower.includes('example.js')) return false;
                    if (!t.targetFile.includes('.') && !t.targetFile.includes('/') && !t.targetFile.includes('\\')) return false;
                    return true;
                })
                .map((t: any) => ({
                    id: uuidv4(),
                    kind: t.kind ?? 'update',
                    description: t.description,
                    targetFile: t.targetFile,
                    context: t.context ?? request,
                    constraints: t.constraints ?? [],
                    expectedOutput: t.expectedOutput ?? 'Process task',
                    priority: t.priority ?? 5,
                }));

            return {
                tasks,
                summary: parsed.summary ?? 'Plan generated',
                answer: parsed.answer,
                affectedFiles: tasks.map(t => t.targetFile),
                canCreateFiles: parsed.canCreateFiles ?? false,
                estimatedEffort: parsed.estimatedEffort ?? 'small',
            };
        } catch (err) {
            logger.error('Final planning fallback failed', { error: String(err) });
            return { tasks: [], summary: 'Planning failed', answer: result.content, affectedFiles: [], canCreateFiles: false, estimatedEffort: 'small' };
        }
    }

    private buildFlatFileList(rootDir: string): string[] {
        const allFiles: string[] = [];
        this.walkDir(rootDir, allFiles, 0, 2, ['node_modules', '.git', '.cos', 'build', 'dist']);
        return allFiles.slice(0, 40).map(f => path.relative(rootDir, f));
    }

    private walkDir(dir: string, results: string[], depth: number, maxDepth: number, ignore: string[]): void {
        if (depth > maxDepth) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (ignore.some(i => entry.name === i)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                this.walkDir(full, results, depth + 1, maxDepth, ignore);
            } else { results.push(full); }
        }
    }
}
