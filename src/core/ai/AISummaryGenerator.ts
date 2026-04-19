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
            const result = await this.provider.execute({
                taskType: 'analysis',
                priority: 'low',
                context: PromptTemplates.impactSummary(report),
                systemPrompt: PromptTemplates.systemImpactAnalyzer(),
                maxTokens: 1000,
            });

            const parsed = extractJSONFromAIOutput(result.content) as ImpactSummary;
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
            const result = await this.provider.execute({
                taskType: 'analysis',
                priority: 'low',
                context: `Summarize these cross-layer sync issues in 2-3 sentences for a developer:
${report.summary}
Issues: ${report.issues.map(i => `${i.kind}: ${i.description}`).join('; ')}`,
                systemPrompt: PromptTemplates.systemImpactAnalyzer(),
                maxTokens: 500,
            });
            return result.content.trim();
        } catch {
            return report.summary;
        }
    }
}