import type { GraphNode, GraphEdge, Layer } from '../../types/index.js';
import type { RelationshipGraph } from './RelationshipGraph.js';

export interface PathResult {
    path: GraphNode[];
    edges: GraphEdge[];
    length: number;
}

export interface CentralityScore {
    nodeId: string;
    nodeName: string;
    inDegree: number;
    outDegree: number;
    betweenness: number;
    isHub: boolean;
}

export class GraphQueryEngine {
    constructor(private graph: RelationshipGraph) { }

    findShortestPath(fromId: string, toId: string): PathResult | null {
        if (fromId === toId) {
            const node = this.graph.getNode(fromId);
            return node ? { path: [node], edges: [], length: 0 } : null;
        }

        const visited = new Set<string>();
        const prev = new Map<string, { nodeId: string; edgeId: string }>();
        const queue: string[] = [fromId];
        visited.add(fromId);

        while (queue.length > 0) {
            const current = queue.shift()!;
            const outEdges = this.graph.getOutgoingEdges(current);

            for (const edge of outEdges) {
                if (!visited.has(edge.targetId)) {
                    visited.add(edge.targetId);
                    prev.set(edge.targetId, { nodeId: current, edgeId: edge.id });
                    if (edge.targetId === toId) {
                        return this.reconstructPath(fromId, toId, prev);
                    }
                    queue.push(edge.targetId);
                }
            }
        }

        return null;
    }

    private reconstructPath(
        fromId: string,
        toId: string,
        prev: Map<string, { nodeId: string; edgeId: string }>
    ): PathResult {
        const path: GraphNode[] = [];
        const edges: GraphEdge[] = [];
        let current = toId;

        while (current !== fromId) {
            const node = this.graph.getNode(current);
            if (!node) break;
            path.unshift(node);
            const prevInfo = prev.get(current);
            if (!prevInfo) break;
            const edge = this.graph.edges.get(prevInfo.edgeId);
            if (edge) edges.unshift(edge);
            current = prevInfo.nodeId;
        }

        const startNode = this.graph.getNode(fromId);
        if (startNode) path.unshift(startNode);

        return { path, edges, length: edges.length };
    }

    computeCentrality(): CentralityScore[] {
        const scores: CentralityScore[] = [];
        const allNodes = Array.from(this.graph.nodes.values());

        for (const node of allNodes) {
            // Use adjacency maps directly — O(1) per node instead of O(e) edge scans
            const inDegree = (this.graph.reverseAdjacency.get(node.id) ?? new Set()).size;
            const outDegree = (this.graph.adjacency.get(node.id) ?? new Set()).size;
            scores.push({
                nodeId: node.id,
                nodeName: node.name,
                inDegree,
                outDegree,
                betweenness: inDegree + outDegree,
                isHub: inDegree + outDegree > 10,
            });
        }

        scores.sort((a, b) => b.betweenness - a.betweenness);
        return scores;
    }

    findCycles(): string[][] {
        const cycles: string[][] = [];
        const visited = new Set<string>();
        const recursionStack = new Set<string>();
        const path: string[] = [];

        const dfs = (nodeId: string): void => {
            visited.add(nodeId);
            recursionStack.add(nodeId);
            path.push(nodeId);

            const neighbors = this.graph.adjacency.get(nodeId) ?? new Set();
            for (const neighbor of neighbors) {
                if (!visited.has(neighbor)) {
                    dfs(neighbor);
                } else if (recursionStack.has(neighbor)) {
                    const cycleStart = path.indexOf(neighbor);
                    if (cycleStart !== -1) {
                        cycles.push(path.slice(cycleStart));
                    }
                }
            }

            path.pop();
            recursionStack.delete(nodeId);
        };

        for (const nodeId of this.graph.nodes.keys()) {
            if (!visited.has(nodeId)) {
                dfs(nodeId);
            }
        }

        return cycles;
    }

