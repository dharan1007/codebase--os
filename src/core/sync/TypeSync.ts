import type { SyncIssue } from '../../types/index.js';
import type { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { TypeScriptAnalyzer } from '../scanner/TypeScriptAnalyzer.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import { logger } from '../../utils/logger.js';

export class TypeSync {
    constructor(
        private graph: RelationshipGraph,
        private tsAnalyzer: TypeScriptAnalyzer
    ) { }

    detectTypeMismatches(): SyncIssue[] {
        const issues: SyncIssue[] = [];

        const interfaceNodes = Array.from(this.graph.nodes.values()).filter(n => n.kind === 'interface');

        for (const ifaceNode of interfaceNodes) {
            const dependents = this.graph.getDirectDependents(ifaceNode.id);

            for (const dependent of dependents) {
                if (dependent.filePath === ifaceNode.filePath) continue;

                if (!fs.existsSync(dependent.filePath)) {
                    issues.push({
                        id: uuidv4(),
                        kind: 'broken_reference',
                        description: `Node '${dependent.name}' in '${dependent.filePath}' references non-existent interface '${ifaceNode.name}'`,
                        sourceFile: dependent.filePath,
                        targetFile: ifaceNode.filePath,
                        sourceNodeId: dependent.id,
                        targetNodeId: ifaceNode.id,
                        severity: 'major',
                        autoFixable: false,
                        suggestedFix: `Restore or recreate the interface '${ifaceNode.name}' in '${ifaceNode.filePath}'`,
                    });
                }
            }
        }

        logger.debug('Type sync detection complete', { issues: issues.length });
        return issues;
    }
}