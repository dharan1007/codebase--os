import type { AIProvider, FailureSnapshot } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import fs from 'fs';
import path from 'path';

export class RegressionGuard {
    constructor(
        private ai: AIProvider,
        private rootDir: string
    ) {}

    async generatePreventionTest(failure: FailureSnapshot, solutionDescription: string): Promise<string | null> {
        logger.info('RegressionGuard: Generating prevention test...', { failureId: failure.id });

        const testFilePath = this.determineTestPath(failure.filePath);
        
        const prompt = `You are a Senior QA Automation Engineer. Generate a Jest test to prevent a regression of the following failure.

FAILURE:
Message: ${failure.message}
Target File: ${failure.filePath}
Solution Applied: ${solutionDescription}

CODE CONTEXT:
${failure.contextBefore}

Generate a standalone Jest test file that reproduces the failure condition and verifies the fix. Respond with ONLY the code for the test file.`;

        try {
            const result = await this.ai.execute({
                taskType: 'simple',
                priority: 'medium',
                context: prompt,
                systemPrompt: 'You generate high-quality Jest tests for regression prevention.',
                maxTokens: 1500
            });

            const testCode = result.content.replace(/```typescript/g, '').replace(/```/g, '').trim();
            
            if (testCode.length > 50) {
                fs.writeFileSync(testFilePath, testCode);
                logger.info(`RegressionGuard: Created prevention test at ${testFilePath}`);
                return testFilePath;
            }
        } catch (err) {
            logger.error('Failed to generate regression test', { error: String(err) });
        }
        return null;
    }

    private determineTestPath(filePath: string): string {
        const base = path.basename(filePath, path.extname(filePath));
        const dir = path.dirname(filePath);
        return path.join(dir, `${base}.regression.test.ts`);
    }
}
