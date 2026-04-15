import type { SyncIssue, RelationshipGraph as IRelationshipGraph, GraphNode } from '../../types/index.js';
import type { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';

export class SchemaSync {
    constructor(private graph: RelationshipGraph) { }

    detectSchemaDrift(): SyncIssue[] {
        const issues: SyncIssue[] = [];
        const dbNodes = this.graph.findNodesByLayer('database');
        const backendNodes = this.graph.findNodesByLayer('backend');

        const tableNodes = dbNodes.filter(n => n.kind === 'db_table');

        for (const tableNode of tableNodes) {
            const tableMetadata = tableNode.metadata as { tableName?: string; columns?: Array<{ name: string; type: string }> };
            if (!tableMetadata.tableName || !tableMetadata.columns) continue;

            const correspondingModels = backendNodes.filter(n => {
                const meta = n.metadata as { modelName?: string; tableName?: string };
                return (
                    meta.modelName?.toLowerCase() === tableMetadata.tableName!.toLowerCase() ||
                    meta.tableName?.toLowerCase() === tableMetadata.tableName!.toLowerCase() ||
                    n.name.toLowerCase().includes(tableMetadata.tableName!.toLowerCase())
                );
            });

            if (correspondingModels.length === 0 && tableNodes.length > 0) {
                issues.push({
                    id: uuidv4(),
                    kind: 'missing_field',
                    description: `DB table '${tableMetadata.tableName}' has no corresponding model in the backend layer`,
                    sourceFile: tableNode.filePath,
                    sourceNodeId: tableNode.id,
                    severity: 'minor',
                    autoFixable: false,
                    suggestedFix: `Create a model/entity for table '${tableMetadata.tableName}' in the backend layer`,
                });
            }
        }

        const apiEndpoints = this.graph.findNodesByLayer('api').filter(n => n.kind === 'api_endpoint');
        for (const endpoint of apiEndpoints) {
            const meta = endpoint.metadata as { method?: string; path?: string };
            const dependentBackendNodes = this.graph.getDirectDependencies(endpoint.id).filter(n => n.layer === 'backend');

            if (dependentBackendNodes.length === 0 && meta.method) {
                issues.push({
                    id: uuidv4(),
                    kind: 'broken_reference',
                    description: `API endpoint '${meta.method} ${meta.path}' has no backend handler connected in the graph`,
                    sourceFile: endpoint.filePath,
                    sourceNodeId: endpoint.id,
                    severity: 'major',
                    autoFixable: false,
                    suggestedFix: `Link the endpoint handler function in the graph for '${meta.method} ${meta.path}'`,
                });
            }
        }

        logger.debug('Schema drift detection complete', { issues: issues.length });
        return issues;
    }
}