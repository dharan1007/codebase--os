import type { SyncIssue } from '../../types/index.js';
import type { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';

export class APISync {
    constructor(private graph: RelationshipGraph) { }

    detectAPIContractDrift(): SyncIssue[] {
        const issues: SyncIssue[] = [];

        const apiEndpoints = this.graph.findNodesByLayer('api').filter(n => n.kind === 'api_endpoint');
        const frontendNodes = this.graph.findNodesByLayer('frontend');

        const apiPaths = new Map<string, string>();
        for (const endpoint of apiEndpoints) {
            const meta = endpoint.metadata as { method?: string; path?: string };
            if (meta.method && meta.path) {
                apiPaths.set(`${meta.method}:${meta.path}`, endpoint.id);
            }
        }

        for (const frontendNode of frontendNodes) {
            const meta = frontendNode.metadata as { apiCalls?: Array<{ method: string; path: string }> };
            if (!meta.apiCalls) continue;

            for (const call of meta.apiCalls) {
                const key = `${call.method}:${call.path}`;
                if (!apiPaths.has(key)) {
                    issues.push({
                        id: uuidv4(),
                        kind: 'broken_reference',
                        description: `Frontend references API endpoint '${call.method} ${call.path}' which doesn't exist in the API layer`,
                        sourceFile: frontendNode.filePath,
                        sourceNodeId: frontendNode.id,
                        severity: 'major',
                        autoFixable: false,
                        suggestedFix: `Either add the endpoint '${call.method} ${call.path}' to the API layer, or fix the frontend reference`,
                    });
                }
            }
        }

        logger.debug('API contract drift detection complete', { issues: issues.length });
        return issues;
    }
}