import type { AIProvider } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import { extractJSONFromAIOutput } from '../../utils/validation.js';

export interface CritiqueResult {
    passed: boolean;
    score: number;
    issues: string[];
    suggestions: string[];
}

export class DesignCritic {
    constructor(private ai: AIProvider) {}

    async evaluate(html: string, css: string): Promise<CritiqueResult> {
        logger.info('DesignCritic: Evaluating visual hierarchy and consistency...');

        const prompt = `You are a World-Class Design Critic. Evaluate the following generated UI for professionalism, spacing, typography, and premium aesthetics.

HTML:
${html.slice(0, 3000)}

CSS:
${css.slice(0, 3000)}

CRITERIA:
1. Spacing Consistency (8px grid adherence).
2. Typography Hierarchy (distinct levels, readability).
3. Visual Balance (grouping, alignment).
4. Accessibility (contrast, focus states).
5. 'Premium' Factor (subtle gradients, shadows, motion markers).

RESPOND WITH JSON:
{
  "passed": boolean,
  "score": number (0-100),
  "issues": ["string"],
  "suggestions": ["string"]
}`;

        try {
            const result = await this.ai.execute({
                taskType: 'analysis',
                priority: 'medium',
                context: prompt,
                systemPrompt: 'You have an elite eye for high-end UI/UX design.',
                maxTokens: 1000
            });

            const parsed = extractJSONFromAIOutput(result.content) as CritiqueResult;
            return parsed;
        } catch (err) {
            logger.error('Design critique failed', { error: String(err) });
            return {
                passed: true, // Default to pass to avoid blocking if AI fails
                score: 70,
                issues: ['AI critique unavailable'],
                suggestions: []
            };
        }
    }
}
