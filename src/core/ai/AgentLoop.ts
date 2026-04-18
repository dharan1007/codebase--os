import type { AIProvider } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import { readFileTool, writeFileTool, deleteFileTool, moveFileTool, listFilesTool, type ToolResult } from './tools/localTools.js';
import { CheckpointManager } from './CheckpointManager.js';
import type { Database } from '../../storage/Database.js';
import { searchCodeTool, findReferencesTool } from './tools/discoveryTools.js';
import { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { GraphStore } from '../../storage/GraphStore.js';
import { PromptTemplates } from './PromptTemplates.js';
import { extractJSONFromAIOutput } from '../../utils/validation.js';
import ora from 'ora';
import path from 'path';

export interface AgentAction {
    tool: 'read_file' | 'write_file' | 'delete_file' | 'move_file' | 'list_files' | 'run_shell' | 'search_code' | 'find_references' | 'pause_and_ask' | 'spawn_sub_agent' | 'finish';
    args: Record<string, string>;
    reasoning: string;
}

export interface AgentStep {
    step: number;
    action: AgentAction;
    result: ToolResult;
}

export interface AgentResult {
    success: boolean;
    steps: AgentStep[];
    summary: string;
    filesWritten: string[];
    totalSteps: number;
    tasklist: string[];
    outageDetected?: boolean;
    quotaReached?: boolean;
}

export class AgentLoop {
    private maxSteps = 40;
    private steps: AgentStep[] = [];
    private filesWritten: string[] = [];
    private tasklist: string[] = [];
    private checkpointManager: CheckpointManager;

    constructor(
        private provider: AIProvider,
        private rootDir: string,
        private db: Database,
        private sessionId: string,
        private graph: RelationshipGraph,
        private store: GraphStore
    ) {
        this.checkpointManager = new CheckpointManager(db);
    }

    async run(
        task: string,
        onStep?: (step: number, action: AgentAction, result: ToolResult, tasklist: string[]) => Promise<void> | void,
        initialSteps: AgentStep[] = [],
        initialFiles: string[] = [],
        initialMessages: any[] = []
    ): Promise<AgentResult> {
        this.steps = [...initialSteps];
        this.filesWritten = [...initialFiles];

        const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [...initialMessages];

        if (messages.length === 0) {
            const initialDiscovery = await this.performInitialDiscovery(task);
            const mergedUserPrompt = `TASK: ${task}\n\n[SOVEREIGN STRATEGY INFO]:\n${initialDiscovery}\n\nMaintain 100% build integrity. Begin.`;
            messages.push({ role: 'user', content: mergedUserPrompt });
        }

        let stepCount = this.steps.length;
        let lastSummary = 'Agent paused.';

        while (stepCount < this.maxSteps) {
            stepCount++;

            // [SOVEREIGN MEMORY]: Retain last 3 architectural turns for consistency
            if (messages.length > 10) {
                const recent = messages.slice(-4);
                const recap = `RECAP: Goal - ${task}. Progress - ${this.tasklist.join(', ') || 'Exploring'}. Step count: ${stepCount - 1}.`;
                messages.splice(0, messages.length, { role: 'user', content: recap }, ...recent);
            }

            let response: string = '';
            try {
                const prompt = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
                const completion = await this.provider.complete({
                    systemPrompt: PromptTemplates.agentSystemPrompt(this.rootDir),
                    userPrompt: prompt,
                    temperature: 0.1,
                    maxTokens: 4000,
                    responseFormat: 'json' as const,
                });
                response = completion.content;
                messages.push({ role: 'assistant', content: response });
            } catch (err: any) {
                if (err.name === 'AIQuotaReachedError') return this.finalize(lastSummary, stepCount, false, messages, true);
                if (err.name === 'AIModelOutageError') return this.finalize(lastSummary, stepCount, true, messages);
                logger.error('Agent loop failed', { error: String(err) });
                break;
            }

            let action: AgentAction;
            try {
                action = extractJSONFromAIOutput(response) as AgentAction;
                if ((action as any).tasklist) this.tasklist = (action as any).tasklist;
            } catch (err: any) {
                messages.push({ role: 'user', content: 'SYSTEM ERROR: Response must be strict JSON. Retry with valid tool call.' });
                continue;
            }

            if (action.tool === 'finish') {
                lastSummary = action.args['summary'] ?? 'Task refined and completed.';
                break;
            }

            // [SOVEREIGN ENGINE]: Automatic Consequence Guard
            let consequenceBlock = '';
            if (action.tool === 'write_file' || action.tool === 'delete_file') {
                const targetPath = action.args['path'] || action.args['oldPath'] || '';
                consequenceBlock = this.analyzeImpact(targetPath);
            }

            let result = await this.executeTool(action, onStep, stepCount, this.tasklist);
            this.steps.push({ step: stepCount, action, result });
            if (onStep) await onStep(stepCount, action, result, this.tasklist);

            let toolMsg = `Tool result: ${result.output || result.error || 'Empty'}`;
            if (consequenceBlock) {
                toolMsg = `[ARCHITECTURAL CONSEQUENCE WARNING]:\n${consequenceBlock}\n\n${toolMsg}`;
            }
            
            messages.push({ role: 'user', content: `${toolMsg}\nVerify build and continue.` });
            this.saveCheckpoint(messages);
            await new Promise(r => setTimeout(r, 2000));
        }

        return this.finalize(lastSummary, stepCount, false, messages);
    }

    private analyzeImpact(filePath: string): string {
        try {
            const nodes = this.graph.getNodesByFile(filePath);
            if (nodes.length === 0) return '';
            const dependents = nodes.flatMap(n => this.graph.getDirectDependents(n.id));
            if (dependents.length === 0) return '';
            
            const impactList = dependents.slice(0, 10).map(d => `- ${d.name} (${d.filePath})`).join('\n');
            return `Modifying "${filePath}" potentially impacts these dependents across the project:\n${impactList}\nYou MUST ensure these files are updated or tested to prevent breaking changes.`;
        } catch { return ''; }
    }

    private async performInitialDiscovery(task: string): Promise<string> {
        try {
            const result = await searchCodeTool(task.split(' ').slice(0, 3).join(' '), this.rootDir);
            const hubFiles = this.getHubFiles(task);
            return `Discovery: ${result.output.substring(0, 600)}\nHighly connected modules: ${hubFiles.join(', ')}`;
        } catch { return 'Discovery failed.'; }
    }

    private getHubFiles(task: string): string[] {
        if (!this.graph) return [];
        const kw = task.toLowerCase().split(' ').filter(w => w.length > 3);
        const nodes = Array.from(this.graph.nodes.values())
            .filter(n => kw.some(k => n.name.toLowerCase().includes(k)))
            .sort((a,b) => (this.graph.adjacency.get(b.id)?.size ?? 0) - (this.graph.adjacency.get(a.id)?.size ?? 0));
        return nodes.slice(0, 5).map(n => path.relative(this.rootDir, n.filePath));
    }

    private saveCheckpoint(messages: any[]) {
        this.checkpointManager.save({
            id: this.sessionId,
            sessionId: this.sessionId,
            taskType: 'agent',
            status: 'in_progress',
            plan: [{ id: 'agent-main', kind: 'refactor', description: '', targetFile: '.', context: '', constraints: [], expectedOutput: '', priority: 1 }],
            results: [], 
            metadata: { steps: this.steps, filesWritten: this.filesWritten, messages },
            updatedAt: Date.now()
        });
    }

    private finalize(summary: string, steps: number, outage: boolean, messages: any[], quota: boolean = false): AgentResult {
        if (outage || quota) this.saveCheckpoint(messages);
        return {
            success: !outage && !quota && (this.filesWritten.length > 0 || this.steps.some(s => s.result.success)),
            steps: this.steps,
            summary,
            filesWritten: this.filesWritten,
            totalSteps: steps,
            tasklist: this.tasklist,
            outageDetected: outage,
            quotaReached: quota
        };
    }

    private async executeTool(action: AgentAction, onStep: any, stepCount: number, tasklist: string[]): Promise<ToolResult> {
        try {
            switch (action.tool) {
                case 'read_file': return await readFileTool(action.args['path'] ?? '', this.rootDir);
                case 'write_file': {
                    const r = await writeFileTool(action.args['path'] ?? '', action.args['content'] ?? '', this.rootDir);
                    if (r.success) this.filesWritten.push(action.args['path'] ?? '');
                    return r;
                }
                case 'delete_file': return await deleteFileTool(action.args['path'] ?? '', this.rootDir);
                case 'move_file': return await moveFileTool(action.args['oldPath'] ?? '', action.args['newPath'] ?? '', this.rootDir);
                case 'list_files': return await listFilesTool(action.args['dir'] ?? '.', this.rootDir);
                case 'search_code': return await searchCodeTool(action.args['query'] ?? '', this.rootDir);
                case 'find_references': return await findReferencesTool(action.args['symbol'] ?? '', this.rootDir);
                case 'run_shell': {
                    const { spawn } = await import('child_process');
                    return new Promise((resolve) => {
                        const child = spawn(action.args['command'] ?? '', { cwd: this.rootDir, shell: true });
                        let out = '';
                        child.stdout.on('data', d => { 
                            out += d.toString(); 
                            onStep?.(stepCount, action, { success: true, output: d.toString(), isStreaming: true }, tasklist); 
                        });
                        child.stderr.on('data', d => out += d.toString());
                        child.on('close', code => resolve({ success: code === 0 || code === null, output: out }));
                        setTimeout(() => { child.kill(); resolve({ success: false, output: out, error: 'Timeout' }); }, 80000);
                    });
                }
                default: return { success: false, output: '', error: `Unknown tool: ${action.tool}` };
            }
        } catch (err) { return { success: false, output: '', error: String(err) }; }
    }
}
