import type { GraphNode, SyncIssue } from '../../types/index.js';
import type { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { TypeScriptAnalyzer } from '../scanner/TypeScriptAnalyzer.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import { logger } from '../../utils/logger.js';

interface TypeShape {
    node: GraphNode;
    signature: string;
    properties: Array<{ name: string; type: string; optional: boolean }>;
}

export class TypeSync {
    constructor(
        private graph: RelationshipGraph,
        private tsAnalyzer: TypeScriptAnalyzer,
    ) {}

    detectTypeMismatches(): SyncIssue[] {
        const issues: SyncIssue[] = [];
        const interfaceNodes = Array.from(this.graph.nodes.values())
            .filter(node => node.kind === 'interface' && /\.[cm]?tsx?$/.test(node.filePath));

        const byName = new Map<string, GraphNode[]>();
        for (const node of interfaceNodes) {
            const key = node.name.toLowerCase();
            const list = byName.get(key) ?? [];
            list.push(node);
            byName.set(key, list);
        }

        for (const nodes of byName.values()) {
            const distinctFiles = [...new Set(nodes.map(node => node.filePath))];
            const layers = new Set(nodes.map(node => node.layer));
            if (distinctFiles.length < 2 || layers.size < 2) continue;

            const shapes = nodes
                .map(node => this.shapeFor(node))
                .filter((shape): shape is TypeShape => Boolean(shape));
            if (shapes.length < 2) continue;

            const baseline = shapes[0]!;
            for (const candidate of shapes.slice(1)) {
                if (candidate.signature === baseline.signature) continue;
                issues.push({
                    id: uuidv4(),
                    kind: 'type_mismatch',
                    description:
                        `Cross-layer interface '${baseline.node.name}' differs between ` +
                        `${baseline.node.layer} (${baseline.node.filePath}) and ${candidate.node.layer} (${candidate.node.filePath}).`,
                    sourceFile: baseline.node.filePath,
                    targetFile: candidate.node.filePath,
                    sourceNodeId: baseline.node.id,
                    targetNodeId: candidate.node.id,
                    severity: 'major',
                    autoFixable: false,
                    suggestedFix: this.describeShapeDifference(baseline, candidate),
                });
            }
        }

        // Preserve a separate broken-reference check for graph nodes whose
        // backing file disappeared after the last scan.
        for (const node of interfaceNodes) {
            if (fs.existsSync(node.filePath)) continue;
            issues.push({
                id: uuidv4(),
                kind: 'broken_reference',
                description: `Interface '${node.name}' points to a file that no longer exists: ${node.filePath}`,
                sourceFile: node.filePath,
                sourceNodeId: node.id,
                severity: 'major',
                autoFixable: false,
                suggestedFix: 'Rescan the repository and repair imports/references to the deleted type definition.',
            });
        }

        logger.debug('Type sync detection complete', { interfaces: interfaceNodes.length, issues: issues.length });
        return issues;
    }

    private shapeFor(node: GraphNode): TypeShape | null {
        try {
            const definition = this.tsAnalyzer.extractDetailedTypes(node.filePath)
                .find(type => type.kind === 'interface' && type.name === node.name);
            if (!definition) return null;
            const properties = definition.properties
                .map(property => ({ name: property.name, type: property.type.replace(/\s+/g, ' ').trim(), optional: property.optional }))
                .sort((a, b) => a.name.localeCompare(b.name));
            const signature = JSON.stringify(properties);
            return { node, signature, properties };
        } catch (err) {
            logger.debug('TypeSync: semantic shape extraction failed', { file: node.filePath, name: node.name, error: String(err) });
            return null;
        }
    }

    private describeShapeDifference(a: TypeShape, b: TypeShape): string {
        const aMap = new Map(a.properties.map(property => [property.name, property]));
        const bMap = new Map(b.properties.map(property => [property.name, property]));
        const differences: string[] = [];
        for (const [name, property] of aMap) {
            const other = bMap.get(name);
            if (!other) differences.push(`${name} is missing from ${b.node.filePath}`);
            else if (property.type !== other.type || property.optional !== other.optional) {
                differences.push(`${name}: ${property.type}${property.optional ? '?' : ''} vs ${other.type}${other.optional ? '?' : ''}`);
            }
        }
        for (const name of bMap.keys()) {
            if (!aMap.has(name)) differences.push(`${name} exists only in ${b.node.filePath}`);
        }
        return differences.slice(0, 8).join('; ') || `Unify '${a.node.name}' into one shared contract or reconcile both definitions.`;
    }
}
