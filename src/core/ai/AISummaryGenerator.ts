import type { ImpactReport, SyncReport } from '../../types/index.js';
import type { AIProvider } from '../../types/index.js';
import { PromptTemplates } from './PromptTemplates.js';
import { extractJSONFromAIOutput } from '../../utils/validation.js';
import { logger } from '../../utils/logger.js';

export interface ImpactSummary {
    headline: string;
    keyRisks: string[];
    prioritizedActions: string[];
    estimatedEffort: 'small' | 'medium' | 'large';
}

export class AISummaryGenerator {
    constructor(private provider: AIProvider) { }

    async summarizeImpact(report: ImpactReport): Promise<ImpactSummary | null> {
        if (report.impactedNodes.length === 0) {
            return {
                headline: 'No downstream impact detected',
                keyRisks: [],
                prioritizedActions: [],
                estimatedEffort: 'small',
            };
        }

        try {
            const response = await this.provider.complete({
                systemPrompt: PromptTemplates.systemImpactAnalyzer(),
                userPrompt: PromptTemplates.impactSummary(report),
                temperature: 0.1,
                responseFormat: 'json',
            });

            const parsed = extractJSONFromAIOutput(response.content) as ImpactSummary;
            return {
                headline: parsed.headline ?? 'Impact analysis complete',
                keyRisks: parsed.keyRisks ?? [],
                prioritizedActions: parsed.prioritizedActions ?? [],
                estimatedEffort: parsed.estimatedEffort ?? 'medium',
            };
        } catch (err) {
            logger.debug('Failed to generate AI summary', { error: String(err) });
            return null;
        }
    }

    async summarizeSync(report: SyncReport): Promise<string> {
        if (report.issues.length === 0) return 'All layers are synchronized.';

        try {
            const response = await this.provider.complete({
                systemPrompt: PromptTemplates.systemImpactAnalyzer(),
                userPrompt: `Summarize these cross-layer sync issues in 2-3 sentences for a developer:
${report.summary}
Issues: ${report.issues.map(i => `${i.kind}: ${i.description}`).join('; ')}`,
                temperature: 0.2,
            });
            return response.content.trim();
        } catch {
            return report.summary;
        }
    }
}