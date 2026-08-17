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
import { v4 as uuidv4 } from 'uuid';
import { AgentController, type AgentBudget } from './AgentController.js';
import { ContextManager } from '../context/ContextManager.js';
import { ModelRegistry } from './ModelRegistry.js';
import { WatchdogService } from '../orchestrator/WatchdogService.js';
import { withTimeout } from '../../utils/TimeoutWrapper.js';

export interface AgentState {
    filesRead: string[];
    filesModified: string[];
    testsStatus: 'pass' | 'fail' | 'unknown';
    errorsRemaining: number;
}

export interface AgentAction {
    tool: 'read_file' | 'write_file' | 'patch_file' | 'delete_file' | 'move_file' | 'list_files' | 'run_shell' | 'search_code' | 'find_references' | 'pause_and_ask' | 'finish';
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
    verified: boolean;
    steps: AgentStep[];
    summary: string;
    filesWritten: string[];
    totalSteps: number;
    tasklist: string[];
    verificationCommands: string[];
    outageDetected?: boolean;
    quotaReached?: boolean;
}

interface AgentMessage {
    role: 'user' | 'assistant';
    content: string;
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
    private startTime = 0;
    private failureManager: FailureManager;
    private rootCaseAnalyzer: RootCauseAnalyzer;
    private cognitiveState: CognitiveState;
    private controller: AgentController;
    private contextManager: ContextManager;
    private changeHistory: ChangeHistory;
    private currentTask = '';
    private lastMutationStep = 0;
    private lastVerificationStep = 0;
    private verificationCommands: string[] = [];

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

        this.changeHistory = new ChangeHistory(db);
        const gitManager = new GitManager(rootDir);
        this.failureManager = failureIntelligence?.manager || new FailureManager(db, this.changeHistory, failureStore);
        this.rootCaseAnalyzer = failureIntelligence?.rca || new RootCauseAnalyzer(provider, gitManager, graph);

