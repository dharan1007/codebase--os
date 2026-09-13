/** O(1)-indexed in-memory relationship graph backed by GraphStore. */
import type { GraphNode, GraphEdge, RelationshipGraph as IRelationshipGraph } from '../../types/index.js';
import { GraphStore } from '../../storage/GraphStore.js';
import { logger } from '../../utils/logger.js';
import { normalizePath } from '../../utils/paths.js';

export class RelationshipGraph implements IRelationshipGraph {
    nodes: Map<string, GraphNode> = new Map();
    edges: Map<string, GraphEdge> = new Map();
    adjacency: Map<string, Set<string>> = new Map();
    reverseAdjacency: Map<string, Set<string>> = new Map();

    private fileIndex: Map<string, Set<string>> = new Map();
    private outEdgeIndex: Map<string, Set<string>> = new Map();
    private inEdgeIndex: Map<string, Set<string>> = new Map();

    constructor(private store: GraphStore) {}

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

    addNode(node: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): GraphNode {
        const persisted = this.store.upsertNode(node);
        const previous = this.nodes.get(persisted.id);
        if (previous && this.fileKey(previous.filePath) !== this.fileKey(persisted.filePath)) {
            this.removeFromFileIndex(previous);
        }
        this.nodes.set(persisted.id, persisted);
        if (!this.adjacency.has(persisted.id)) this.adjacency.set(persisted.id, new Set());
        if (!this.reverseAdjacency.has(persisted.id)) this.reverseAdjacency.set(persisted.id, new Set());
        if (!this.outEdgeIndex.has(persisted.id)) this.outEdgeIndex.set(persisted.id, new Set());
        if (!this.inEdgeIndex.has(persisted.id)) this.inEdgeIndex.set(persisted.id, new Set());
        this.indexFileNode(persisted);
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
        if (!this.outEdgeIndex.has(edge.sourceId)) this.outEdgeIndex.set(edge.sourceId, new Set());
        if (!this.inEdgeIndex.has(edge.targetId)) this.inEdgeIndex.set(edge.targetId, new Set());
        this.adjacency.get(edge.sourceId)!.add(edge.targetId);
        this.reverseAdjacency.get(edge.targetId)!.add(edge.sourceId);
        this.outEdgeIndex.get(edge.sourceId)!.add(persisted.id);
        this.inEdgeIndex.get(edge.targetId)!.add(persisted.id);
        return persisted;
    }

    removeNode(id: string): void {
        const node = this.nodes.get(id);
        if (!node) return;

        for (const edgeId of Array.from(this.outEdgeIndex.get(id) ?? [])) {
            const edge = this.edges.get(edgeId);
            if (!edge) continue;
            this.edges.delete(edgeId);
            this.adjacency.get(edge.sourceId)?.delete(edge.targetId);
            this.reverseAdjacency.get(edge.targetId)?.delete(edge.sourceId);
            this.inEdgeIndex.get(edge.targetId)?.delete(edgeId);
        }
        for (const edgeId of Array.from(this.inEdgeIndex.get(id) ?? [])) {
            const edge = this.edges.get(edgeId);
            if (!edge) continue;
            this.edges.delete(edgeId);
            this.adjacency.get(edge.sourceId)?.delete(edge.targetId);
            this.reverseAdjacency.get(edge.targetId)?.delete(edge.sourceId);
            this.outEdgeIndex.get(edge.sourceId)?.delete(edgeId);
        }

        this.adjacency.delete(id);
        this.reverseAdjacency.delete(id);
        this.outEdgeIndex.delete(id);
        this.inEdgeIndex.delete(id);
        this.removeFromFileIndex(node);
        this.nodes.delete(id);
        this.store.deleteNode(id);
    }

    removeNodesForFile(filePath: string): void {
        const nodeIds = Array.from(this.fileIndex.get(this.fileKey(filePath)) ?? []);
        for (const nodeId of nodeIds) this.removeNode(nodeId);
    }

    getNode(id: string): GraphNode | undefined {
        return this.nodes.get(id);
    }

