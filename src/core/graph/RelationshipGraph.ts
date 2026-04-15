import type { GraphNode, GraphEdge, RelationshipGraph as IRelationshipGraph } from '../../types/index.js';
import { GraphStore } from '../../storage/GraphStore.js';
import { logger } from '../../utils/logger.js';
import { normalizePath } from '../../utils/paths.js';

export class RelationshipGraph implements IRelationshipGraph {
    nodes: Map<string, GraphNode> = new Map();
    edges: Map<string, GraphEdge> = new Map();
    adjacency: Map<string, Set<string>> = new Map();
    reverseAdjacency: Map<string, Set<string>> = new Map();

    constructor(private store: GraphStore) { }

    load(): void {
        const nodes = this.store.getAllNodes();
        const edges = this.store.getAllEdges();

        this.nodes.clear();
        this.edges.clear();
        this.adjacency.clear();
        this.reverseAdjacency.clear();

        for (const node of nodes) {
            this.nodes.set(node.id, node);
            this.adjacency.set(node.id, new Set());
            this.reverseAdjacency.set(node.id, new Set());
        }

        for (const edge of edges) {
            this.edges.set(edge.id, edge);
            if (!this.adjacency.has(edge.sourceId)) this.adjacency.set(edge.sourceId, new Set());
            if (!this.reverseAdjacency.has(edge.targetId)) this.reverseAdjacency.set(edge.targetId, new Set());
            this.adjacency.get(edge.sourceId)!.add(edge.targetId);
            this.reverseAdjacency.get(edge.targetId)!.add(edge.sourceId);
        }

        logger.debug('Graph loaded', { nodes: this.nodes.size, edges: this.edges.size });
    }

    addNode(node: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): GraphNode {
        const persisted = this.store.upsertNode(node);
        this.nodes.set(persisted.id, persisted);
        if (!this.adjacency.has(persisted.id)) this.adjacency.set(persisted.id, new Set());
        if (!this.reverseAdjacency.has(persisted.id)) this.reverseAdjacency.set(persisted.id, new Set());
        return persisted;
    }

    addEdge(edge: Omit<GraphEdge, 'id' | 'createdAt'> & { id?: string }): GraphEdge {
        if (!this.nodes.has(edge.sourceId) || !this.nodes.has(edge.targetId)) {
            throw new Error(`Cannot add edge: node not found (source=${edge.sourceId}, target=${edge.targetId})`);
        }
        const persisted = this.store.upsertEdge(edge);
        this.edges.set(persisted.id, persisted);

        if (!this.adjacency.has(edge.sourceId)) this.adjacency.set(edge.sourceId, new Set());
        if (!this.reverseAdjacency.has(edge.targetId)) this.reverseAdjacency.set(edge.targetId, new Set());

        this.adjacency.get(edge.sourceId)!.add(edge.targetId);
        this.reverseAdjacency.get(edge.targetId)!.add(edge.sourceId);

        return persisted;
    }

    removeNode(id: string): void {
        const node = this.nodes.get(id);
        if (!node) return;

        const edgesToRemove = Array.from(this.edges.values()).filter(
            e => e.sourceId === id || e.targetId === id
        );

        for (const edge of edgesToRemove) {
            this.edges.delete(edge.id);
            this.adjacency.get(edge.sourceId)?.delete(edge.targetId);
            this.reverseAdjacency.get(edge.targetId)?.delete(edge.sourceId);
        }

        this.adjacency.delete(id);
        this.reverseAdjacency.delete(id);
        this.nodes.delete(id);
        this.store.deleteNode(id);
    }

    removeNodesForFile(filePath: string): void {
        const fileNodes = this.getNodesByFile(filePath);
        for (const node of fileNodes) {
            this.removeNode(node.id);
        }
    }

    getNode(id: string): GraphNode | undefined {
        return this.nodes.get(id);
    }

    getNodesByFile(filePath: string): GraphNode[] {
        const normalized = normalizePath(filePath).toLowerCase();
        return Array.from(this.nodes.values()).filter(n => 
            normalizePath(n.filePath).toLowerCase() === normalized
        );
    }

    getOutgoingEdges(nodeId: string): GraphEdge[] {
        return Array.from(this.edges.values()).filter(e => e.sourceId === nodeId);
    }

    getIncomingEdges(nodeId: string): GraphEdge[] {
        return Array.from(this.edges.values()).filter(e => e.targetId === nodeId);
    }

    getDirectDependencies(nodeId: string): GraphNode[] {
        const targetIds = this.adjacency.get(nodeId) ?? new Set();
        return Array.from(targetIds).map(id => this.nodes.get(id)).filter(Boolean) as GraphNode[];
    }

    getDirectDependents(nodeId: string): GraphNode[] {
        const sourceIds = this.reverseAdjacency.get(nodeId) ?? new Set();
        return Array.from(sourceIds).map(id => this.nodes.get(id)).filter(Boolean) as GraphNode[];
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
        return Array.from(this.nodes.values()).filter(n => n.name.toLowerCase().includes(lower));
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
}