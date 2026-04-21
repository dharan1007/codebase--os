import type { RelationshipGraph } from '../graph/RelationshipGraph.js';
import type { GraphNode } from '../../types/index.js';
import path from 'path';

export interface PlannedFile {
    filePath: string;
    relativePath: string;
    layer: string;
    dependentCount: number;
    dependencyCount: number;
    executionOrder: number;
    reason: string;
    isRoot: boolean;
}

export interface BlastRadiusReport {
    rootFiles: string[];
    affectedFiles: PlannedFile[];
    layerBreakdown: Record<string, number>;
    crossLayerWarnings: string[];
    cycles: string[];
    totalFiles: number;
    executionPlan: string[];
    estimatedComplexity: 'low' | 'medium' | 'high';
}

/**
 * TopologicalPlanner — the core differentiator of Codebase OS.
 *
 * Codex, Claude Code, and Cursor make file changes in arbitrary order.
 * This engine computes the mathematically correct execution order using
 * Kahn's topological sort over the persistent relationship graph.
 *
 * Before the agent writes a single line:
 *  1. Identify the root files involved in the task
 *  2. BFS backward  → find all dependents (will break if we don't update them)
 *  3. BFS forward   → find all dependencies (must be changed first)
 *  4. Kahn's sort   → execution order where leaf files (most depended-on) go first
 *  5. Return a blast radius report with cross-layer warnings and cycle detection
 */
export class TopologicalPlanner {
    constructor(private graph: RelationshipGraph, private rootDir: string) {}

    /**
     * Given a natural-language task string, find the most relevant root files
     * and compute a topologically sorted execution plan.
     */
    planFromTask(task: string): BlastRadiusReport {
        const keywords = task
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 3 && !['this', 'that', 'with', 'from', 'make', 'change', 'update', 'refactor', 'fix', 'add', 'remove'].includes(w));

        const candidateNodes = Array.from(this.graph.nodes.values())
            .filter(n => n.kind === 'file' || n.kind === 'function' || n.kind === 'class' || n.kind === 'interface')
            .map(n => {
                let score = 0;
                const name = n.name.toLowerCase();
                const fp = n.filePath.toLowerCase();
                for (const kw of keywords) {
                    if (name === kw) score += 10;
                    else if (name.includes(kw)) score += 5;
                    if (fp.includes(kw)) score += 3;
                }
                return { node: n, score };
            })
            .filter(x => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 5)
            .map(x => x.node.filePath);

        const uniqueRoots = [...new Set(candidateNodes)];
        if (uniqueRoots.length === 0) {
            return {
                rootFiles: [],
                affectedFiles: [],
                layerBreakdown: {},
                crossLayerWarnings: [],
                cycles: [],
                totalFiles: 0,
                executionPlan: [],
                estimatedComplexity: 'low',
            };
        }

