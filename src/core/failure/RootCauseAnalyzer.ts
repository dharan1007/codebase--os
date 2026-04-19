import type { AIProvider, FailureSnapshot, RootCauseReport, Hypothesis } from '../../types/index.js';
import { GitManager } from '../git/GitManager.js';
import { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { logger } from '../../utils/logger.js';
import { extractJSONFromAIOutput } from '../../utils/validation.js';

export class RootCauseAnalyzer {
    constructor(
        private ai: AIProvider,
        private git: GitManager,
        private graph: RelationshipGraph
    ) {}

    async analyze(failure: FailureSnapshot): Promise<RootCauseReport> {
        logger.info('RootCauseAnalyzer: Entering deep analysis mode...', { failureId: failure.id });

        // 1. Temporal Analysis (Git)
        const temporalContext = await this.getGitHistory(failure.filePath);

        // 2. Semantic Analysis (Graph)
        const semanticContext = this.getSemanticContext(failure.filePath);

        // 3. Multi-dimensional AI Pass
        const prompt = `You are a Principal Software Intelligence Agent. A recurring failure has been detected.

FAILURE:
Category: ${failure.category}
File: ${failure.filePath}
Message: ${failure.message}
Stack Trace: ${failure.stackTrace ?? 'N/A'}

TEMPORAL CONTEXT (Recent Commits):
${temporalContext.map(c => `[${c.hash}] ${c.date}: ${c.message}`).join('\n')}

SEMANTIC CONTEXT (Dependency Chain):
${semanticContext}

YOUR MISSION:
1. Identify the 'Root Cause' (temporal or structural).
2. Generate multiple hypotheses for a systemic fix.
3. Distinguish between local patches and systemic architectural adjustments.

RESPOND WITH JSON:
{
  "primaryCause": "string",
  "analyzedFiles": ["string"],
  "hypotheses": [
    {
      "id": "uuid",
      "description": "...",
      "logicLines": "...", 
      "confidence": 0.0-1.0,
      "impactLevel": "local" | "systemic"
    }
  ]
}`;

        const result = await this.ai.execute({
            taskType: 'reasoning',
            priority: 'high',
            context: prompt,
            systemPrompt: 'You are an elite root-cause investigator and systems architect.',
            maxTokens: 2500
        });

        const parsed = extractJSONFromAIOutput(result.content) as any;

        return {
            failureId: failure.id,
            primaryCause: parsed.primaryCause,
            analyzedFiles: parsed.analyzedFiles || [failure.filePath],
            hypotheses: parsed.hypotheses || [],
            temporalContext: temporalContext.slice(0, 3)
        };
    }

    private async getGitHistory(filePath: string) {
        try {
            return this.git.log(10); // Check last 10 commits
        } catch {
            return [];
        }
    }

    private getSemanticContext(filePath: string): string {
        const nodes = this.graph.getNodesByFile(filePath);
        if (nodes.length === 0) return 'No graph nodes found for file.';

        let context = '';
        for (const node of nodes) {
            const deps = this.graph.getDirectDependencies(node.id);
            const dependents = this.graph.getDirectDependents(node.id);
            
            context += `Node: ${node.name} (${node.kind})\n`;
            context += `  Dependencies: ${deps.map(d => d.name).join(', ')}\n`;
            context += `  Dependents: ${dependents.map(d => d.name).join(', ')}\n`;
        }
        return context;
    }
}
