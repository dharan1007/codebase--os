/**
 * RelationshipGraph — O(1) indexed in-memory graph.
 *
 * PREVIOUS CRITICAL PERFORMANCE FLAWS FIXED:
 *
 * 1. getNodesByFile() was O(n) — scanned ALL nodes on every call.
 *    On a 100k-node graph with 10k files, a full scan = 1 billion iterations.
 *    FIX: fileIndex: Map<filePath, Set<nodeId>> maintained in add/remove.
 *    getNodesByFile() is now O(degree) — just a Map.get().
 *
 * 2. getOutgoingEdges() and getIncomingEdges() were BOTH O(e) — iterated ALL
 *    edges for every lookup. Used in centrality, BFS, blast radius, path finding.
 *    With 10k edges, every node visit during BFS did a 10k-iteration scan.
 *    FIX: outEdgeIndex and inEdgeIndex: Map<nodeId, Set<edgeId>>
 *    Both edge lookups are now O(degree) not O(e).
 *
 * 3. removeNode() was O(e) — same full edge scan issue.
 *    FIX: Uses outEdgeIndex + inEdgeIndex for O(degree) removal.
 */

import type { GraphNode, GraphEdge, RelationshipGraph as IRelationshipGraph } from '../../types/index.js';
import { GraphStore } from '../../storage/GraphStore.js';
import { logger } from '../../utils/logger.js';
import { normalizePath } from '../../utils/paths.js';

export class RelationshipGraph implements IRelationshipGraph {
    nodes: Map<string, GraphNode> = new Map();
    edges: Map<string, GraphEdge> = new Map();
    adjacency: Map<string, Set<string>> = new Map();
    reverseAdjacency: Map<string, Set<string>> = new Map();

    // ── Performance indexes ──────────────────────────────────────────────────
    // These are maintained in sync with nodes/edges at all times.

    /** filePath (normalized, lowercase) → Set of nodeIds in that file. O(1) file lookup. */
    private fileIndex: Map<string, Set<string>> = new Map();

    /** nodeId → Set of edgeIds where this node is the SOURCE. O(1) outgoing edge lookup. */
    private outEdgeIndex: Map<string, Set<string>> = new Map();

    /** nodeId → Set of edgeIds where this node is the TARGET. O(1) incoming edge lookup. */
    private inEdgeIndex: Map<string, Set<string>> = new Map();

    constructor(private store: GraphStore) {}

    // ─── Load ─────────────────────────────────────────────────────────────────

    load(): void {
        const nodes = this.store.getAllNodes();
        const edges = this.store.getAllEdges();

        this.nodes.clear();
        this.edges.clear();
        this.adjacency.clear();
        this.reverseAdjacency.clear();
        this.fileIndex.clear();
        this.outEdgeIndex.clear();
        this.inEdgeIndex.clear();

        for (const node of nodes) {
            this.nodes.set(node.id, node);
            this.adjacency.set(node.id, new Set());
            this.reverseAdjacency.set(node.id, new Set());
            this.outEdgeIndex.set(node.id, new Set());
            this.inEdgeIndex.set(node.id, new Set());
            this.indexFileNode(node);
        }

        for (const edge of edges) {
            this.edges.set(edge.id, edge);
            this.adjacency.get(edge.sourceId)?.add(edge.targetId);
            this.reverseAdjacency.get(edge.targetId)?.add(edge.sourceId);
            this.outEdgeIndex.get(edge.sourceId)?.add(edge.id);
            this.inEdgeIndex.get(edge.targetId)?.add(edge.id);
        }

        logger.debug('Graph loaded', { nodes: this.nodes.size, edges: this.edges.size });
    }

    // ─── Add Node ─────────────────────────────────────────────────────────────

    addNode(node: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): GraphNode {
        const persisted = this.store.upsertNode(node);
        this.nodes.set(persisted.id, persisted);

        if (!this.adjacency.has(persisted.id)) this.adjacency.set(persisted.id, new Set());
        if (!this.reverseAdjacency.has(persisted.id)) this.reverseAdjacency.set(persisted.id, new Set());
        if (!this.outEdgeIndex.has(persisted.id)) this.outEdgeIndex.set(persisted.id, new Set());
        if (!this.inEdgeIndex.has(persisted.id)) this.inEdgeIndex.set(persisted.id, new Set());

        this.indexFileNode(persisted);
        return persisted;
    }