    getNodesByFile(filePath: string): GraphNode[] {
        const nodeIds = this.fileIndex.get(this.fileKey(filePath));
        if (!nodeIds?.size) return [];
        const result: GraphNode[] = [];
        for (const id of nodeIds) {
            const node = this.nodes.get(id);
            if (node) result.push(node);
        }
        return result;
    }

    getOutgoingEdges(nodeId: string): GraphEdge[] {
        const edgeIds = this.outEdgeIndex.get(nodeId);
        if (!edgeIds?.size) return [];
        const result: GraphEdge[] = [];
        for (const id of edgeIds) {
            const edge = this.edges.get(id);
            if (edge) result.push(edge);
        }
        return result;
    }

    getIncomingEdges(nodeId: string): GraphEdge[] {
        const edgeIds = this.inEdgeIndex.get(nodeId);
        if (!edgeIds?.size) return [];
        const result: GraphEdge[] = [];
        for (const id of edgeIds) {
            const edge = this.edges.get(id);
            if (edge) result.push(edge);
        }
        return result;
    }

    getDirectDependencies(nodeId: string): GraphNode[] {
        return Array.from(this.adjacency.get(nodeId) ?? [])
            .map(id => this.nodes.get(id))
            .filter(Boolean) as GraphNode[];
    }

    getDirectDependents(nodeId: string): GraphNode[] {
        return Array.from(this.reverseAdjacency.get(nodeId) ?? [])
            .map(id => this.nodes.get(id))
            .filter(Boolean) as GraphNode[];
    }

    getNeighbors(nodeId: string): GraphNode[] {
        const seen = new Set<string>();
        const combined: GraphNode[] = [];
        for (const node of [...this.getDirectDependencies(nodeId), ...this.getDirectDependents(nodeId)]) {
            if (seen.has(node.id)) continue;
            seen.add(node.id);
            combined.push(node);
        }
        return combined;
    }

    getAllDependents(nodeId: string, maxDepth = 10): Map<string, number> {
        const visited = new Map<string, number>();
        const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];
        let index = 0;
        while (index < queue.length) {
            const item = queue[index++]!;
            if (item.depth >= maxDepth) continue;
            for (const depId of this.reverseAdjacency.get(item.id) ?? []) {
                if (depId === nodeId || visited.has(depId)) continue;
                visited.set(depId, item.depth + 1);
                queue.push({ id: depId, depth: item.depth + 1 });
            }
        }
        return visited;
    }

    getStats(): { nodeCount: number; edgeCount: number; layerBreakdown: Record<string, number> } {
        const layerBreakdown: Record<string, number> = {};
        for (const node of this.nodes.values()) layerBreakdown[node.layer] = (layerBreakdown[node.layer] ?? 0) + 1;
        return { nodeCount: this.nodes.size, edgeCount: this.edges.size, layerBreakdown };
    }

    findNodesByName(name: string): GraphNode[] {
        const lower = name.toLowerCase();
        return Array.from(this.nodes.values()).filter(node => node.name.toLowerCase().includes(lower));
    }

    findNodesByLayer(layer: string): GraphNode[] {
        return Array.from(this.nodes.values()).filter(node => node.layer === layer);
    }

    exportJSON(): object {
        return { nodes: Array.from(this.nodes.values()), edges: Array.from(this.edges.values()) };
    }

    /**
     * Windows paths are case-insensitive. POSIX paths are case-sensitive and
     * must preserve Foo.ts and foo.ts as distinct files. Do not lowercase Linux
     * or macOS paths: case-sensitive APFS volumes are valid on macOS too.
     */
    private fileKey(filePath: string): string {
        const normalized = normalizePath(filePath);
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    }

    private indexFileNode(node: GraphNode): void {
        const key = this.fileKey(node.filePath);
        if (!this.fileIndex.has(key)) this.fileIndex.set(key, new Set());
        this.fileIndex.get(key)!.add(node.id);
    }

    private removeFromFileIndex(node: GraphNode): void {
        const key = this.fileKey(node.filePath);
        const ids = this.fileIndex.get(key);
        ids?.delete(node.id);
        if (ids?.size === 0) this.fileIndex.delete(key);
    }
}
