import type { AIProvider, Hypothesis, FailureSnapshot } from '../../types/index.js';
import { TestRunner } from '../diagnostics/TestRunner.js';
import { logger } from '../../utils/logger.js';
import fs from 'fs';
import path from 'path';

export class HypothesisEngine {
    constructor(
        private ai: AIProvider,
        private testRunner: TestRunner,
        private rootDir: string
    ) {}

    async rank(hypotheses: Hypothesis[], failure: FailureSnapshot): Promise<Hypothesis[]> {
        logger.info(`HypothesisEngine: Validating ${hypotheses.length} hypotheses...`);

        const scored: Hypothesis[] = [];
        const sandboxDir = path.join(this.rootDir, '.cos', 'sandbox');
        
        if (!fs.existsSync(sandboxDir)) {
            fs.mkdirSync(sandboxDir, { recursive: true });
        }

        for (const h of hypotheses) {
            const score = await this.validateHypothesis(h, failure, sandboxDir);
            scored.push({ ...h, score });
        }

        return scored.sort((a, b) => (b.score || 0) - (a.score || 0));
    }

    private async validateHypothesis(h: Hypothesis, failure: FailureSnapshot, sandboxDir: string): Promise<number> {
        try {
            // Simulation Logic: 
            // In a full implementation, we would copy the codebase to the sandbox.
            // For now, we perform a 'Dry Run' simulation via the AI or by running tests on affected files.
            
            logger.debug(`Simulating fix for hypothesis: ${h.id}`);
            
            // 1. Partial Build Verification
            // (Check if logicLines even compile if we were to apply them)
            
            // 2. AI Confidence Adjustment
            let score = h.confidence * 100;
            
            // 3. Impact Analysis
            if (h.impactLevel === 'systemic') {
                score += 10; // Favor systemic fixes for recurring issues
            }

            // 4. Test Run Simulation
            const results = await this.testRunner.runImpactedTests(failure.filePath);
            const passRate = results.length > 0 
                ? (results.filter(r => r.success).length / results.length) * 50
                : 25; // Neutral score if no tests found

            return Math.min(100, score + passRate);
        } catch (err) {
            logger.error('Hypothesis validation failed', { hypothesisId: h.id, error: String(err) });
            return 0;
        }
    }
}