    // ─── Add Edge ─────────────────────────────────────────────────────────────

    addEdge(edge: Omit<GraphEdge, 'id' | 'createdAt'> & { id?: string }): GraphEdge {
        if (!this.nodes.has(edge.sourceId) || !this.nodes.has(edge.targetId)) {
            throw new Error(
                `Cannot add edge: node not found (source=${edge.sourceId}, target=${edge.targetId})`
            );
        }

        const persisted = this.store.upsertEdge(edge);
        this.edges.set(persisted.id, persisted);

        // Update all 4 index structures
        if (!this.adjacency.has(edge.sourceId)) this.adjacency.set(edge.sourceId, new Set());
        if (!this.reverseAdjacency.has(edge.targetId)) this.reverseAdjacency.set(edge.targetId, new Set());
        if (!this.outEdgeIndex.has(edge.sourceId)) this.outEdgeIndex.set(edge.sourceId, new Set());
        if (!this.inEdgeIndex.has(edge.targetId)) this.inEdgeIndex.set(edge.targetId, new Set());

        this.adjacency.get(edge.sourceId)!.add(edge.targetId);
        this.reverseAdjacency.get(edge.targetId)!.add(edge.sourceId);
        this.outEdgeIndex.get(edge.sourceId)!.add(persisted.id);
        this.inEdgeIndex.get(edge.targetId)!.add(persisted.id);

        return persisted;
    }

    // ─── Remove Node (O(degree) not O(e)) ────────────────────────────────────

    removeNode(id: string): void {
        const node = this.nodes.get(id);
        if (!node) return;

        // Remove all outgoing edges using the edge index (O(outDegree))
        const outEdgeIds = Array.from(this.outEdgeIndex.get(id) ?? []);
        for (const edgeId of outEdgeIds) {
            const edge = this.edges.get(edgeId);
            if (edge) {
                this.edges.delete(edgeId);
                this.adjacency.get(edge.sourceId)?.delete(edge.targetId);
                this.reverseAdjacency.get(edge.targetId)?.delete(edge.sourceId);
                this.inEdgeIndex.get(edge.targetId)?.delete(edgeId);
            }
        }

        // Remove all incoming edges using the edge index (O(inDegree))
        const inEdgeIds = Array.from(this.inEdgeIndex.get(id) ?? []);
        for (const edgeId of inEdgeIds) {
            const edge = this.edges.get(edgeId);
            if (edge) {
                this.edges.delete(edgeId);
                this.adjacency.get(edge.sourceId)?.delete(edge.targetId);
                this.reverseAdjacency.get(edge.targetId)?.delete(edge.sourceId);
                this.outEdgeIndex.get(edge.sourceId)?.delete(edgeId);
            }
        }

        // Clean up all index entries for this node
        this.adjacency.delete(id);
        this.reverseAdjacency.delete(id);
        this.outEdgeIndex.delete(id);
        this.inEdgeIndex.delete(id);

        // Remove from file index
        const fileKey = normalizePath(node.filePath).toLowerCase();
        this.fileIndex.get(fileKey)?.delete(id);
        if (this.fileIndex.get(fileKey)?.size === 0) {
            this.fileIndex.delete(fileKey);
        }

        this.nodes.delete(id);
        this.store.deleteNode(id);
    }

    removeNodesForFile(filePath: string): void {
        // Use the O(1) file index instead of scanning all nodes
        const fileKey = normalizePath(filePath).toLowerCase();
        const nodeIds = Array.from(this.fileIndex.get(fileKey) ?? []);
        for (const nodeId of nodeIds) {
            this.removeNode(nodeId);
        }
    }

    // ─── Queries — now O(1) or O(degree) ─────────────────────────────────────

    getNode(id: string): GraphNode | undefined {
        return this.nodes.get(id);
    }

