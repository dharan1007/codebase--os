import type { AIProvider, RootCauseReport, Hypothesis } from '../../types/index.js';
import { StyleEngine } from './StyleEngine.js';
import { logger } from '../../utils/logger.js';
import { extractJSONFromAIOutput } from '../../utils/validation.js';

export class DesignOptimizer {
    constructor(
        private ai: AIProvider,
        private styleEngine: StyleEngine
    ) {}

    async optimize(failureReport: RootCauseReport): Promise<boolean> {
        logger.info('DesignOptimizer: Analyzing visual failure for token refinement...');

        const currentTokens = JSON.stringify(this.styleEngine.getTokens(), null, 2);
        
        const prompt = `You are a Lead Design Engineer and Token Architect. A visual failure has been detected by the Design Critic.

ROOT CAUSE ANALYSIS:
${failureReport.primaryCause}

PROPOSED HYPOTHESES:
${failureReport.hypotheses.map(h => `- ${h.description}`).join('\n')}

CURRENT DESIGN TOKENS:
${currentTokens}

YOUR MISSION:
Identify if this failure can be resolved by a global update to the Design Tokens. If so, provide the updated token values.

RESPOND WITH JSON:
{
  "requiresTokenUpdate": boolean,
  "updatedTokens": { ...Partial<DesignTokens>... },
  "reasoning": "string"
}`;

        try {
            const result = await this.ai.execute({
                taskType: 'analysis',
                priority: 'high',
                context: prompt,
                systemPrompt: 'You specialize in self-improving design systems and token architecture.',
                maxTokens: 1500
            });

            const parsed = extractJSONFromAIOutput(result.content) as any;

            if (parsed.requiresTokenUpdate && parsed.updatedTokens) {
                logger.info('DesignOptimizer: Applying global design token update...', { reason: parsed.reasoning });
                this.styleEngine.updateTokens(parsed.updatedTokens);
                return true;
            }
        } catch (err) {
            logger.error('Design optimization failed', { error: String(err) });
        }
        return false;
    }
}
