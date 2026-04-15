import type { FileChange, ImpactReport, CrossLayerIssue, Layer, ChangeSeverity } from '../../types/index.js';
import type { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { ChangeClassifier } from './ChangeClassifier.js';
import { PropagationEngine } from './PropagationEngine.js';
import { TypeScriptAnalyzer } from '../scanner/TypeScriptAnalyzer.js';
import { Database } from '../../storage/Database.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';
import { normalizePath } from '../../utils/paths.js';

export class ImpactAnalyzer {
    private classifier: ChangeClassifier;
    private propagation: PropagationEngine;

    constructor(
        private graph: RelationshipGraph,
        private tsAnalyzer: TypeScriptAnalyzer,
        private db: Database
    ) {
        this.classifier = new ChangeClassifier(tsAnalyzer);
        this.propagation = new PropagationEngine(graph);
    }

    analyze(change: FileChange): ImpactReport {
        const normalizedPath = normalizePath(change.filePath);
        const normalizedChange = { ...change, filePath: normalizedPath };

        const classified = this.classifier.classify(normalizedChange);
        const impactedNodes = this.propagation.propagate(normalizedPath, classified);

        const affectedLayers = new Set<Layer>();
        affectedLayers.add(this.getFileLayer(change.filePath));
        for (const n of impactedNodes) affectedLayers.add(n.node.layer);

        const crossLayerIssues = this.detectCrossLayerIssues(classified, impactedNodes);
        const summary = this.buildSummary(change, classified, impactedNodes, crossLayerIssues);

        const report: ImpactReport = {
            id: uuidv4(),
            triggerChange: change,
            impactedNodes,
            affectedLayers: Array.from(affectedLayers),
            severity: classified.severity,
            scope: classified.scopes,
            crossLayerIssues,
            timestamp: Date.now(),
            summary,
        };

        this.persistReport(report);
        logger.info('Impact analysis complete', {
            file: change.filePath,
            severity: classified.severity,
            impacted: impactedNodes.length,
            crossLayerIssues: crossLayerIssues.length,
        });

        return report;
    }

    private detectCrossLayerIssues(
        classified: ReturnType<ChangeClassifier['classify']>,
        impactedNodes: ImpactReport['impactedNodes']
    ): CrossLayerIssue[] {
        const issues: CrossLayerIssue[] = [];

        if (classified.isSchemaChange) {
            const backendNodes = impactedNodes.filter(n => n.node.layer === 'backend');
            const frontendNodes = impactedNodes.filter(n => n.node.layer === 'frontend');
            const apiNodes = impactedNodes.filter(n => n.node.layer === 'api');

            if (backendNodes.length > 0) {
                issues.push({
                    description: 'Database schema change may affect backend data access patterns',
                    sourceLayer: 'database',
                    targetLayer: 'backend',
                    severity: 'major',
                    affectedNodeIds: backendNodes.map(n => n.node.id),
                    resolution: 'Update ORM models and repository layer to match new schema',
                });
            }
            if (apiNodes.length > 0) {
                issues.push({
                    description: 'Database schema change may affect API response shapes',
                    sourceLayer: 'database',
                    targetLayer: 'api',
                    severity: 'major',
                    affectedNodeIds: apiNodes.map(n => n.node.id),
                    resolution: 'Review API endpoint response serialization for schema alignment',
                });
            }
            if (frontendNodes.length > 0) {
                issues.push({
                    description: 'Database schema change may cascade to frontend data structures',
                    sourceLayer: 'database',
                    targetLayer: 'frontend',
                    severity: 'minor',
                    affectedNodeIds: frontendNodes.map(n => n.node.id),
                    resolution: 'Update frontend type definitions and state management',
                });
            }
        }

        if (classified.isTypeChange && classified.breakingChanges.length > 0) {
            const breakingTargets = impactedNodes.filter(n => n.requiresUpdate);
            if (breakingTargets.length > 0) {
                issues.push({
                    description: `Breaking type changes detected: ${classified.breakingChanges.map(b => b.description).join('; ')}`,
                    sourceLayer: this.getFileLayer(classified.fileChange.filePath),
                    targetLayer: breakingTargets[0]!.node.layer,
                    severity: 'breaking',
                    affectedNodeIds: breakingTargets.map(n => n.node.id),
                    resolution: 'Update all consumers of changed types to match new signatures',
                });
            }
        }

        if (classified.isAPIChange) {
            const frontendNodes = impactedNodes.filter(n => n.node.layer === 'frontend');
            if (frontendNodes.length > 0) {
                issues.push({
                    description: 'API contract change may break frontend API integrations',
                    sourceLayer: 'api',
                    targetLayer: 'frontend',
                    severity: 'major',
                    affectedNodeIds: frontendNodes.map(n => n.node.id),
                    resolution: 'Update API client calls and response handlers in frontend',
                });
            }
        }

        return issues;
    }

    private buildSummary(
        change: FileChange,
        classified: ReturnType<ChangeClassifier['classify']>,
        impactedNodes: ImpactReport['impactedNodes'],
        crossLayerIssues: CrossLayerIssue[]
    ): string {
        const lines = [
            `Change to ${change.filePath} (${change.changeType}, ${classified.severity} severity)`,
            `Scopes: ${classified.scopes.join(', ')}`,
            `Impacts ${impactedNodes.length} node(s) across ${new Set(impactedNodes.map(n => n.node.layer)).size} layer(s)`,
        ];
        if (classified.breakingChanges.length > 0) {
            lines.push(`Breaking changes detected: ${classified.breakingChanges.length}`);
        }
        if (crossLayerIssues.length > 0) {
            lines.push(`Cross-layer issues: ${crossLayerIssues.length}`);
        }
        return lines.join('\n');
    }

    private getFileLayer(filePath: string): Layer {
        const nodes = this.graph.getNodesByFile(filePath);
        return nodes[0]?.layer ?? 'backend';
    }

    private persistReport(report: ImpactReport): void {
        try {
            this.db.prepare(`
        INSERT INTO impact_reports
          (id, trigger_change_json, impacted_nodes_json, affected_layers_json,
           severity, scope_json, cross_layer_issues_json, timestamp, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
                report.id,
                JSON.stringify(report.triggerChange),
                JSON.stringify(report.impactedNodes),
                JSON.stringify(report.affectedLayers),
                report.severity,
                JSON.stringify(report.scope),
                JSON.stringify(report.crossLayerIssues),
                report.timestamp,
                report.summary
            );
        } catch (err) {
            logger.debug('Failed to persist impact report', { error: String(err) });
        }
    }
}