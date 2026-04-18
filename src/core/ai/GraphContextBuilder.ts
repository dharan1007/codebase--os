import type { RelationshipGraph } from '../graph/RelationshipGraph.js';
import type { GraphNode } from '../../types/index.js';
import { GraphQueryEngine } from '../graph/GraphQueryEngine.js';
import { GraphStore } from '../../storage/GraphStore.js';
import type { AIProvider } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import path from 'path';

export interface GraphContext {
    relevantFiles: string[];
    keyNodes: Array<{ name: string; kind: string; layer: string; file: string; connections: number }>;
    crossLayerWarnings: string[];
    cyclicDependencies: string[];
    semanticSnippets: Array<{ node: GraphNode; similarity: number }>;
    summary: string;
}

/**
 * [ARCHITECTURAL HARDENING]: Semantic Context Cache
 * This protects against Root Cause 9 by caching structural summaries
 * and semantic embeddings for the duration of the process.
 */
class GlobalContextCache {
    private static cache: Map<string, GraphContext> = new Map();
    static get(key: string): GraphContext | undefined { return this.cache.get(key); }
    static set(key: string, val: GraphContext) { 
        if (this.cache.size > 20) this.cache.clear();
        this.cache.set(key, val); 
    }
}

export class GraphContextBuilder {
    private engine: GraphQueryEngine;

    constructor(private graph: RelationshipGraph, private store: GraphStore, private aiProvider?: AIProvider) {
        this.engine = new GraphQueryEngine(graph);
    }

    async build(request: string, rootDir: string, focusFiles?: string[]): Promise<GraphContext> {
        const cacheKey = `${request}|${focusFiles?.join(',')}`;
        const cached = GlobalContextCache.get(cacheKey);
        if (cached) {
            logger.debug('Context cache hit', { request });
            return cached;
        }

        const requestWords = this.extractKeywords(request);
        
        let semanticSnippets: Array<{ node: GraphNode; similarity: number }> = [];
        if (this.aiProvider?.embed) {
            try {
                const queryEmbedding = await this.aiProvider.embed(request);
                semanticSnippets = this.store.searchNodesByEmbedding(queryEmbedding, 15);
            } catch (err) {
                logger.warn('Semantic context build failed', { error: String(err) });
            }
        }

        const relevantNodes = this.findRelevantNodes(requestWords, focusFiles);
        const topConnected = this.engine.getMostConnectedNodes(8);
        const crossLayerConns = this.engine.getCrossLayerConnections();
        
        const crossLayerWarnings = crossLayerConns
            .filter(c => relevantNodes.some(n => n.id === c.sourceNode.id || n.id === c.targetNode.id))
            .slice(0, 5)
            .map(c => `${c.sourceNode.name} (${c.sourceLayer}) depends on ${c.targetNode.name} (${c.targetLayer})`);

        const cycles = this.engine.findCycles();
        const cyclicDependencies = cycles
            .filter(cycle => relevantNodes.some(n => cycle.includes(n.id)))
            .slice(0, 3)
            .map(cycle => {
                const names = cycle.map(id => this.graph.getNode(id)?.name ?? id);
                return `Cycle: ${names.join(' → ')}`;
            });

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

        const summary = this.buildSummary(relevantNodes, crossLayerWarnings, cyclicDependencies);

        const result = { relevantFiles, keyNodes, crossLayerWarnings, cyclicDependencies, semanticSnippets, summary };
        GlobalContextCache.set(cacheKey, result);
        return result;
    }

    format(context: GraphContext): string {
        const lines: string[] = [];
        lines.push('=== STRUCTURAL GRAPH CONTEXT ===');
        lines.push('(Structural data from the relationship graph.)');
        lines.push('');

        if (context.keyNodes.length > 0) {
            lines.push('Key Components Near Request:');
            for (const n of context.keyNodes) {
                lines.push(`  • ${n.name} [${n.kind}/${n.layer}] — ${n.file} (${n.connections} conns)`);
            }
            lines.push('');
        }

        if (context.relevantFiles.length > 0) {
            lines.push('Relevant Files:');
            for (const f of context.relevantFiles) {
                lines.push(`  - ${f}`);
            }
            lines.push('');
        }

        if (context.semanticSnippets.length > 0) {
            lines.push('Semantically Related (Vector RAG):');
            for (const s of context.semanticSnippets.slice(0, 8)) {
                lines.push(`  ≈ ${s.node.name} [${(s.similarity * 100).toFixed(0)}%] — ${s.node.filePath}`);
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

            for (const kw of keywords) {
                if (nodeName.includes(kw)) score += 3;
                if (nodeFile.includes(kw)) score += 1;
            }

            if (focusFiles?.some(f => node.filePath.includes(f))) score += 10;

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

    private buildSummary(nodes: GraphNode[], crossLayer: string[], cycles: string[]): string {
        const layerCounts: Record<string, number> = {};
        for (const n of nodes.slice(0, 20)) {
            layerCounts[n.layer] = (layerCounts[n.layer] ?? 0) + 1;
        }
        const layerStr = Object.entries(layerCounts).map(([l, c]) => `${c} ${l}`).join(', ');
        const warnings = crossLayer.length > 0 ? ` ${crossLayer.length} x-layer warnings.` : '';
        const cycleStr = cycles.length > 0 ? ` ${cycles.length} cycles.` : '';
        return `Graph: ${nodes.length} nodes (${layerStr}).${warnings}${cycleStr}`;
    }
}
