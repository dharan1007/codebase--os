import type { AIProvider } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import {
    readFileTool,
    writeFileTool,
    patchFileTool,
    deleteFileTool,
    moveFileTool,
    listFilesTool,
    type ToolResult,
} from './tools/localTools.js';
import { CheckpointManager } from './CheckpointManager.js';
import type { Database } from '../../storage/Database.js';
import { searchCodeTool, findReferencesTool } from './tools/discoveryTools.js';
import { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { GraphStore } from '../../storage/GraphStore.js';
import { PromptTemplates } from './PromptTemplates.js';
import { extractJSONFromAIOutput, validateAgentAction } from '../../utils/validation.js';
import { DecisionEngine } from './DecisionEngine.js';
import { SandboxManager } from '../sandbox/SandboxManager.js';
import { EvalTracker } from '../eval/EvalTracker.js';
import { LocalServer } from '../server/LocalServer.js';
import { FailureManager } from '../diagnostics/FailureManager.js';
import { RootCauseAnalyzer } from '../failure/RootCauseAnalyzer.js';
import { FailureStore } from '../failure/FailureStore.js';
import { ChangeHistory } from '../../storage/ChangeHistory.js';
import { GitManager } from '../git/GitManager.js';
import { ResourceMonitor } from '../orchestrator/ResourceMonitor.js';
import { computeDiff } from '../../utils/diff.js';
import { TopologicalPlanner } from './TopologicalPlanner.js';
import { SessionMemory } from '../context/SessionMemory.js';
import ora from 'ora';
import path from 'path';
import fs from 'fs';

export interface AgentState {
    filesRead: string[];
    filesModified: string[];
    testsStatus: 'pass' | 'fail' | 'unknown';
    errorsRemaining: number;
}

export interface AgentAction {
    tool: 'read_file' | 'write_file' | 'patch_file' | 'delete_file' | 'move_file' | 'list_files' | 'run_shell' | 'search_code' | 'find_references' | 'pause_and_ask' | 'spawn_sub_agent' | 'finish';
    args: Record<string, string>;
    reasoning: string;
    tasklist?: string[];
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
    private maxSteps = 60;
    private steps: AgentStep[] = [];
    private filesWritten: string[] = [];
    private tasklist: string[] = [];
    private checkpointManager: CheckpointManager;
    private decisionEngine: DecisionEngine;
    private sandboxManager: SandboxManager;
    private evalTracker: EvalTracker;
    private localServer: LocalServer;
    private fileModifications = new Map<string, number>();
    private startTime: number = 0;
    private failureManager: FailureManager;
    private rootCaseAnalyzer: RootCauseAnalyzer;

    // Sliding window constants
    private static readonly SEED_MESSAGES = 1;     // always keep the initial task message
    private static readonly WINDOW_SIZE = 10;       // keep last N tool-result exchanges

    constructor(
        private provider: AIProvider,
        private rootDir: string,
        private db: Database,
        private sessionId: string,
        private graph: RelationshipGraph,
        private store: GraphStore,
        failureIntelligence?: { manager: FailureManager; rca: RootCauseAnalyzer }
    ) {
        const failureStore = new FailureStore(db);
        const resourceMonitor = new ResourceMonitor(db);
        this.checkpointManager = new CheckpointManager(db);
        this.localServer = new LocalServer(failureStore, resourceMonitor);
        this.localServer.start();
        this.decisionEngine = new DecisionEngine(graph, this.localServer);
        this.sandboxManager = new SandboxManager(rootDir);
        this.evalTracker = new EvalTracker(db);
        this.evalTracker.init();

        const history = new ChangeHistory(db);
        const gitManager = new GitManager(rootDir);
        this.failureManager = failureIntelligence?.manager || new FailureManager(db, history, failureStore);
        this.rootCaseAnalyzer = failureIntelligence?.rca || new RootCauseAnalyzer(provider, gitManager, graph);
    }

    async run(
        task: string,
        options: {
            maxSteps?: number;
            onStep?: (step: number, action: any, result: any, tasklist: string[], diff?: string) => Promise<void> | void;
            initialSteps?: AgentStep[];
            initialFiles?: string[];
            initialMessages?: any[];
        } = {}
    ): Promise<AgentResult> {
        if (options.maxSteps) this.maxSteps = options.maxSteps;
        const onStep = options.onStep;
        this.startTime = Date.now();

        this.steps = options.initialSteps || [];
        this.filesWritten = options.initialFiles || [];
        const messages: Array<{ role: 'user' | 'assistant'; content: string }> = options.initialMessages || [];

        if (messages.length === 0) {
            const bootstrapContext = await this.buildBootstrapContext(task);
            const seedPrompt =
                `TASK: ${task}\n\n` +
                `[CODEBASE CONTEXT — read these files before making any changes]:\n${bootstrapContext}\n\n` +
                `RULE: For any EXISTING file, emit a patch_file action with a unified diff. ` +
                `For NEW files, emit a write_file action with full content. ` +
                `Begin with a read_file or list_files action to confirm your understanding.`;
            messages.push({ role: 'user', content: seedPrompt });
        }

        let stepCount = this.steps.length;
        let lastSummary = 'Agent paused.';

        while (stepCount < this.maxSteps) {
            stepCount++;

            // Sliding window: always keep seed[0] + last WINDOW_SIZE messages
            if (messages.length > AgentLoop.SEED_MESSAGES + AgentLoop.WINDOW_SIZE) {
                const seed = messages.slice(0, AgentLoop.SEED_MESSAGES);
                const recent = messages.slice(-AgentLoop.WINDOW_SIZE);
                const dropped = messages.length - AgentLoop.SEED_MESSAGES - AgentLoop.WINDOW_SIZE;
                messages.splice(
                    0,
                    messages.length,
                    ...seed,
                    { role: 'user', content: `[MEMORY COMPACT]: ${dropped} older exchanges omitted. Step ${stepCount - 1} of ${this.maxSteps}. Continuing task: "${task}"` },
                    ...recent
                );
            }

            let response = '';
            try {
                const systemPrompt = PromptTemplates.agentSystemPrompt(this.rootDir);
                const prompt = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

                const result = await this.provider.execute({
                    taskType: 'reasoning',
                    priority: 'high',
                    context: prompt,
                    systemPrompt,
                    maxTokens: 4000,
                });
                response = result.content;
                messages.push({ role: 'assistant', content: response });
            } catch (err: any) {
                if (err.message?.includes('Quota')) return this.finalize(lastSummary, stepCount, false, messages, true);
                if (err.message?.includes('Outage')) return this.finalize(lastSummary, stepCount, true, messages);
                logger.error('Agent loop provider error', { error: String(err) });
                break;
            }

            // Parse + validate action with Zod
            let action: AgentAction;
            try {
                const raw = extractJSONFromAIOutput(response);
                action = validateAgentAction(raw, this.rootDir) as AgentAction;
                if (action.tasklist) this.tasklist = action.tasklist;
            } catch (err: any) {
                messages.push({
                    role: 'user',
                    content:
                        `[AGENT CORRECTION REQUIRED]: ${err.message}\n` +
                        `Output ONLY valid JSON matching: ` +
                        `{ "tool": "<tool_name>", "args": { ... }, "reasoning": "...", "tasklist": [...] }\n` +
                        `Valid tools: read_file, write_file, patch_file, delete_file, move_file, list_files, run_shell, search_code, find_references, pause_and_ask, finish`,
                });
                continue;
            }

            if (action.tool === 'finish') {
                lastSummary = action.args['summary'] ?? 'Task completed.';
                break;
            }

            // Decision engine for destructive operations
            let allowed = true;
            if (['write_file', 'patch_file', 'delete_file', 'run_shell'].includes(action.tool)) {
                const targetPath = action.args['path'] || action.args['oldPath'] || action.args['command'] || '';

                if (action.tool === 'write_file' || action.tool === 'patch_file') {
                    const modCount = (this.fileModifications.get(targetPath) || 0) + 1;
                    this.fileModifications.set(targetPath, modCount);
                    if (modCount >= 4) {
                        messages.push({
                            role: 'user',
                            content:
                                `[CONVERGENCE ALARM]: You have modified "${targetPath}" ${modCount} times. ` +
                                `Your approach is oscillating. Stop. Re-read the file, identify the root cause, ` +
                                `and use a different strategy or call pause_and_ask.`,
                        });
                        this.saveCheckpoint(messages);
                        continue;
                    }
                }

                let diffLines = 0;
                if (action.tool === 'patch_file') {
                    const diff = action.args['diff'] || '';
                    diffLines = diff.split('\n').filter(l => l.startsWith('+') || l.startsWith('-')).length;
                } else if (action.tool === 'write_file') {
                    diffLines = (action.args['content'] || '').split('\n').length;
                }

                const evaluation = this.decisionEngine.evaluate(action.tool, targetPath, diffLines, 0.8);
                allowed = await this.decisionEngine.enforce(action.tool, targetPath, evaluation);
            }

            if (!allowed) {
                messages.push({ role: 'user', content: 'Action denied by safety guard. Replan your approach.' });
                this.saveCheckpoint(messages);
                continue;
            }

            // Execute the tool
            let result: ToolResult;
            let diffOutput: string | undefined;
            try {
                result = await this.executeTool(action, onStep, stepCount, this.tasklist);

                // Capture diff for write operations to show in UI/CLI
                if (result.success && (action.tool === 'write_file' || action.tool === 'patch_file')) {
                    diffOutput = action.tool === 'patch_file'
                        ? action.args['diff']
                        : undefined;
                }

                if (!result.success) {
                    const report = await this.failureManager.handleFailure(
                        'runtime_crash',
                        action.args['path'] || 'unknown',
                        result.error || 'Unknown tool failure'
                    );
                    if (report.isRecurring) {
                        const rcaReport = await this.rootCaseAnalyzer.analyze({
                            id: report.id,
                            category: 'logic_drift',
                            filePath: report.filePath,
                            message: report.details,
                            contextBefore: '',
                            timestamp: Date.now(),
                            frequency: 3,
                        });
                        messages.push({
                            role: 'user',
                            content:
                                `[ROOT CAUSE ANALYSIS]: ${rcaReport.primaryCause}\n` +
                                `[SYSTEMIC HYPOTHESES]:\n` +
                                rcaReport.hypotheses.map(h => `- ${h.description} (Confidence: ${h.confidence})`).join('\n') +
                                `\n\nRe-plan using these systemic insights.`,
                        });
                    }
                }
            } catch (err: any) {
                await this.failureManager.handleFailure('runtime_crash', action.args['path'] || 'unknown', err.message);
                result = { success: false, output: '', error: err.message };
            }

            this.steps.push({ step: stepCount, action, result });
            if (onStep) await onStep(stepCount, action, result, this.tasklist, diffOutput);

            // Emit step to dashboard
            this.localServer.emitStep({ step: stepCount, action, result });

            const agentState: AgentState = {
                filesRead: [...new Set(this.steps.filter(s => s.action.tool === 'read_file').map(s => s.action.args['path'] ?? ''))],
                filesModified: this.filesWritten,
                testsStatus: 'unknown',
                errorsRemaining: 0,
            };

            const toolMsg =
                `[TOOL RESULT — Step ${stepCount}]\n` +
                `Tool: ${action.tool} | Target: ${action.args['path'] || action.args['command'] || action.args['dir'] || '(none)'}\n` +
                `Status: ${result.success ? 'SUCCESS' : 'FAILED'}\n` +
                `Output: ${(result.output || result.error || 'empty').slice(0, 600)}\n\n` +
                `Files read so far: [${agentState.filesRead.slice(-5).join(', ')}]\n` +
                `Files modified so far: [${agentState.filesModified.join(', ')}]\n` +
                `Determine your next action.`;

            messages.push({ role: 'user', content: toolMsg });
            this.saveCheckpoint(messages);
            await new Promise(r => setTimeout(r, 800));
        }

        return this.finalize(lastSummary, stepCount, false, messages);
    }

    /**
     * Builds a rich bootstrap context by:
     * 1. Loading persistent session memory from SQLite (cross-session intelligence)
     * 2. Running the TopologicalPlanner to compute a blast radius execution plan
     * 3. Reading the top 5 most relevant file contents (120 lines each)
     * 4. Including the directory structure for orientation
     *
     * This replaces the broken 3-word phrase searchCodeTool discovery.
     * No other coding agent does this — they all start blind every session.
     */
    private async buildBootstrapContext(task: string): Promise<string> {
        const sections: string[] = [];

        // 1. Session memory — what happened in previous sessions
        try {
            const memory = new SessionMemory(this.db, this.rootDir);
            const m = memory.load(5);
            if (m.formatted) {
                sections.push(m.formatted);
            }
        } catch { /* fresh project, no history */ }

        // 2. Topological blast radius — which files will be affected and in what order
        if (this.graph.nodes.size > 0) {
            try {
                const planner = new TopologicalPlanner(this.graph, this.rootDir);
                const report = planner.planFromTask(task);
                if (report.totalFiles > 0) {
                    const planLines = [
                        '=== TOPOLOGICAL EXECUTION PLAN ===',
                        `Blast radius: ${report.totalFiles} files across ${Object.keys(report.layerBreakdown).join(', ')} layers.`,
                        'Execute in this order (dependencies first):',
                        ...report.affectedFiles.map(f =>
                            `  [${f.executionOrder}] ${f.relativePath} [${f.layer}]${f.isRoot ? ' (ROOT)' : ''}${f.dependentCount >= 5 ? ` hub(${f.dependentCount} dependents)` : ''}`
                        ),
                    ];
                    if (report.crossLayerWarnings.length > 0) {
                        planLines.push('', 'Architecture warnings:');
                        for (const w of report.crossLayerWarnings) {
                            planLines.push(`  [!] ${w}`);
                        }
                    }
                    if (report.cycles.length > 0) {
                        planLines.push('', 'Circular dependencies detected:');
                        for (const c of report.cycles) {
                            planLines.push(`  [cycle] ${c}`);
                        }
                    }
                    planLines.push('=== END PLAN ===');
                    sections.push(planLines.join('\n'));
                }
            } catch { /* graph might be disconnected */ }
        }

        // 3. Read top relevant file contents
        const hubFiles = this.getHubFiles(task);
        const fileSnippets: string[] = [];
        for (const relPath of hubFiles.slice(0, 5)) {
            const absPath = path.resolve(this.rootDir, relPath);
            try {
                const content = fs.readFileSync(absPath, 'utf8');
                const snippet = content.split('\n').slice(0, 120).join('\n');
                fileSnippets.push(`=== ${relPath} ===\n${snippet}`);
            } catch { /* file may have been deleted */ }
        }
        if (fileSnippets.length > 0) {
            sections.push('=== RELEVANT FILE CONTENTS ===');
            sections.push(fileSnippets.join('\n\n---\n\n'));
            sections.push('=== END FILE CONTENTS ===');
        }

        // 4. Directory structure
        const dirResult = await listFilesTool('.', this.rootDir);
        const dirTree = dirResult.output.split('\n').slice(0, 50).join('\n');
        sections.push(`=== PROJECT STRUCTURE ===\n${dirTree}\n=== END STRUCTURE ===`);

        return sections.join('\n\n');
    }

    private analyzeImpact(filePath: string): string {
        try {
            const nodes = this.graph.getNodesByFile(filePath);
            if (nodes.length === 0) return '';
            const dependents = nodes.flatMap(n => this.graph.getDirectDependents(n.id));
            if (dependents.length === 0) return '';
            const impactList = dependents.slice(0, 10).map(d => `- ${d.name} (${d.filePath})`).join('\n');
            return `Modifying "${filePath}" potentially impacts:\n${impactList}\nEnsure these files remain consistent.`;
        } catch {
            return '';
        }
    }

    private getHubFiles(task: string): string[] {
        if (!this.graph || this.graph.nodes.size === 0) return [];
        const kw = task.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const nodes = Array.from(this.graph.nodes.values())
            .filter(n => kw.some(k => n.name.toLowerCase().includes(k) || n.filePath.toLowerCase().includes(k)))
            .sort((a, b) => {
                const score = (node: any) => {
                    const deps = Array.from(this.graph.reverseAdjacency.get(node.id) || []);
                    return deps.length;
                };
                return score(b) - score(a);
            });
        return nodes.slice(0, 8).map(n => path.relative(this.rootDir, n.filePath));
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
            updatedAt: Date.now(),
        });
    }

    private async finalize(
        lastSummary: string,
        stepCount: number,
        outageDetected = false,
        messages: any[] = [],
        quotaReached = false
    ): Promise<AgentResult> {
        this.localServer.stop();
        const result: AgentResult = {
            success: true,
            summary: lastSummary,
            steps: this.steps,
            filesWritten: this.filesWritten,
            totalSteps: stepCount,
            tasklist: this.tasklist,
            outageDetected,
            quotaReached,
        };
        const tokensUsed = messages.reduce((acc, m) => acc + (m.content.length / 4), 0);
        this.evalTracker.trackSession(this.sessionId, 'code', this.startTime, result, tokensUsed, this.provider.kind, 'agent-loop-model');
        return result;
    }

    private async executeTool(
        action: AgentAction,
        onStep: any,
        stepCount: number,
        tasklist: string[]
    ): Promise<ToolResult> {
        try {
            switch (action.tool) {
                case 'read_file':
                    return await readFileTool(action.args['path'] ?? '', this.rootDir);

                case 'write_file': {
                    const r = await writeFileTool(action.args['path'] ?? '', action.args['content'] ?? '', this.rootDir);
                    if (r.success) this.filesWritten.push(action.args['path'] ?? '');
                    return r;
                }

                case 'patch_file': {
                    const r = await patchFileTool(action.args['path'] ?? '', action.args['diff'] ?? '', this.rootDir);
                    if (r.success) {
                        const p = action.args['path'] ?? '';
                        if (!this.filesWritten.includes(p)) this.filesWritten.push(p);
                    }
                    return r;
                }

                case 'delete_file':
                    return await deleteFileTool(action.args['path'] ?? '', this.rootDir);

                case 'move_file':
                    return await moveFileTool(action.args['oldPath'] ?? '', action.args['newPath'] ?? '', this.rootDir);

                case 'list_files':
                    return await listFilesTool(action.args['dir'] ?? '.', this.rootDir);

                case 'search_code':
                    return await searchCodeTool(action.args['query'] ?? '', this.rootDir);

                case 'find_references':
                    return await findReferencesTool(action.args['symbol'] ?? '', this.rootDir);

                case 'run_shell':
                    return await this.sandboxManager.execute(action.args['command'] ?? '', false, (chunk) => {
                        onStep?.(stepCount, action, { success: true, output: chunk, isStreaming: true }, tasklist);
                    });

                default:
                    return { success: false, output: '', error: `Unknown tool: ${action.tool}` };
            }
        } catch (err) {
            return { success: false, output: '', error: String(err) };
        }
    }
}