        const budget: AgentBudget = {
            maxSteps: 60,
            maxTokens: 500000,
            maxCost: 2.0,
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
            initialMessages?: AgentMessage[];
        } = {}
    ): Promise<AgentResult> {
        this.currentTask = task;
        if (options.maxSteps) this.maxSteps = options.maxSteps;
        const onStep = options.onStep;
        this.startTime = Date.now();

        WatchdogService.getInstance().register(this.sessionId);

        this.steps = options.initialSteps ?? [];
        this.filesWritten = options.initialFiles ?? [];
        const messages: AgentMessage[] = options.initialMessages ? [...options.initialMessages] : [];
        this.restoreExecutionEvidenceFromSteps();

        if (messages.length === 0) {
            const bootstrapContext = await this.buildBootstrapContext(task);
            const isDesignTask = /ui|style|css|aesthetic|design|layout|frontend/i.test(task);
            const designGuidance = isDesignTask ? `\n\n[DESIGN GUIDELINES]:\n${PromptTemplates.designPrinciples()}` : '';

            const seedPrompt =
                `TASK: ${task}\n\n` +
                `[CODEBASE CONTEXT — read these files before making any changes]:\n${bootstrapContext}\n\n` +
                designGuidance +
                `RULE: For any EXISTING file, emit patch_file with a unified diff. ` +
                `For NEW files, emit write_file with full content. ` +
                `After the final mutation, run an appropriate successful build/test/typecheck/lint command before requesting finish. ` +
                `Begin with read_file or list_files to confirm your understanding.`;
            messages.push({ role: 'user', content: seedPrompt });
        }

        let stepCount = this.steps.length;
        let lastSummary = 'Agent stopped before verified completion.';
        let completed = false;

        while (stepCount < this.maxSteps) {
            try {
                this.controller.checkpoint();
                WatchdogService.getInstance().pulse(this.sessionId, 'EXECUTING');
            } catch (err: any) {
                lastSummary = `Budget halted execution: ${err.message}`;
                logger.error(`[AgentLoop] ${lastSummary}`);
                break;
            }

            stepCount++;

            const compressibleMessages = messages.slice(
                AgentLoop.SEED_MESSAGES,
                Math.max(AgentLoop.SEED_MESSAGES, messages.length - AgentLoop.RECENT_WINDOW),
            );
            const cognitiveHeader = await this.cognitiveState.tick(
                stepCount,
                compressibleMessages,
                task,
                summary => logger.debug('CognitiveState compressed', { summaryLen: summary.length }),
            );

            // Do not append the generated cognitive header to durable conversation
            // history every step; inject it only into this request to avoid summary
            // headers recursively bloating future context.
            const regulatedMessages = this.contextManager.regulate([
                ...messages,
                { role: 'user', content: cognitiveHeader },
            ] as any);

            let response = '';
            let orchestratorAttempts = 0;
            const maxOrchestratorAttempts = 3;

            while (orchestratorAttempts < maxOrchestratorAttempts) {
                try {
                    const systemPrompt = PromptTemplates.agentSystemPrompt(this.rootDir);
                    const providerResult = await this.provider.execute({
                        taskType: 'reasoning',
                        priority: 'high',
                        context: regulatedMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n'),
                        systemPrompt,
                        maxTokens: 4000,
                    });

                    response = providerResult.content;
                    this.controller.recordUsage(providerResult.usage.totalTokens, 0);
                    messages.push({ role: 'assistant', content: response });
                    break;
                } catch (err: any) {
                    orchestratorAttempts++;
                    const errorText = String(err?.message ?? err);
                    const isQuota = /quota|429|rate.?limit/i.test(errorText);

                    if (orchestratorAttempts >= maxOrchestratorAttempts) {
                        if (isQuota) {
                            return this.finalize(
                                `Provider quota/rate limit interrupted the task: ${errorText}`,
                                stepCount,
                                false,
                                messages,
                                false,
                                true,
                            );
                        }
                        logger.error('[AgentLoop] Provider execution exhausted retries.', { error: errorText });
                        return this.finalize(
                            `Provider execution failed: ${errorText}`,
                            stepCount,
                            false,
                            messages,
                            true,
                            false,
                        );
                    }

                    const delay = isQuota ? 10000 : 3000;
                    logger.warn(`[AgentLoop] Provider retry ${orchestratorAttempts}/${maxOrchestratorAttempts} after ${delay}ms.`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }

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
                        `Output ONLY valid JSON matching ` +
                        `{ "tool": "<tool_name>", "args": { ... }, "reasoning": "...", "tasklist": [...] }.\n` +
                        `Valid tools: read_file, write_file, patch_file, delete_file, move_file, list_files, run_shell, search_code, find_references, pause_and_ask, finish.`,
                });
                continue;
            }

            const actionKey = `${action.tool}:${JSON.stringify(action.args)}`;
            const actionCount = (this.actionRepetition.get(actionKey) ?? 0) + 1;
            this.actionRepetition.set(actionKey, actionCount);
            if (actionCount >= 3) {
                messages.push({
                    role: 'user',
                    content:
                        `[STAGNATION ALERT]: "${action.tool}" was repeated with identical arguments ${actionCount} times. ` +
                        `Do not repeat it. Read different evidence, search the codebase, or ask for input.`,
                });
                this.actionRepetition.set(actionKey, 0);
                continue;
            }

            if (action.tool === 'finish') {
                lastSummary = action.args['summary'] ?? 'Task completed.';
                if (this.filesWritten.length > 0 && this.lastVerificationStep < this.lastMutationStep) {
                    messages.push({
                        role: 'user',
                        content:
                            '[VERIFICATION REQUIRED]: Code changed after the most recent successful verification. ' +
                            'Run an appropriate build, test, typecheck, lint, or language-specific verification command. ' +
                            'The runtime will not mark this task successful until that evidence exists.',
                    });
                    this.saveCheckpoint(messages);
                    continue;
                }
                completed = true;
                break;
            }

            let allowed = true;
            if (['write_file', 'patch_file', 'delete_file', 'run_shell'].includes(action.tool)) {
                const targetPath = action.args['path'] || action.args['oldPath'] || action.args['command'] || '';

                if (action.tool === 'write_file' || action.tool === 'patch_file') {
                    const modCount = (this.fileModifications.get(targetPath) ?? 0) + 1;
                    this.fileModifications.set(targetPath, modCount);
                    if (modCount >= 4) {
                        messages.push({
                            role: 'user',
                            content:
                                `[CONVERGENCE ALARM]: "${targetPath}" has been modified ${modCount} times. ` +
                                'Re-read it and change strategy before modifying it again.',
                        });
                        this.saveCheckpoint(messages);
                        continue;
                    }
                }

                let diffLines = 0;
                let newContent: string | undefined;
                if (action.tool === 'patch_file') {
                    diffLines = (action.args['diff'] ?? '').split('\n')
                        .filter(line => (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---')))
                        .length;
                } else if (action.tool === 'write_file') {
                    newContent = action.args['content'] ?? '';
                    diffLines = newContent.split('\n').length;
                }

                const modCount = this.fileModifications.get(targetPath) ?? 0;
                const confidence = DecisionEngine.deriveConfidence(
                    this.filesReadThisSession.has(targetPath),
                    modCount,
                    stepCount,
                );
                const evaluation = this.decisionEngine.evaluate(
                    action.tool,
                    targetPath,
                    diffLines,
                    confidence,
                    newContent,
                );
                allowed = await this.decisionEngine.enforce(action.tool, targetPath, evaluation);
            }

            if (!allowed) {
                messages.push({ role: 'user', content: 'Action denied by safety guard. Re-plan your approach.' });
                this.saveCheckpoint(messages);
                continue;
            }

            let result: ToolResult;
            let diffOutput: string | undefined;
            try {
                result = await withTimeout(
                    () => this.executeTool(action, onStep, stepCount, this.tasklist),
                    90000,
                    `Tool:${action.tool}`,
                );

                if (result.success && action.tool === 'patch_file') {
                    diffOutput = action.args['diff'];
                }

                if (!result.success) {
                    const report = await this.failureManager.handleFailure(
                        'runtime_crash',
                        action.args['path'] || 'unknown',
                        result.error || 'Unknown tool failure',
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
                                rcaReport.hypotheses.map(h => `- ${h.description} (confidence ${h.confidence})`).join('\n') +
                                '\n\nRe-plan using this evidence.',
                        });
                    }
                }
            } catch (err: any) {
                await this.failureManager.handleFailure(
                    'runtime_crash',
                    action.args['path'] || 'unknown',
                    String(err?.message ?? err),
                );
                result = { success: false, output: '', error: String(err?.message ?? err) };
            }

            this.steps.push({ step: stepCount, action, result });
            this.updateExecutionEvidence(stepCount, action, result);

            if (action.tool === 'read_file' && result.success && action.args['path']) {
                this.filesReadThisSession.add(action.args['path']);
                this.cognitiveState.recordFileRead(action.args['path']);
            }
            if ((action.tool === 'write_file' || action.tool === 'patch_file') && result.success && action.args['path']) {
                this.cognitiveState.recordFileModified(action.args['path']);
            }
            this.cognitiveState.persist();

            if (onStep) await onStep(stepCount, action, result, this.tasklist, diffOutput);
            this.localServer.emitStep({ step: stepCount, action, result });

            const agentState: AgentState = {
                filesRead: [...new Set(this.steps
                    .filter(step => step.action.tool === 'read_file')
                    .map(step => step.action.args['path'] ?? ''))],
                filesModified: this.filesWritten,
                testsStatus: this.lastVerificationStep >= this.lastMutationStep && this.lastVerificationStep > 0
                    ? 'pass'
                    : 'unknown',
                errorsRemaining: 0,
            };

            const toolMsg =
                `[TOOL RESULT — Step ${stepCount}]\n` +
                `Tool: ${action.tool} | Target: ${action.args['path'] || action.args['command'] || action.args['dir'] || '(none)'}\n` +
                `Status: ${result.success ? 'SUCCESS' : 'FAILED'}\n` +
                `Output: ${(result.output || result.error || 'empty').slice(0, 800)}\n\n` +
                `Files read so far: [${agentState.filesRead.slice(-5).join(', ')}]\n` +
                `Files modified so far: [${agentState.filesModified.join(', ')}]\n` +
                `Verification status: ${agentState.testsStatus}.\n` +
                'Determine the next action.';

            messages.push({ role: 'user', content: toolMsg });
            this.saveCheckpoint(messages);
            await new Promise(resolve => setTimeout(resolve, 250));
        }

        if (!completed && stepCount >= this.maxSteps) {
            lastSummary = `Maximum step budget (${this.maxSteps}) reached before verified completion.`;
        }

        return this.finalize(lastSummary, stepCount, completed, messages);
    }

    private async buildBootstrapContext(task: string): Promise<string> {
        const sections: string[] = [];

        try {
            const memory = new SessionMemory(this.db, this.rootDir);
            const loaded = memory.load(5);
            if (loaded.formatted) sections.push(loaded.formatted);
        } catch {
            // Fresh projects legitimately have no durable memory yet.
        }

        if (this.graph.nodes.size > 0) {
            try {
                const planner = new TopologicalPlanner(this.graph, this.rootDir);
                const report = planner.planFromTask(task);
                if (report.totalFiles > 0) {
                    const planLines = [
                        '=== DEPENDENCY-FIRST EXECUTION PLAN ===',
                        `Blast radius: ${report.totalFiles} files across ${Object.keys(report.layerBreakdown).join(', ')} layers.`,
                        'Use this dependency order unless new evidence requires re-planning:',
                        ...report.affectedFiles.map(file =>
                            `  [${file.executionOrder}] ${file.relativePath} [${file.layer}]` +
                            `${file.isRoot ? ' (ROOT)' : ''}` +
                            `${file.dependentCount >= 5 ? ` hub(${file.dependentCount} dependents)` : ''}`,
                        ),
                    ];
                    if (report.crossLayerWarnings.length > 0) {
                        planLines.push('', 'Architecture warnings:');
                        for (const warning of report.crossLayerWarnings) planLines.push(`  [!] ${warning}`);
                    }
                    if (report.cycles.length > 0) {
                        planLines.push('', 'Dependency cycles require explicit handling:');
                        for (const cycle of report.cycles) planLines.push(`  [cycle] ${cycle}`);
                    }
                    planLines.push('=== END PLAN ===');
                    sections.push(planLines.join('\n'));
                }
            } catch {
                // A disconnected/partial graph should degrade discovery, not crash the agent.
            }
        }

        const hubFiles = this.getHubFiles(task);
        const fileSnippets: string[] = [];
        for (const relativePath of hubFiles.slice(0, 5)) {
            const absolutePath = path.resolve(this.rootDir, relativePath);
            try {
                const content = fs.readFileSync(absolutePath, 'utf8');
                fileSnippets.push(
                    `=== ${relativePath} ===\n${content.split('\n').slice(0, 120).join('\n')}`,
                );
            } catch {
                // File may have been removed since the graph snapshot.
            }
        }
        if (fileSnippets.length > 0) {
            sections.push(`=== RELEVANT FILE CONTENTS ===\n${fileSnippets.join('\n\n---\n\n')}\n=== END FILE CONTENTS ===`);
        }

        const dirResult = await listFilesTool('.', this.rootDir);
        const dirTree = dirResult.success ? dirResult.output.split('\n').slice(0, 50).join('\n') : '(structure unavailable)';
        sections.push(`=== PROJECT STRUCTURE ===\n${dirTree}\n=== END STRUCTURE ===`);

        return sections.join('\n\n');
    }

    private getHubFiles(task: string): string[] {
        if (this.graph.nodes.size === 0) return [];
        const keywords = task.toLowerCase().split(/\s+/).filter(word => word.length > 3);
        const nodes = Array.from(this.graph.nodes.values())
            .filter(node => keywords.some(keyword =>
                node.name.toLowerCase().includes(keyword) || node.filePath.toLowerCase().includes(keyword),
            ))
            .sort((a, b) => {
                const score = (node: any) => this.graph.getIncomingEdges(node.id).length;
                return score(b) - score(a);
            });

        const seen = new Set<string>();
        const files: string[] = [];
        for (const node of nodes) {
            const relative = path.relative(this.rootDir, node.filePath);
            if (seen.has(relative)) continue;
            seen.add(relative);
            files.push(relative);
            if (files.length >= 8) break;
        }
        return files;
    }

    private saveCheckpoint(messages: AgentMessage[], status: 'in_progress' | 'paused' = 'in_progress'): void {
        this.checkpointManager.save({
            id: this.sessionId,
            sessionId: this.sessionId,
            taskType: 'agent',
            status,
            plan: [{
                id: 'agent-main',
                kind: 'refactor',
                description: this.currentTask,
                targetFile: '.',
                context: '',
                constraints: [],
                expectedOutput: '',
                priority: 1,
            }],
            results: [],
            metadata: {
                task: this.currentTask,
                steps: this.steps,
                filesWritten: this.filesWritten,
                messages,
                lastMutationStep: this.lastMutationStep,
                lastVerificationStep: this.lastVerificationStep,
                verificationCommands: this.verificationCommands,
            },
            updatedAt: Date.now(),
        });
    }

    private async finalize(
        summary: string,
        stepCount: number,
        completed: boolean,
        messages: AgentMessage[] = [],
        outageDetected = false,
        quotaReached = false,
    ): Promise<AgentResult> {
        WatchdogService.getInstance().unregister(this.sessionId);
        this.localServer.stop();

        const verified = this.filesWritten.length === 0 ||
            (this.lastVerificationStep >= this.lastMutationStep && this.lastVerificationStep > 0);
        const success = completed && verified && !outageDetected && !quotaReached;

        const result: AgentResult = {
            success,
            verified,
            summary,
            steps: this.steps,
            filesWritten: this.filesWritten,
            totalSteps: stepCount,
            tasklist: this.tasklist,
            verificationCommands: [...this.verificationCommands],
            outageDetected,
            quotaReached,
        };

        if (success) {
            this.checkpointManager.markFinished(this.sessionId);
        } else {
            this.saveCheckpoint(messages, 'paused');
        }

        const tokensUsed = messages.reduce((acc, message) => acc + message.content.length / 4, 0);
        this.evalTracker.trackSession(
            this.sessionId,
            'code',
            this.startTime,
            result,
            tokensUsed,
            this.provider.kind,
            'agent-loop-model',
        );
        return result;
    }

    private updateExecutionEvidence(step: number, action: AgentAction, result: ToolResult): void {
        if (!result.success) return;

        if (['write_file', 'patch_file', 'delete_file', 'move_file'].includes(action.tool)) {
            this.lastMutationStep = step;
        }

        if (action.tool === 'run_shell') {
            const command = action.args['command'] ?? '';
            if (this.isVerificationCommand(command)) {
                this.lastVerificationStep = step;
                this.verificationCommands.push(command);
            }
        }
    }

    private restoreExecutionEvidenceFromSteps(): void {
        this.lastMutationStep = 0;
        this.lastVerificationStep = 0;
        this.verificationCommands = [];
        this.filesReadThisSession.clear();

        for (const step of this.steps) {
            if (!step.result.success) continue;
            if (step.action.tool === 'read_file' && step.action.args['path']) {
                this.filesReadThisSession.add(step.action.args['path']);
            }
            this.updateExecutionEvidence(step.step, step.action, step.result);
        }
    }

    private isVerificationCommand(command: string): boolean {
        const normalized = command.trim().toLowerCase();
        const patterns = [
            /^npm\s+(test|run\s+(test|build|typecheck|lint|check|verify))(\s|$)/,
            /^(pnpm|yarn|bun)\s+(test|build|typecheck|lint|check|verify)(\s|$)/,
            /^npx\s+(tsc|eslint|jest|vitest)(\s|$)/,
            /^(pytest|python\s+-m\s+pytest)(\s|$)/,
            /^go\s+test(\s|$)/,
            /^cargo\s+(test|check|clippy)(\s|$)/,
            /^(mvn|gradle)\s+.*\b(test|check|verify|build)\b/,
            /^dotnet\s+(test|build)(\s|$)/,
            /^(swift|flutter|dart)\s+test(\s|$)/,
        ];
        return patterns.some(pattern => pattern.test(normalized));
    }

    private async executeTool(
        action: AgentAction,
        onStep: any,
        stepCount: number,
        tasklist: string[],
    ): Promise<ToolResult> {
        try {
            switch (action.tool) {
                case 'read_file':
                    return await readFileTool(action.args['path'] ?? '', this.rootDir);

                case 'write_file': {
                    const target = action.args['path'] ?? '';
                    const absolute = path.resolve(this.rootDir, target);
                    const result = await writeFileTool(target, action.args['content'] ?? '', this.rootDir);
                    if (result.success) {
                        if (!this.filesWritten.includes(target)) this.filesWritten.push(target);
                        const updated = fs.readFileSync(absolute, 'utf8');
                        this.recordChange(stepCount, target, '', updated);
                    }
                    return result;
                }

                case 'patch_file': {
                    const target = action.args['path'] ?? '';
                    const absolute = path.resolve(this.rootDir, target);
                    let original = '';
                    try { original = fs.readFileSync(absolute, 'utf8'); } catch { /* tool will return a precise error */ }

                    const result = await patchFileTool(target, action.args['diff'] ?? '', this.rootDir);
                    if (result.success) {
                        if (!this.filesWritten.includes(target)) this.filesWritten.push(target);
                        const updated = fs.readFileSync(absolute, 'utf8');
                        this.recordChange(stepCount, target, original, updated);
                    }
                    return result;
                }

                case 'delete_file':
                    return await deleteFileTool(action.args['path'] ?? '', this.rootDir);

                case 'move_file':
                    return await moveFileTool(
                        action.args['oldPath'] ?? '',
                        action.args['newPath'] ?? '',
                        this.rootDir,
                    );

                case 'list_files':
                    return await listFilesTool(action.args['dir'] ?? '.', this.rootDir);

                case 'search_code':
                    return await searchCodeTool(action.args['query'] ?? '', this.rootDir);

                case 'find_references':
                    return await findReferencesTool(action.args['symbol'] ?? '', this.rootDir);

                case 'run_shell':
                    return await this.sandboxManager.execute(
                        action.args['command'] ?? '',
                        false,
                        chunk => onStep?.(
                            stepCount,
                            action,
                            { success: true, output: chunk, isStreaming: true },
                            tasklist,
                        ),
                    );

                default:
                    return { success: false, output: '', error: `Unknown tool: ${action.tool}` };
            }
        } catch (err) {
            return { success: false, output: '', error: String(err) };
        }
    }

    private recordChange(stepCount: number, relativePath: string, original: string, updated: string): void {
        if (original === updated) return;
        const absolutePath = path.resolve(this.rootDir, relativePath);
        const diff = computeDiff(original, updated, relativePath).raw;

        this.changeHistory.record({
            id: uuidv4(),
            sessionId: this.sessionId,
            taskId: `agent-step-${stepCount}`,
            filePath: absolutePath,
            originalContent: original,
            updatedContent: updated,
            diff,
            appliedAt: Date.now(),
            provider: this.provider.kind,
            // This field historically represented model confidence. For direct
            // file-tool transactions, 1 means only that the write was confirmed,
            // not that the code is semantically correct; semantic completion is
            // separately gated by verification evidence.
            confidence: 1,
        });
    }
}