        return this.planFromFiles(uniqueRoots);
    }

    /**
     * Given specific file paths, compute the full blast radius and sorted plan.
     */
    planFromFiles(rootFilePaths: string[]): BlastRadiusReport {
        // Collect root node IDs
        const rootNodeIds = new Set<string>();
        const rootFileSet = new Set<string>();

        for (const fp of rootFilePaths) {
            const abs = path.isAbsolute(fp) ? fp : path.resolve(this.rootDir, fp);
            rootFileSet.add(abs);
            const nodes = this.graph.getNodesByFile(abs);
            for (const n of nodes) rootNodeIds.add(n.id);
        }

        if (rootNodeIds.size === 0) {
            return {
                rootFiles: rootFilePaths,
                affectedFiles: [],
                layerBreakdown: {},
                crossLayerWarnings: [],
                cycles: [],
                totalFiles: 0,
                executionPlan: rootFilePaths,
                estimatedComplexity: 'low',
            };
        }

        const affectedIds = new Map<string, { depth: number; reason: string }>();

        // Seed with roots
        for (const id of rootNodeIds) {
            affectedIds.set(id, { depth: 0, reason: 'root' });
        }

        // Forward BFS: anything the root depends ON (we may need to update these first)
        const fwdQueue: Array<{ id: string; depth: number }> = [...rootNodeIds].map(id => ({ id, depth: 1 }));
        const fwdVisited = new Set<string>(rootNodeIds);
        while (fwdQueue.length > 0) {
            const { id, depth } = fwdQueue.shift()!;
            if (depth > 4) continue;
            for (const dep of (this.graph.adjacency.get(id) ?? new Set())) {
                if (!fwdVisited.has(dep)) {
                    fwdVisited.add(dep);
                    affectedIds.set(dep, { depth, reason: `dependency (depth ${depth})` });
                    fwdQueue.push({ id: dep, depth: depth + 1 });
                }
            }
        }

        // Backward BFS: anything that IMPORTS the root (will break without updates)
        const bwdQueue: Array<{ id: string; depth: number }> = [...rootNodeIds].map(id => ({ id, depth: 1 }));
        const bwdVisited = new Set<string>(rootNodeIds);
        while (bwdQueue.length > 0) {
            const { id, depth } = bwdQueue.shift()!;
            if (depth > 4) continue;
            for (const dep of (this.graph.reverseAdjacency.get(id) ?? new Set())) {
                if (!bwdVisited.has(dep)) {
                    bwdVisited.add(dep);
                    if (!affectedIds.has(dep)) {
                        affectedIds.set(dep, { depth, reason: `dependent (will break at depth ${depth})` });
                    }
                    bwdQueue.push({ id: dep, depth: depth + 1 });
                }
            }
        }

        // Topological sort via Kahn's algorithm
        const topoOrder = this.kahnsSort([...affectedIds.keys()]);

        // Deduplicate by file, accumulate into PlannedFile list
        const fileMap = new Map<string, PlannedFile>();
        let order = 1;
        for (const nodeId of topoOrder) {
            const node = this.graph.getNode(nodeId);
            if (!node || fileMap.has(node.filePath)) continue;
            const rel = path.relative(this.rootDir, node.filePath).replace(/\\/g, '/');
            const info = affectedIds.get(nodeId)!;
            fileMap.set(node.filePath, {
                filePath: node.filePath,
                relativePath: rel,
                layer: node.layer,
                dependentCount: this.graph.reverseAdjacency.get(nodeId)?.size ?? 0,
                dependencyCount: this.graph.adjacency.get(nodeId)?.size ?? 0,
                executionOrder: order++,
                reason: info.reason,
                isRoot: rootFileSet.has(node.filePath),
            });
        }

        const files = [...fileMap.values()];

        // Layer breakdown
        const layerBreakdown: Record<string, number> = {};
        for (const f of files) {
            layerBreakdown[f.layer] = (layerBreakdown[f.layer] ?? 0) + 1;
        }

        // Cross-layer warnings — unexpected layer boundary crossings
        const crossLayerSet = new Set<string>();
        for (const edge of this.graph.edges.values()) {
            if (!affectedIds.has(edge.sourceId) || !affectedIds.has(edge.targetId)) continue;
            const src = this.graph.getNode(edge.sourceId);
            const tgt = this.graph.getNode(edge.targetId);
            if (!src || !tgt || src.layer === tgt.layer) continue;
            crossLayerSet.add(`${src.name} (${src.layer}) -> ${tgt.name} (${tgt.layer})`);
        }

        // Cycle detection
        const cycles = this.detectCycles([...affectedIds.keys()]);

        const complexity = files.length >= 20 ? 'high' : files.length >= 8 ? 'medium' : 'low';

        return {
            rootFiles: rootFilePaths,
            affectedFiles: files,
            layerBreakdown,
            crossLayerWarnings: [...crossLayerSet].slice(0, 10),
            cycles: cycles.slice(0, 5),
            totalFiles: files.length,
            executionPlan: files.map(f => f.relativePath),
            estimatedComplexity: complexity,
        };
    }

    /**
     * Kahn's algorithm — O(V+E) topological sort.
     * Produces deterministic ordering where nodes with zero in-degree come first
     * (i.e., foundational files that nothing imports — change these first).
     */
    private kahnsSort(nodeIds: string[]): string[] {
        const idSet = new Set(nodeIds);
        const inDegree = new Map<string, number>(nodeIds.map(id => [id, 0]));
        const adj = new Map<string, string[]>(nodeIds.map(id => [id, []]));

        for (const id of nodeIds) {
            for (const dep of (this.graph.adjacency.get(id) ?? new Set())) {
                if (idSet.has(dep)) {
                    adj.get(id)!.push(dep);
                    inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1);
                }
            }
        }

        const queue: string[] = [];
        for (const [id, deg] of inDegree) {
            if (deg === 0) queue.push(id);
        }

        const result: string[] = [];
        while (queue.length > 0) {
            const current = queue.shift()!;
            result.push(current);
            for (const neighbor of (adj.get(current) ?? [])) {
                const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
                inDegree.set(neighbor, newDeg);
                if (newDeg === 0) queue.push(neighbor);
            }
        }

        // Append cycle participants (couldn't be sorted)
        for (const id of nodeIds) {
            if (!result.includes(id)) result.push(id);
        }

        return result;
    }

    private detectCycles(nodeIds: string[]): string[] {
        const idSet = new Set(nodeIds);
        const cycles: string[] = [];
        const visited = new Set<string>();
        const stack = new Set<string>();
        const pathArr: string[] = [];

        const dfs = (id: string): void => {
            if (cycles.length >= 5) return;
            visited.add(id);
            stack.add(id);
            pathArr.push(id);
            for (const neighbor of (this.graph.adjacency.get(id) ?? new Set())) {
                if (!idSet.has(neighbor)) continue;
                if (!visited.has(neighbor)) dfs(neighbor);
                else if (stack.has(neighbor)) {
                    const start = pathArr.indexOf(neighbor);
                    if (start !== -1) {
                        const names = pathArr.slice(start).map(nid => this.graph.getNode(nid)?.name ?? nid);
                        cycles.push(names.join(' -> '));
                    }
                }
            }
            pathArr.pop();
            stack.delete(id);
        };

        for (const id of nodeIds) {
            if (!visited.has(id)) dfs(id);
        }
        return cycles;
    }
}
