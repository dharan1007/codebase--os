import type { RelationshipGraph } from '../graph/RelationshipGraph.js';
import type { GraphNode } from '../../types/index.js';
import { GraphQueryEngine } from '../graph/GraphQueryEngine.js';
import { GraphStore } from '../../storage/GraphStore.js';
import type { AIProvider } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import path from 'path';
import fs from 'fs';

export interface GraphContext {
    relevantFiles: string[];
    keyNodes: Array<{ name: string; kind: string; layer: string; file: string; connections: number }>;
    crossLayerWarnings: string[];
    cyclicDependencies: string[];
    semanticSnippets: Array<{ node: GraphNode; similarity: number }>;
    summary: string;
}

/**
 * GraphContextBuilder enriches AI planning prompts with real structural
 * intelligence from the relationship graph. This is the primary differentiator
 * over tools like Claude Code that only see flat file lists.
 */
export class GraphContextBuilder {
    private engine: GraphQueryEngine;

    constructor(private graph: RelationshipGraph, private store: GraphStore, private aiProvider?: AIProvider) {
        this.engine = new GraphQueryEngine(graph);
    }

    /**
     * Build a rich context string for a given request and optional focus files.
     * This replaces a flat file listing with meaningful structural data.
     */
    async build(request: string, rootDir: string, focusFiles?: string[]): Promise<GraphContext> {
        const requestWords = this.extractKeywords(request);
        
        // 1. Semantic Search (Vector RAG)
        let semanticSnippets: Array<{ node: GraphNode; similarity: number }> = [];
        if (this.aiProvider?.embed) {
            try {
                const queryEmbedding = await this.aiProvider.embed(request);
                semanticSnippets = this.store.searchNodesByEmbedding(queryEmbedding, 15);
            } catch (err) {
                logger.warn('Semantic context build failed', { error: String(err) });
            }
        }

        // 1. Find nodes most relevant to the request
        const relevantNodes = this.findRelevantNodes(requestWords, focusFiles);

        // 2. Find top connected hub files
        const topConnected = this.engine.getMostConnectedNodes(8);

        // 3. Detect cross-layer issues in relevant area
        const crossLayerConns = this.engine.getCrossLayerConnections();
        const crossLayerWarnings = crossLayerConns
            .filter(c => relevantNodes.some(n => n.id === c.sourceNode.id || n.id === c.targetNode.id))
            .slice(0, 5)
            .map(c => `${c.sourceNode.name} (${c.sourceLayer}) depends on ${c.targetNode.name} (${c.targetLayer})`);

        // 4. Detect cycles near relevant nodes
        const cycles = this.engine.findCycles();
        const cyclicDependencies = cycles
            .filter(cycle => relevantNodes.some(n => cycle.includes(n.id)))
            .slice(0, 3)
            .map(cycle => {
                const names = cycle.map(id => this.graph.getNode(id)?.name ?? id);
                return `Cycle: ${names.join(' → ')}`;
            });

        // 5. Collect unique relevant files
        const relevantFiles = Array.from(new Set([
            ...relevantNodes.map(n => path.relative(rootDir, n.filePath)),
            ...topConnected.map(t => path.relative(rootDir, t.node.filePath)),
        ])).filter(f => f && !f.startsWith('..')).slice(0, 30);

        const keyNodes = relevantNodes.slice(0, 10).map(n => ({
            name: n.name,
            kind: n.kind,
            layer: n.layer,
            file: path.relative(rootDir, n.filePath),
            connections:
                (this.graph.adjacency.get(n.id)?.size ?? 0) +
                (this.graph.reverseAdjacency.get(n.id)?.size ?? 0),
        }));

        const summary = this.buildSummary(relevantNodes, crossLayerWarnings, cyclicDependencies, rootDir);

        return { relevantFiles, keyNodes, crossLayerWarnings, cyclicDependencies, semanticSnippets, summary };
    }

    /**
     * Format the graph context as a compact, AI-readable string block.
     */
    format(context: GraphContext): string {
        const lines: string[] = [];

        lines.push('=== STRUCTURAL GRAPH CONTEXT ===');
        lines.push('(This is real structural data from the project\'s relationship graph.)');
        lines.push('');

        if (context.keyNodes.length > 0) {
            lines.push('Key Components Near This Request:');
            for (const n of context.keyNodes) {
                lines.push(`  • ${n.name} [${n.kind}/${n.layer}] — ${n.file} (${n.connections} connections)`);
            }
            lines.push('');
        }

        if (context.relevantFiles.length > 0) {
            lines.push('All Relevant Files:');
            for (const f of context.relevantFiles) {
                lines.push(`  - ${f}`);
            }
            lines.push('');
        }

        if (context.crossLayerWarnings.length > 0) {
            lines.push('Cross-Layer Dependencies to Consider:');
            for (const w of context.crossLayerWarnings) {
                lines.push(`  ! ${w}`);
            }
            lines.push('');
        }

        if (context.semanticSnippets.length > 0) {
            lines.push('Semantically Related Components (AI Match):');
            for (const s of context.semanticSnippets.slice(0, 8)) {
                lines.push(`  ≈ ${s.node.name} [match: ${(s.similarity * 100).toFixed(0)}%] — ${s.node.filePath}`);
            }
            lines.push('');
        }

        lines.push('=== END GRAPH CONTEXT ===');
        return lines.join('\n');
    }

    private findRelevantNodes(keywords: string[], focusFiles?: string[]): GraphNode[] {
        const allNodes = Array.from(this.graph.nodes.values());
        const scored: Array<{ node: GraphNode; score: number }> = [];

        for (const node of allNodes) {
            let score = 0;
            const nodeName = node.name.toLowerCase();
            const nodeFile = node.filePath.toLowerCase();

            // Keyword match in name
            for (const kw of keywords) {
                if (nodeName.includes(kw)) score += 3;
                if (nodeFile.includes(kw)) score += 1;
            }

            // Boost nodes in focus files
            if (focusFiles?.some(f => node.filePath.includes(f))) score += 10;

            // Boost high-connectivity nodes
            const connections =
                (this.graph.adjacency.get(node.id)?.size ?? 0) +
                (this.graph.reverseAdjacency.get(node.id)?.size ?? 0);
            score += Math.min(connections * 0.2, 3);

            if (score > 0) scored.push({ node, score });
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.map(s => s.node);
    }

    private extractKeywords(request: string): string[] {
        const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'this', 'that', 'it', 'make', 'all', 'fix', 'any', 'add', 'get', 'set', 'from', 'my', 'i']);
        return request.toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2 && !stopWords.has(w));
    }

    private buildSummary(nodes: GraphNode[], crossLayer: string[], cycles: string[], rootDir: string): string {
        const layerCounts: Record<string, number> = {};
        for (const n of nodes.slice(0, 20)) {
            layerCounts[n.layer] = (layerCounts[n.layer] ?? 0) + 1;
        }
        const layerStr = Object.entries(layerCounts).map(([l, c]) => `${c} ${l}`).join(', ');
        const warnings = crossLayer.length > 0 ? ` ${crossLayer.length} cross-layer warning(s).` : '';
        const cycleStr = cycles.length > 0 ? ` ${cycles.length} cyclic dependency(ies) detected.` : '';
        return `Graph: ${nodes.length} relevant nodes (${layerStr}).${warnings}${cycleStr}`;
    }
}
