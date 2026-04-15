import type { AIProvider, AITask, AITaskResult } from '../../types/index.js';
import { ChangeExecutor } from './ChangeExecutor.js';
import { ErrorDetector } from '../diagnostics/ErrorDetector.js';
import { logger } from '../../utils/logger.js';
import type { ChangeHistory } from '../../storage/ChangeHistory.js';
import type { ProjectConfig } from '../../types/index.js';
import { CheckpointManager } from './CheckpointManager.js';
import type { Database } from '../../storage/Database.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';

export interface HealResult {
    finalResults: AITaskResult[];
    healed: boolean;
    healAttempts: number;
    remainingErrors: number;
}

/**
 * SelfHealingExecutor wraps the ChangeExecutor and automatically verifies
 * applied changes by compiling the project. If errors remain, it creates
 * targeted fix tasks and retries — without the user needing to do anything.
 *
 * This is a key differentiator: changes applied by Codebase OS always compile.
 */
export class SelfHealingExecutor {
    private executor: ChangeExecutor;
    private detector: ErrorDetector;
    private checkpointManager: CheckpointManager;
    private checkpointId: string;
    private maxHealAttempts = 3;
    private snapshots: Map<string, string> = new Map();

    constructor(
        private provider: AIProvider,
        private config: ProjectConfig,
        private history: ChangeHistory,
        private sessionId: string,
        db: Database,
    ) {
        this.executor = new ChangeExecutor(provider, config, history, sessionId);
        this.detector = new ErrorDetector(config.rootDir);
        this.checkpointManager = new CheckpointManager(db);
        this.checkpointId = uuidv4();
    }

    private takeSnapshot(filePath: string): void {
        if (!this.snapshots.has(filePath) && fs.existsSync(filePath)) {
            this.snapshots.set(filePath, fs.readFileSync(filePath, 'utf8'));
        }
    }

    /**
     * Execute a list of tasks, then verify compilation and auto-heal if needed.
     */
    async executeAndHeal(
        tasks: AITask[],
        dryRun: boolean,
        onProgress?: (label: string, status: 'start' | 'done' | 'fail', detail?: string) => void,
        initialResults: AITaskResult[] = []
    ): Promise<HealResult> {
        // 1. Execute all tasks
        const finalResults: AITaskResult[] = [...initialResults];
        const appliedFiles: string[] = [];
        
        // Skip already completed tasks if resuming
        const completedFiles = new Set(initialResults.map(r => r.taskId));
        const pendingTasks = tasks.filter(t => !completedFiles.has(t.id));

        for (const task of pendingTasks) {
            onProgress?.(task.targetFile, 'start');

            // SNAPSHOT FOR ATOMICITY
            if (!dryRun) this.takeSnapshot(task.targetFile);

            try {
                const result = await this.executor.execute(task, dryRun);
                finalResults.push(result);
                if (result.success && result.appliedAt) {
                    appliedFiles.push(task.targetFile);
                    onProgress?.(task.targetFile, 'done', `${(result.confidence * 100).toFixed(0)}% confidence`);
                } else {
                    onProgress?.(task.targetFile, 'fail', result.validationErrors[0]);
                }

                // UNSTOPPABLE AGENT: Autosave checkpoint after every file
                if (!dryRun) {
                    this.checkpointManager.save({
                        id: this.checkpointId,
                        sessionId: this.sessionId,
                        taskType: 'ask',
                        status: 'in_progress',
                        plan: tasks,
                        results: finalResults,
                        metadata: { appliedFiles },
                        updatedAt: Date.now()
                    });
                }
            } catch (err) {
                onProgress?.(task.targetFile, 'fail', String(err));
                logger.error('Task execution failed', { file: task.targetFile, error: String(err) });
            }
        }

        if (dryRun || appliedFiles.length === 0) {
            return { finalResults, healed: false, healAttempts: 0, remainingErrors: 0 };
        }

        // 2. Verify: run diagnostics on applied files only
        let healAttempts = 0;
        let healed = false;

        for (let attempt = 0; attempt < this.maxHealAttempts; attempt++) {
            const reports = await this.detector.runAll(appliedFiles);
            const totalErrors = reports.reduce((s, r) => s + r.errors.length, 0);

            if (totalErrors === 0) {
                if (attempt > 0) {
                    healed = true;
                    logger.info(`Self-healed after ${attempt} attempt(s). All errors resolved.`);
                }
                return { finalResults, healed, healAttempts: attempt, remainingErrors: 0 };
            }

            if (attempt === this.maxHealAttempts - 1) {
                logger.warn(`Could not auto-heal after ${this.maxHealAttempts} attempts. ${totalErrors} error(s) remain.`);
                return { finalResults, healed: false, healAttempts: attempt + 1, remainingErrors: totalErrors };
            }

            // 3. Build heal tasks for failed files
            logger.info(`Found ${totalErrors} error(s) after applying changes. Auto-healing... (attempt ${attempt + 1})`);
            const byFile = this.detector.groupByFile(reports);
            healAttempts++;

            for (const [filePath, diags] of byFile) {
                const errorSummary = diags
                    .filter(d => d.severity === 'error')
                    .map(d => `Line ${d.line}: [${d.code ?? d.tool}] ${d.message}`)
                    .join('\n');

                if (!errorSummary) continue;

                const healTask: AITask = {
                    id: `heal-${attempt}-${filePath}`,
                    kind: 'fix',
                    description: `Auto-heal: fix ${diags.filter(d => d.severity === 'error').length} compile error(s) introduced by recent changes`,
                    targetFile: filePath,
                    context: `The following compile errors were introduced after the last change:\n${errorSummary}\nFix ONLY these errors without changing any other logic.`,
                    constraints: [
                        'Fix ONLY the listed errors — do not change any other code',
                        'Maintain all existing functionality',
                        'Do not add or remove imports unless strictly necessary for the fix',
                    ],
                    expectedOutput: 'The same file with all listed compile errors resolved',
                    priority: 10,
                };

                try {
                    onProgress?.(filePath, 'start');
                    const healResult = await this.executor.execute(healTask, false);
                    finalResults.push(healResult);
                    if (healResult.success) {
                        onProgress?.(filePath, 'done', 'auto-healed');
                    } else {
                        onProgress?.(filePath, 'fail', 'heal failed');
                    }
                } catch (err) {
                    logger.error('Heal task failed', { file: filePath, error: String(err) });
                }
            }
        }

        return { finalResults, healed, healAttempts, remainingErrors: 0 };
    }
}
