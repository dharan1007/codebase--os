import type { GraphNode, ImpactedNode, ChangeSeverity, Layer } from '../../types/index.js';
import type { RelationshipGraph } from '../graph/RelationshipGraph.js';
import type { ClassifiedChange } from './ChangeClassifier.js';

export class PropagationEngine {
    constructor(private graph: RelationshipGraph) { }

    propagate(
        changedFilePath: string,
        classifiedChange: ClassifiedChange,
        maxDepth = 8
    ): ImpactedNode[] {
        const changedNodes = this.graph.getNodesByFile(changedFilePath);
        const impacted = new Map<string, ImpactedNode>();

        for (const changedNode of changedNodes) {
            const dependents = this.graph.getAllDependents(changedNode.id, maxDepth);

            for (const [dependentId, depth] of dependents) {
                const node = this.graph.getNode(dependentId);
                if (!node || node.filePath === changedFilePath) continue;

                const severity = this.computeImpactSeverity(
                    classifiedChange.severity,
                    depth,
                    classifiedChange.isTypeChange,
                    classifiedChange.isSchemaChange,
                    classifiedChange.isAPIChange,
                    changedNode.layer,
                    node.layer
                );

                const reason = this.buildReason(changedNode, node, depth, classifiedChange);
                const suggestedAction = this.suggestAction(changedNode, node, classifiedChange);

                if (!impacted.has(dependentId)) {
                    impacted.set(dependentId, {
                        node,
                        reason,
                        severity,
                        propagationDepth: depth,
                        requiresUpdate: severity === 'breaking' || severity === 'major',
                        suggestedAction,
                    });
                } else {
                    const existing = impacted.get(dependentId)!;
                    if (this.compareSeverity(severity, existing.severity) > 0) {
                        impacted.set(dependentId, { ...existing, severity, reason, suggestedAction });
                    }
                }
            }
        }

        return Array.from(impacted.values()).sort(
            (a, b) => this.compareSeverity(b.severity, a.severity)
        );
    }

    private computeImpactSeverity(
        baseSeverity: ChangeSeverity,
        depth: number,
        isTypeChange: boolean,
        isSchemaChange: boolean,
        isAPIChange: boolean,
        sourceLayer: Layer,
        targetLayer: Layer
    ): ChangeSeverity {
        const order: ChangeSeverity[] = ['patch', 'minor', 'major', 'breaking'];
        let idx = order.indexOf(baseSeverity);

        if (depth === 1) idx = Math.min(idx, order.length - 1);
        else if (depth === 2) idx = Math.max(0, idx - 1);
        else idx = Math.max(0, idx - 2);

        if (isTypeChange && depth <= 3) idx = Math.min(order.length - 1, idx + 1);
        if (isSchemaChange && depth <= 2) idx = Math.min(order.length - 1, idx + 1);
        if (isAPIChange && sourceLayer !== targetLayer) idx = Math.min(order.length - 1, idx + 1);

        return order[Math.max(0, idx)] as ChangeSeverity;
    }

    private buildReason(
        source: GraphNode,
        target: GraphNode,
        depth: number,
        classifiedChange: ClassifiedChange
    ): string {
        const scopes = classifiedChange.scopes.join(', ');
        if (depth === 1) {
            return `Directly depends on changed ${source.kind} '${source.name}' (${scopes})`;
        }
        return `Transitively affected by ${source.kind} '${source.name}' change at depth ${depth} (${scopes})`;
    }

    private suggestAction(
        source: GraphNode,
        target: GraphNode,
        classifiedChange: ClassifiedChange
    ): string {
        if (classifiedChange.isTypeChange) {
            return `Review type compatibility in '${target.name}' — types from '${source.name}' may have changed`;
        }
        if (classifiedChange.isSchemaChange) {
            return `Update data access layer in '${target.name}' to match new schema`;
        }
        if (classifiedChange.isAPIChange) {
            return `Verify API contract alignment in '${target.name}'`;
        }
        if (classifiedChange.isConfigChange) {
            return `Check configuration references in '${target.name}'`;
        }
        return `Review '${target.name}' for compatibility with changes in '${source.name}'`;
    }

    private compareSeverity(a: ChangeSeverity, b: ChangeSeverity): number {
        const order: ChangeSeverity[] = ['patch', 'minor', 'major', 'breaking'];
        return order.indexOf(a) - order.indexOf(b);
    }
}