    getCrossLayerConnections(): Array<{
        sourceNode: GraphNode;
        targetNode: GraphNode;
        edge: GraphEdge;
        sourceLayer: Layer;
        targetLayer: Layer;
    }> {
        const results: Array<{
            sourceNode: GraphNode;
            targetNode: GraphNode;
            edge: GraphEdge;
            sourceLayer: Layer;
            targetLayer: Layer;
        }> = [];

        for (const edge of this.graph.edges.values()) {
            const source = this.graph.getNode(edge.sourceId);
            const target = this.graph.getNode(edge.targetId);
            if (source && target && source.layer !== target.layer) {
                results.push({
                    sourceNode: source,
                    targetNode: target,
                    edge,
                    sourceLayer: source.layer,
                    targetLayer: target.layer,
                });
            }
        }

        return results;
    }

    getSubgraph(rootId: string, maxDepth = 3): RelationshipGraph['nodes'] {
        const included = new Set<string>();
        const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];

        while (queue.length > 0) {
            const item = queue.shift()!;
            if (item.depth > maxDepth || included.has(item.id)) continue;
            included.add(item.id);

            const neighbors = this.graph.adjacency.get(item.id) ?? new Set();
            for (const nId of neighbors) {
                if (!included.has(nId)) {
                    queue.push({ id: nId, depth: item.depth + 1 });
                }
            }
        }

        const result: RelationshipGraph['nodes'] = new Map();
        for (const id of included) {
            const node = this.graph.getNode(id);
            if (node) result.set(id, node);
        }
        return result;
    }

    getOrphanNodes(): GraphNode[] {
        return Array.from(this.graph.nodes.values()).filter(node => {
            const inDeg = (this.graph.reverseAdjacency.get(node.id) ?? new Set()).size;
            const outDeg = (this.graph.adjacency.get(node.id) ?? new Set()).size;
            return inDeg === 0 && outDeg === 0 && node.kind !== 'file';
        });
    }

    getMostConnectedNodes(topN = 10): Array<{ node: GraphNode; connections: number }> {
        const scored = Array.from(this.graph.nodes.values()).map(node => ({
            node,
            connections:
                (this.graph.adjacency.get(node.id)?.size ?? 0) +
                (this.graph.reverseAdjacency.get(node.id)?.size ?? 0),
        }));

        scored.sort((a, b) => b.connections - a.connections);
        return scored.slice(0, topN);
    }

    /**
     * Semantic search over the graph — finds nodes most relevant to a natural
     * language query by scoring on keyword matches and connectivity.
     * Replaces the flat 60-file random sample used by other tools.
     */
    semanticSearch(query: string, topN = 15): GraphNode[] {
        const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'in', 'on', 'to', 'for', 'of', 'with', 'is', 'fix', 'add', 'get', 'set', 'my', 'all', 'make', 'any']);
        const keywords = query.toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2 && !stopWords.has(w));

        if (keywords.length === 0) return this.getMostConnectedNodes(topN).map(s => s.node);

        const scored = Array.from(this.graph.nodes.values()).map(node => {
            let score = 0;
            const name = node.name.toLowerCase();
            const file = node.filePath.toLowerCase();
            const sig = (node.signature ?? '').toLowerCase();
            const doc = (node.docComment ?? '').toLowerCase();

            for (const kw of keywords) {
                if (name === kw) score += 10;
                else if (name.includes(kw)) score += 5;
                if (file.includes(kw)) score += 2;
                if (sig.includes(kw)) score += 1;
                if (doc.includes(kw)) score += 1;
            }

            // Boost highly connected nodes
            const connections =
                (this.graph.adjacency.get(node.id)?.size ?? 0) +
                (this.graph.reverseAdjacency.get(node.id)?.size ?? 0);
            score += Math.min(connections * 0.1, 3);

            return { node, score };
        });

        return scored
            .filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, topN)
            .map(s => s.node);
    }
}