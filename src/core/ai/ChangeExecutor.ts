import type { AITask, AITaskResult, ProjectConfig } from '../../types/index.js';
import type { AIProvider } from '../../types/index.js';
import { ChangeValidator } from './ChangeValidator.js';
import { ChangeHistory } from '../../storage/ChangeHistory.js';
import { computeDiff, computeHash } from '../../utils/diff.js';
import { sanitizeAIOutput } from '../../utils/validation.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';

export class ChangeExecutor {
    private validator: ChangeValidator;

    constructor(
        private provider: AIProvider,
        private config: ProjectConfig,
        private history: ChangeHistory,
        private sessionId: string
    ) {
        this.validator = new ChangeValidator(config.rootDir);
    }

    async execute(task: AITask, dryRun = false): Promise<AITaskResult> {
        const originalContent = this.readFile(task.targetFile);

        const systemPrompt = `You are an expert software engineer implementing precise code changes.
You must output ONLY the complete, updated file content — no explanations, no markdown fences, no commentary.
The output must be production-ready, syntactically valid code.
Follow all constraints exactly. Do not introduce new bugs. Do not change unrelated code.`;

        const userPrompt = `Task: ${task.description}

Target file: ${task.targetFile}
Kind: ${task.kind}
Context: ${task.context}

Constraints:
${task.constraints.map(c => `- ${c}`).join('\n')}

Expected output description: ${task.expectedOutput}

Current file content:
${originalContent.slice(0, 6000)}

Output ONLY the complete updated file content. No markdown. No explanation. Raw code only.`;

        let updatedContent: string;
        let confidence = 0.8;

        try {
            const response = await this.provider.complete({
                systemPrompt,
                userPrompt,
                temperature: this.config.ai.temperature,
                maxTokens: this.config.ai.maxTokens,
            });

            updatedContent = sanitizeAIOutput(response.content);
            confidence = this.estimateConfidence(response.usage.outputTokens, originalContent, updatedContent);
        } catch (err) {
            const errorMsg = `AI execution failed: ${String(err)}`;
            logger.error(errorMsg, { task: task.id });
            return {
                taskId: task.id,
                success: false,
                filePath: task.targetFile,
                originalContent,
                updatedContent: originalContent,
                diff: '',
                confidence: 0,
                explanation: errorMsg,
                validationErrors: [errorMsg],
            };
        }

        const diff = computeDiff(originalContent, updatedContent, task.targetFile);

        let result: AITaskResult = {
            taskId: task.id,
            success: true,
            filePath: task.targetFile,
            originalContent,
            updatedContent,
            diff: diff.raw,
            confidence,
            explanation: task.description,
            validationErrors: [],
        };

        result = this.validator.validate(result);

        if (!dryRun && result.success && result.confidence >= 0.5) {
            this.applyChange(task.targetFile, updatedContent);

            const changeId = uuidv4();
            this.history.record({
                id: changeId,
                sessionId: this.sessionId,
                taskId: task.id,
                filePath: task.targetFile,
                originalContent,
                updatedContent,
                diff: diff.raw,
                appliedAt: Date.now(),
                provider: this.provider.kind,
                confidence: result.confidence,
            });

            result.appliedAt = Date.now();
            logger.info('Change applied', {
                file: task.targetFile,
                confidence: result.confidence,
                additions: diff.additions,
                deletions: diff.deletions,
            });
        }

        return result;
    }

    private readFile(filePath: string): string {
        try {
            return fs.readFileSync(filePath, 'utf8');
        } catch {
            return '';
        }
    }

    private applyChange(filePath: string, content: string): void {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, content, 'utf8');
    }

    private estimateConfidence(outputTokens: number, original: string, updated: string): number {
        if (updated.length === 0) return 0;
        if (updated === original) return 0.1;

        let confidence = 0.85;

        const ratio = updated.length / Math.max(original.length, 1);
        if (ratio < 0.5 || ratio > 2.0) confidence -= 0.15;

        if (outputTokens < 10) confidence -= 0.3;

        return Math.max(0.1, Math.min(1, confidence));
    }
}