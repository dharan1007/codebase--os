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
import { CognitiveState } from '../context/CognitiveState.js';
import path from 'path';
import fs from 'fs';
import { AgentController, type AgentBudget } from './AgentController.js';
import { ContextManager } from '../context/ContextManager.js';
import { ModelRegistry } from './ModelRegistry.js';
import { RequestQueue } from '../orchestrator/RequestQueue.js';
import { WatchdogService } from '../orchestrator/WatchdogService.js';
import { withTimeout } from '../../utils/TimeoutWrapper.js';

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
    private actionRepetition = new Map<string, number>();
    private filesReadThisSession = new Set<string>();
    private startTime: number = 0;
    private failureManager: FailureManager;
    private rootCaseAnalyzer: RootCauseAnalyzer;
    private cognitiveState!: CognitiveState;
    private controller!: AgentController;
    private contextManager!: ContextManager;

    // Context budget constants
    // We keep seed + last RECENT_WINDOW raw messages.
    // Older messages beyond this are only available via CognitiveState summary.
    private static readonly SEED_MESSAGES = 1;
    private static readonly RECENT_WINDOW = 12;

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
        this.decisionEngine = new DecisionEngine(graph);
        this.sandboxManager = new SandboxManager(rootDir);
        this.evalTracker = new EvalTracker(db);
        this.cognitiveState = new CognitiveState(sessionId, db, provider);
        this.cognitiveState.restore();

        const history = new ChangeHistory(db);
        const gitManager = new GitManager(rootDir);
        this.failureManager = failureIntelligence?.manager || new FailureManager(db, history, failureStore);
        this.rootCaseAnalyzer = failureIntelligence?.rca || new RootCauseAnalyzer(provider, gitManager, graph);

        // Initialize regulation components
        const budget: AgentBudget = {
            maxSteps: 60,
            maxTokens: 500000, // 500k token session budget
            maxCost: 2.0 // $2.00 hard cap per session
        };
        this.controller = new AgentController(budget);
        
        const modelId = ModelRegistry.resolve('reasoning-high', provider.kind as any);
        this.contextManager = new ContextManager(modelId);
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

        // Register with Watchdog
        WatchdogService.getInstance().register(this.sessionId);

        this.steps = options.initialSteps || [];
        this.filesWritten = options.initialFiles || [];
        const messages: Array<{ role: 'user' | 'assistant'; content: string }> = options.initialMessages || [];

        if (messages.length === 0) {
            const bootstrapContext = await this.buildBootstrapContext(task);
            const isDesignTask = /ui|style|css|aesthetic|design|layout|frontend/i.test(task);
            const designGems = isDesignTask ? `\n\n[DESIGN GUIDELINES]:\n${PromptTemplates.designPrinciples()}` : '';

            const seedPrompt =
                `TASK: ${task}\n\n` +
                `[CODEBASE CONTEXT — read these files before making any changes]:\n${bootstrapContext}\n\n` +
                designGems +
                `RULE: For any EXISTING file, emit a patch_file action with a unified diff. ` +
                `For NEW files, emit a write_file action with full content. ` +
                `Begin with a read_file or list_files action to confirm your understanding.`;
            messages.push({ role: 'user', content: seedPrompt });
        }

        let stepCount = this.steps.length;
        let lastSummary = 'Agent paused.';

        while (stepCount < this.maxSteps) {
            try {
                this.controller.checkpoint();
                // Pulse Watchdog at the start of every step
                WatchdogService.getInstance().pulse(this.sessionId, 'EXECUTING');
            } catch (err: any) {
                logger.error(`[AgentLoop] Budget halted execution: ${err.message}`);
                break;
            }
            
            stepCount++;

            // ── COGNITIVE STATE ──────────────────────────────────────────────
            const compressibleMessages = messages.slice(
                AgentLoop.SEED_MESSAGES,
                Math.max(AgentLoop.SEED_MESSAGES, messages.length - AgentLoop.RECENT_WINDOW)
            );
            const cognitiveHeader = await this.cognitiveState.tick(
                stepCount, compressibleMessages, task,
                (summary: string) => logger.debug('CognitiveState compressed', { summaryLen: summary.length })
            );

            // ── CONTEXT REGULATION [NEW] ────────────────────────────────────
            // Instead of a lossy splice, we use the ContextManager to fit within model constraints
            messages.push({ role: 'user', content: cognitiveHeader }); // Inject summary
            const regulatedMessages = this.contextManager.regulate(messages as any);
            
            let response = '';
            let orchestratorAttempts = 0;
            const MAX_ORCHESTRATOR_ATTEMPTS = 3;

            while (orchestratorAttempts < MAX_ORCHESTRATOR_ATTEMPTS) {
                try {
                    const systemPrompt = PromptTemplates.agentSystemPrompt(this.rootDir);
                    const results = await this.provider.execute({
                        taskType: 'reasoning',
                        priority: 'high',
                        context: regulatedMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n'),
                        systemPrompt,
                        maxTokens: 4000,
                    });
                    
                    response = results.content;
                    this.controller.recordUsage(results.usage.totalTokens, 0);
                    messages.push({ role: 'assistant', content: response });
                    break; // Success!
                } catch (err: any) {
                    orchestratorAttempts++;
                    const isQuota = err.message?.includes('Quota') || err.message?.includes('429');
                    
                    if (orchestratorAttempts >= MAX_ORCHESTRATOR_ATTEMPTS) {
                        if (isQuota) return this.finalize(lastSummary, stepCount, false, messages, true);
                        logger.error('[AgentLoop] Orchestrator exhausted all fallbacks and retries.', { error: String(err) });
                        return this.finalize(lastSummary, stepCount, true, messages);
                    }

                    const delay = isQuota ? 10000 : 3000;
                    logger.warn(`[AgentLoop] Cloud congestion. Attempt ${orchestratorAttempts}/${MAX_ORCHESTRATOR_ATTEMPTS}. Waiting ${delay/1000}s...`);
                    await new Promise(r => setTimeout(r, delay));
                }
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

            // ── STAGNATION & REPETITION DETECTION ────────────────────────────
            const actionKey = `${action.tool}:${JSON.stringify(action.args)}`;
            const actionCount = (this.actionRepetition.get(actionKey) || 0) + 1;
            this.actionRepetition.set(actionKey, actionCount);

            if (actionCount >= 3) {
                messages.push({
                    role: 'user',
                    content:
                        `[STAGNATION ALERT]: You have called "${action.tool}" with these exact arguments ${actionCount} times. ` +
                        `You are stuck in a reasoning loop. DO NOT repeat the same tool call. ` +
                        `If you are stuck, read a different file, use search_code, or use pause_and_ask for manual guidance.`,
                });
                this.actionRepetition.set(actionKey, 0); // Reset for next cycle
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
                let newContent: string | undefined;
                if (action.tool === 'patch_file') {
                    const diff = action.args['diff'] || '';
                    diffLines = diff.split('\n').filter(l => l.startsWith('+') || l.startsWith('-')).length;
                } else if (action.tool === 'write_file') {
                    newContent = action.args['content'] || '';
                    diffLines = newContent.split('\n').length;
                }

                // Derive real confidence from agent behavior — no more hardcoded 0.8
                const modCount = this.fileModifications.get(targetPath) || 0;
                const hasReadFile = this.filesReadThisSession.has(targetPath);
                const confidence = DecisionEngine.deriveConfidence(hasReadFile, modCount, stepCount);

                const evaluation = this.decisionEngine.evaluate(
                    action.tool, targetPath, diffLines, confidence, newContent
                );
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
                // Wrap tool execution with safety timeout (90s default)
                result = await withTimeout(
                    () => this.executeTool(action, onStep, stepCount, this.tasklist),
                    90000,
                    `Tool:${action.tool}`
                );

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

            // Track files read/modified in both the local set AND the CognitiveState
            if (action.tool === 'read_file' && result.success && action.args['path']) {
                this.filesReadThisSession.add(action.args['path']);
                this.cognitiveState.recordFileRead(action.args['path']);
            }
            if ((action.tool === 'write_file' || action.tool === 'patch_file') && result.success && action.args['path']) {
                this.cognitiveState.recordFileModified(action.args['path']);
            }
            // Persist cognitive state to SQLite every step so crash recovery works
            this.cognitiveState.persist();

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

        WatchdogService.getInstance().unregister(this.sessionId);
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
