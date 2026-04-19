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
import { DecisionEngine } from './DecisionEngine.js';
import { SandboxManager } from '../sandbox/SandboxManager.js';
import { ResponseCache } from '../context/ResponseCache.js';
import { LocalServer } from '../server/LocalServer.js';
import { EvalTracker } from '../eval/EvalTracker.js';
import { FailureManager } from '../diagnostics/FailureManager.js';
import { RootCauseAnalyzer } from '../failure/RootCauseAnalyzer.js';
import { FailureStore } from '../failure/FailureStore.js';
import { ChangeHistory } from '../../storage/ChangeHistory.js';
import { GitManager } from '../git/GitManager.js';
import { ResourceMonitor } from '../orchestrator/ResourceMonitor.js';
import ora from 'ora';
import path from 'path';

export interface AgentState {
    filesRead: string[];
    filesModified: string[];
    testsStatus: 'pass' | 'fail' | 'unknown';
    errorsRemaining: number;
}

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
    private maxSteps = 60;
    private steps: AgentStep[] = [];
    private filesWritten: string[] = [];
    private tasklist: string[] = [];
    private checkpointManager: CheckpointManager;
    private decisionEngine: DecisionEngine;
    private sandboxManager: SandboxManager;
    private responseCache: ResponseCache;
    private evalTracker: EvalTracker;
    private localServer: LocalServer;
    private fileModifications = new Map<string, number>();
    private startTime: number = 0;
    private failureManager: FailureManager;
    private rootCaseAnalyzer: RootCauseAnalyzer;

    constructor(
        private provider: AIProvider,
        private rootDir: string,
        private db: Database,
        private sessionId: string,
        private graph: RelationshipGraph,
        private store: GraphStore,
        failureIntelligence?: { manager: FailureManager, rca: RootCauseAnalyzer }
    ) {
        const failureStore = new FailureStore(db);
        const resourceMonitor = new ResourceMonitor(db);
        this.checkpointManager = new CheckpointManager(db);
        this.localServer = new LocalServer(failureStore, resourceMonitor);
        this.localServer.start();
        this.decisionEngine = new DecisionEngine(graph, this.localServer);
        this.sandboxManager = new SandboxManager(rootDir);
        this.responseCache = new ResponseCache(db);
        this.responseCache.init();
        this.evalTracker = new EvalTracker(db);
        this.evalTracker.init();

        // Failure Intelligence Initialization
        const history = new ChangeHistory(db);
        const gitManager = new GitManager(rootDir);

        this.failureManager = failureIntelligence?.manager || new FailureManager(db, history, failureStore);
        this.rootCaseAnalyzer = failureIntelligence?.rca || new RootCauseAnalyzer(provider, gitManager, graph);
        
        // Upgrade provider with cost-aware routing if not already wrapped
        // In a real system, the AIOrchestrator would already have the router.
    }

    async run(
        task: string,
        options: { 
            maxSteps?: number,
            onStep?: (step: number, action: any, result: any, tasklist: string[]) => Promise<void> | void,
            initialSteps?: AgentStep[],
            initialFiles?: string[],
            initialMessages?: any[]
        } = {}
    ): Promise<AgentResult> {
        if (options.maxSteps) this.maxSteps = options.maxSteps;
        const onStep = options.onStep;
        this.startTime = Date.now();
        
        this.steps = options.initialSteps || [];
        this.filesWritten = options.initialFiles || [];
        const messages: Array<{ role: 'user' | 'assistant', content: string }> = options.initialMessages || [];

        if (messages.length === 0) {
            const initialDiscovery = await this.performInitialDiscovery(task);
            const mergedUserPrompt = `TASK: ${task}\n\n[SOVEREIGN STRATEGY INFO]:\n${initialDiscovery}\n\nMaintain 100% build integrity. Begin.`;
            messages.push({ role: 'user', content: mergedUserPrompt });
        }

        let stepCount = this.steps.length;
        let lastSummary = 'Agent paused.';
        let actionsThisCycle = 0;

        while (stepCount < this.maxSteps) {
            if (actionsThisCycle >= 5) {
                messages.push({ role: 'user', content: '[TOOL BUDGET EXCEEDED]: You have performed 5 actions in this continuous execution cycle. Please pause and ask the user for confirmation before proceeding.' });
                actionsThisCycle = 0;
            }
            
            stepCount++;
            actionsThisCycle++;

            // [SOVEREIGN MEMORY]: Retain last 3 architectural turns for consistency
            if (messages.length > 10) {
                const recent = messages.slice(-4);
                const recap = `RECAP: Goal - ${task}. Progress - ${this.tasklist.join(', ') || 'Exploring'}. Step count: ${stepCount - 1}.`;
                messages.splice(0, messages.length, { role: 'user', content: recap }, ...recent);
            }

            let response: string = '';
            try {
                const systemPrompt = PromptTemplates.agentSystemPrompt(this.rootDir);
                const prompt = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
                const queryHash = ResponseCache.hashQuery(systemPrompt, prompt);
                
                const cached = this.responseCache.get(queryHash);
                if (cached) {
                    response = cached;
                    logger.info('Agent Loop: Cache hit on tool completion');
                } else {
                    const result = await this.provider.execute({
                        taskType: 'reasoning',
                        priority: 'high',
                        context: prompt,
                        systemPrompt,
                        maxTokens: 4000,
                    });
                    response = result.content;
                    this.responseCache.set(queryHash, 'planning', response);
                }
                
                messages.push({ role: 'assistant', content: response });
            } catch (err: any) {
                if (err.message.includes('Quota')) return this.finalize(lastSummary, stepCount, false, messages, true);
                if (err.message.includes('Outage')) return this.finalize(lastSummary, stepCount, true, messages);
                logger.error('Agent loop failed', { error: String(err) });
                break;
            }

            let action: AgentAction;
            try {
                action = extractJSONFromAIOutput(response) as AgentAction;
                if ((action as any).tasklist) this.tasklist = (action as any).tasklist;
            } catch (err: any) {
                messages.push({ role: 'user', content: `[SYSTEM REPAIR ERROR]: Output failed to parse as JSON (${err.message}). Repair Instruction: Ensure you output strictly valid JSON matching the { "tool": "xyz", "args": {...}, "reasoning": "xyz" } schema without surrounding markdown blocks.` });
                continue;
            }

            if (action.tool === 'finish') {
                lastSummary = action.args['summary'] ?? 'Task refined and completed.';
                break;
            }

            // [AUGMENTED INTELLIGENCE]: Decision Engine Evaluation
            let allowed = true;
            let stagingLog = '';
            
            if (['write_file', 'delete_file', 'run_shell'].includes(action.tool)) {
                const targetPath = action.args['path'] || action.args['oldPath'] || action.args['command'] || '';
                
                if (action.tool === 'write_file') {
                    const modCount = (this.fileModifications.get(targetPath) || 0) + 1;
                    this.fileModifications.set(targetPath, modCount);
                    if (modCount >= 3) {
                        messages.push({ role: 'user', content: `[CONVERGENCE ALARM]: You have modified ${targetPath} ${modCount} times without apparent success. Your execution is oscillating. Stop modifying this file. Re-evaluate your approach or ask the user for help.` });
                        this.saveCheckpoint(messages);
                        continue;
                    }
                }
                
                // Estimate diff lines for write_file
                let diffLines = 0;
                if (action.tool === 'write_file') {
                    try {
                        const fs = await import('fs');
                        const oldContent = fs.readFileSync(path.join(this.rootDir, targetPath), 'utf8');
                        diffLines = (action.args['content']?.split('\n').length || 0) - oldContent.split('\n').length;
                    } catch {
                        diffLines = action.args['content']?.split('\n').length || 0;
                    }
                }
                
                // Assume default confidence of 0.8 for generic tool use
                const evaluation = this.decisionEngine.evaluate(action.tool, targetPath, diffLines, 0.8);
                allowed = await this.decisionEngine.enforce(action.tool, targetPath, evaluation);
                
                if (evaluation.riskLevel === 'medium') stagingLog = `\n[STAGED]: ${evaluation.reasoning}`;
            }

            if (!allowed) {
                messages.push({ role: 'user', content: 'Action denied by Human/DecisionEngine. Please replan your approach or ask for clarification.' });
                this.saveCheckpoint(messages);
                continue;
            }

            let result: ToolResult;
            try {
                result = await this.executeTool(action, onStep, stepCount, this.tasklist);
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
                            contextBefore: '', // Will be grabbed from store inside RCA
                            timestamp: Date.now(),
                            frequency: 3
                        });
                        
                        messages.push({ 
                            role: 'user', 
                            content: `[ROOT CAUSE ANALYSIS]: ${rcaReport.primaryCause}\n[SYSTEMIC HYPOTHESES]:\n${rcaReport.hypotheses.map(h => `- ${h.description} (Confidence: ${h.confidence})`).join('\n')}\n\nRe-plan using these systemic insights.` 
                        });
                    }
                }
            } catch (err: any) {
                const report = await this.failureManager.handleFailure('runtime_crash', action.args['path'] || 'unknown', err.message);
                result = { success: false, output: '', error: err.message };
            }

            this.steps.push({ step: stepCount, action, result });
            if (onStep) await onStep(stepCount, action, result, this.tasklist);

            const agentState: AgentState = {
                filesRead: [...new Set(this.steps.filter(s => s.action.tool === 'read_file').map(s => s.action.args['path'] ?? ''))],
                filesModified: this.filesWritten,
                testsStatus: 'unknown',
                errorsRemaining: 0
            };

            let toolMsg = `[STATE UPDATE]\nFiles Read: ${agentState.filesRead.join(', ')}\nFiles Modified: ${agentState.filesModified.join(', ')}\n\nTool result: ${result.output || result.error || 'Empty'}`;
            if (stagingLog) toolMsg += stagingLog;
            
            messages.push({ role: 'user', content: `${toolMsg}\nVerify build and map your next move using the state above.` });
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
            .sort((a,b) => {
                const getImpactScore = (node: any) => {
                    const deps = Array.from(this.graph.reverseAdjacency.get(node.id) || []);
                    let score = 0;
                    for (const depId of deps) {
                        const edges = this.graph.getIncomingEdges(node.id).filter(e => e.sourceId === depId);
                        let edgeWeightSum = 0;
                        for (const e of edges) {
                            if (e.kind === 'calls' || e.kind === 'reads_from') edgeWeightSum += 2.0;
                            else if (e.kind === 'tests') edgeWeightSum += 3.0; // test coverage importance
                            else edgeWeightSum += 1.0;
                        }
                        score += edgeWeightSum;
                    }
                    return score;
                };
                return getImpactScore(b) - getImpactScore(a);
            });
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

    private async finalize(
        lastSummary: string,
        stepCount: number,
        outageDetected: boolean = false,
        messages: any[] = [],
        quotaReached: boolean = false
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
            quotaReached
        };

        const tokensUsed = messages.reduce((acc, m) => acc + (m.content.length / 4), 0);
        this.evalTracker.trackSession(this.sessionId, 'code', this.startTime, result, tokensUsed, this.provider.kind, 'agent-loop-model');

        return result;
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
                    return await this.sandboxManager.execute(action.args['command'] ?? '', false, (chunk) => {
                        onStep?.(stepCount, action, { success: true, output: chunk, isStreaming: true }, tasklist);
                    });
                }
                default: return { success: false, output: '', error: `Unknown tool: ${action.tool}` };
            }
        } catch (err) { return { success: false, output: '', error: String(err) }; }
    }
}
