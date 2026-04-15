import { Database } from './Database.js';
import type { GraphNode, GraphEdge } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

interface NodeRow {
    id: string;
    kind: string;
    name: string;
    file_path: string;
    layer: string;
    language: string;
    signature: string | null;
    doc_comment: string | null;
    location_json: string | null;
    metadata_json: string;
    hash: string;
    created_at: number;
    updated_at: number;
}

interface EdgeRow {
    id: string;
    kind: string;
    source_id: string;
    target_id: string;
    weight: number;
    metadata_json: string;
    created_at: number;
}

export class GraphStore {
    constructor(private db: Database) { }

    upsertNode(node: Omit<GraphNode, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): GraphNode {
        const now = Date.now();
        const existing = this.getNodeByNameAndFile(node.name, node.filePath, node.kind);

        if (existing) {
            this.db.prepare(`
        UPDATE graph_nodes SET
          kind = ?, name = ?, file_path = ?, layer = ?, language = ?,
          signature = ?, doc_comment = ?, location_json = ?,
          metadata_json = ?, hash = ?, updated_at = ?
        WHERE id = ?
      `).run(
                node.kind, node.name, node.filePath, node.layer, node.language,
                node.signature ?? null, node.docComment ?? null,
                node.location ? JSON.stringify(node.location) : null,
                JSON.stringify(node.metadata), node.hash, now,
                existing.id
            );
            return { ...existing, ...node, updatedAt: now };
        }

        const id = node.id ?? uuidv4();
        this.db.prepare(`
      INSERT INTO graph_nodes
        (id, kind, name, file_path, layer, language, signature, doc_comment,
         location_json, metadata_json, hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
            id, node.kind, node.name, node.filePath, node.layer, node.language,
            node.signature ?? null, node.docComment ?? null,
            node.location ? JSON.stringify(node.location) : null,
            JSON.stringify(node.metadata), node.hash, now, now
        );

        return { id, createdAt: now, updatedAt: now, ...node };
    }

    getNodeById(id: string): GraphNode | null {
        const row = this.db.prepare('SELECT * FROM graph_nodes WHERE id = ?').get(id) as NodeRow | undefined;
        return row ? this.rowToNode(row) : null;
    }

    getNodeByNameAndFile(name: string, filePath: string, kind: string): GraphNode | null {
        const row = this.db.prepare(
            'SELECT * FROM graph_nodes WHERE name = ? AND file_path = ? AND kind = ?'
        ).get(name, filePath, kind) as NodeRow | undefined;
        return row ? this.rowToNode(row) : null;
    }

    getNodesByFile(filePath: string): GraphNode[] {
        const rows = this.db.prepare('SELECT * FROM graph_nodes WHERE file_path = ?').all(filePath) as NodeRow[];
        return rows.map(r => this.rowToNode(r));
    }

    getNodesByKind(kind: string): GraphNode[] {
        const rows = this.db.prepare('SELECT * FROM graph_nodes WHERE kind = ?').all(kind) as NodeRow[];
        return rows.map(r => this.rowToNode(r));
    }

    getNodesByLayer(layer: string): GraphNode[] {
        const rows = this.db.prepare('SELECT * FROM graph_nodes WHERE layer = ?').all(layer) as NodeRow[];
        return rows.map(r => this.rowToNode(r));
    }

    searchNodesByName(query: string): GraphNode[] {
        const rows = this.db.prepare(
            "SELECT * FROM graph_nodes WHERE name LIKE ? LIMIT 50"
        ).all(`%${query}%`) as NodeRow[];
        return rows.map(r => this.rowToNode(r));
    }

    deleteNodesByFile(filePath: string): void {
        this.db.prepare('DELETE FROM graph_nodes WHERE file_path = ?').run(filePath);
    }

    deleteNode(id: string): void {
        this.db.prepare('DELETE FROM graph_nodes WHERE id = ?').run(id);
    }

    getAllNodes(): GraphNode[] {
        const rows = this.db.prepare('SELECT * FROM graph_nodes').all() as NodeRow[];
        return rows.map(r => this.rowToNode(r));
    }

    upsertEdge(edge: Omit<GraphEdge, 'id' | 'createdAt'> & { id?: string }): GraphEdge {
        const existing = this.db.prepare(
            'SELECT id FROM graph_edges WHERE source_id = ? AND target_id = ? AND kind = ?'
        ).get(edge.sourceId, edge.targetId, edge.kind) as { id: string } | undefined;

        const now = Date.now();
        if (existing) {
            this.db.prepare(
                'UPDATE graph_edges SET weight = ?, metadata_json = ? WHERE id = ?'
            ).run(edge.weight, JSON.stringify(edge.metadata), existing.id);
            return { id: existing.id, createdAt: now, ...edge };
        }

        const id = edge.id ?? uuidv4();
        this.db.prepare(`
      INSERT INTO graph_edges (id, kind, source_id, target_id, weight, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, edge.kind, edge.sourceId, edge.targetId, edge.weight, JSON.stringify(edge.metadata), now);

        return { id, createdAt: now, ...edge };
    }

    getEdgesBySource(sourceId: string): GraphEdge[] {
        const rows = this.db.prepare('SELECT * FROM graph_edges WHERE source_id = ?').all(sourceId) as EdgeRow[];
        return rows.map(r => this.rowToEdge(r));
    }

    getEdgesByTarget(targetId: string): GraphEdge[] {
        const rows = this.db.prepare('SELECT * FROM graph_edges WHERE target_id = ?').all(targetId) as EdgeRow[];
        return rows.map(r => this.rowToEdge(r));
    }

    getEdgesBetween(sourceId: string, targetId: string): GraphEdge[] {
        const rows = this.db.prepare(
            'SELECT * FROM graph_edges WHERE source_id = ? AND target_id = ?'
        ).all(sourceId, targetId) as EdgeRow[];
        return rows.map(r => this.rowToEdge(r));
    }

    deleteEdgesByNodeId(nodeId: string): void {
        this.db.prepare('DELETE FROM graph_edges WHERE source_id = ? OR target_id = ?').run(nodeId, nodeId);
    }

    getAllEdges(): GraphEdge[] {
        const rows = this.db.prepare('SELECT * FROM graph_edges').all() as EdgeRow[];
        return rows.map(r => this.rowToEdge(r));
    }

    getNodeCount(): number {
        const result = this.db.prepare('SELECT COUNT(*) as count FROM graph_nodes').get() as { count: number };
        return result.count;
    }

    getEdgeCount(): number {
        const result = this.db.prepare('SELECT COUNT(*) as count FROM graph_edges').get() as { count: number };
        return result.count;
    }

    private rowToNode(row: NodeRow): GraphNode {
        return {
            id: row.id,
            kind: row.kind as GraphNode['kind'],
            name: row.name,
            filePath: row.file_path,
            layer: row.layer as GraphNode['layer'],
            language: row.language as GraphNode['language'],
            signature: row.signature ?? undefined,
            docComment: row.doc_comment ?? undefined,
            location: row.location_json ? JSON.parse(row.location_json) : undefined,
            metadata: JSON.parse(row.metadata_json),
            hash: row.hash,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    private rowToEdge(row: EdgeRow): GraphEdge {
        return {
            id: row.id,
            kind: row.kind as GraphEdge['kind'],
            sourceId: row.source_id,
            targetId: row.target_id,
            weight: row.weight,
            metadata: JSON.parse(row.metadata_json),
            createdAt: row.created_at,
        };
    }
}