    /** O(1) — uses fileIndex. Was O(n). */
    getNodesByFile(filePath: string): GraphNode[] {
        const fileKey = normalizePath(filePath).toLowerCase();
        const nodeIds = this.fileIndex.get(fileKey);
        if (!nodeIds || nodeIds.size === 0) return [];
        const result: GraphNode[] = [];
        for (const id of nodeIds) {
            const node = this.nodes.get(id);
            if (node) result.push(node);
        }
        return result;
    }

    /** O(outDegree) — uses outEdgeIndex. Was O(e). */
    getOutgoingEdges(nodeId: string): GraphEdge[] {
        const edgeIds = this.outEdgeIndex.get(nodeId);
        if (!edgeIds || edgeIds.size === 0) return [];
        const result: GraphEdge[] = [];
        for (const id of edgeIds) {
            const edge = this.edges.get(id);
            if (edge) result.push(edge);
        }
        return result;
    }

    /** O(inDegree) — uses inEdgeIndex. Was O(e). */
    getIncomingEdges(nodeId: string): GraphEdge[] {
        const edgeIds = this.inEdgeIndex.get(nodeId);
        if (!edgeIds || edgeIds.size === 0) return [];
        const result: GraphEdge[] = [];
        for (const id of edgeIds) {
            const edge = this.edges.get(id);
            if (edge) result.push(edge);
        }
        return result;
    }

    getDirectDependencies(nodeId: string): GraphNode[] {
        const targetIds = this.adjacency.get(nodeId) ?? new Set();
        return Array.from(targetIds)
            .map(id => this.nodes.get(id))
            .filter(Boolean) as GraphNode[];
    }

    getDirectDependents(nodeId: string): GraphNode[] {
        const sourceIds = this.reverseAdjacency.get(nodeId) ?? new Set();
        return Array.from(sourceIds)
            .map(id => this.nodes.get(id))
            .filter(Boolean) as GraphNode[];
    }

    getNeighbors(nodeId: string): GraphNode[] {
        const deps = this.getDirectDependencies(nodeId);
        const dependents = this.getDirectDependents(nodeId);
        const seen = new Set<string>();
        const combined: GraphNode[] = [];
        for (const n of [...deps, ...dependents]) {
            if (!seen.has(n.id)) {
                seen.add(n.id);
                combined.push(n);
            }
        }
        return combined;
    }

    getAllDependents(nodeId: string, maxDepth = 10): Map<string, number> {
        const visited = new Map<string, number>();
        const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

        while (queue.length > 0) {
            const item = queue.shift()!;
            if (item.depth > maxDepth) continue;

            const dependents = this.reverseAdjacency.get(item.id) ?? new Set();
            for (const depId of dependents) {
                if (!visited.has(depId) && depId !== nodeId) {
                    visited.set(depId, item.depth + 1);
                    queue.push({ id: depId, depth: item.depth + 1 });
                }
            }
        }

        return visited;
    }

    getStats(): { nodeCount: number; edgeCount: number; layerBreakdown: Record<string, number> } {
        const layerBreakdown: Record<string, number> = {};
        for (const node of this.nodes.values()) {
            layerBreakdown[node.layer] = (layerBreakdown[node.layer] ?? 0) + 1;
        }
        return {
            nodeCount: this.nodes.size,
            edgeCount: this.edges.size,
            layerBreakdown,
        };
    }

    findNodesByName(name: string): GraphNode[] {
        const lower = name.toLowerCase();
        return Array.from(this.nodes.values()).filter(n =>
            n.name.toLowerCase().includes(lower)
        );
    }

    findNodesByLayer(layer: string): GraphNode[] {
        return Array.from(this.nodes.values()).filter(n => n.layer === layer);
    }

    exportJSON(): object {
        return {
            nodes: Array.from(this.nodes.values()),
            edges: Array.from(this.edges.values()),
        };
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private indexFileNode(node: GraphNode): void {
        const fileKey = normalizePath(node.filePath).toLowerCase();
        if (!this.fileIndex.has(fileKey)) {
            this.fileIndex.set(fileKey, new Set());
        }
        this.fileIndex.get(fileKey)!.add(node.id);
    }
}