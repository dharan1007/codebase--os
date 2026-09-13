import type { RelationshipGraph } from '../graph/RelationshipGraph.js';
import type { EdgeKind, GraphEdge } from '../../types/index.js';
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
 * Relationship kinds that express a dependency from source -> target.
 *
 * Deliberately excluded:
 * - provides / exports: containment or publication, not execution dependencies
 * - tests: a test is evidence for a target, not a prerequisite to edit it
 *
 * Keeping this explicit prevents containment/test edges from corrupting
 * blast-radius traversal and topological ordering.
 */
const DEPENDENCY_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
    'imports',
    'calls',
    'extends',
    'implements',
    'uses_type',
    'reads_from',
    'writes_to',
    'depends_on',
    'references',
    'api_uses',
    'db_uses',
    'renders',
]);

interface AffectedInfo {
    depth: number;
    reason: string;
}

/**
 * TopologicalPlanner computes a dependency-first file execution plan.
 *
 * Graph convention:
 *   source -> target means "source depends on target".
 *
 * For execution, that relationship is inverted into:
 *   target -> source
 *
 * before Kahn's algorithm is applied. This guarantees that a dependency is
 * emitted before a consumer whenever the dependency subgraph is acyclic.
 */
export class TopologicalPlanner {
    constructor(private graph: RelationshipGraph, private rootDir: string) {}

    planFromTask(task: string, maxDepthOverride?: number): BlastRadiusReport {
        const keywords = task
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 3 && ![
                'this', 'that', 'with', 'from', 'make', 'change', 'update',
                'refactor', 'fix', 'add', 'remove', 'into', 'using', 'should',
            ].includes(w));

        const candidateFiles = Array.from(this.graph.nodes.values())
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
                return { filePath: n.filePath, score };
            })
            .filter(x => x.score > 0)
            .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));

        const uniqueRoots: string[] = [];
        const seen = new Set<string>();
        for (const candidate of candidateFiles) {
            if (seen.has(candidate.filePath)) continue;
            seen.add(candidate.filePath);
            uniqueRoots.push(candidate.filePath);
            if (uniqueRoots.length >= 5) break;
        }

        if (uniqueRoots.length === 0) return this.emptyReport([]);
        return this.planFromFiles(uniqueRoots, maxDepthOverride);
    }

    planFromFiles(rootFilePaths: string[], maxDepthOverride?: number): BlastRadiusReport {
        const rootNodeIds = new Set<string>();
        const rootFileSet = new Set<string>();

        for (const filePath of rootFilePaths) {
            const absolute = path.isAbsolute(filePath)
                ? path.resolve(filePath)
                : path.resolve(this.rootDir, filePath);
            rootFileSet.add(absolute);
            for (const node of this.graph.getNodesByFile(absolute)) {
                rootNodeIds.add(node.id);
            }
        }

        if (rootNodeIds.size === 0) {
            return {
                ...this.emptyReport(rootFilePaths),
                executionPlan: rootFilePaths,
            };
        }

        const maxDependents = Math.max(
            ...Array.from(rootNodeIds, id => this.getDependentNodeIds(id).length),
            0,
        );
        const adaptiveDepth = this.resolveDepth(maxDependents, maxDepthOverride);

        const affectedIds = new Map<string, AffectedInfo>();
        for (const id of rootNodeIds) {
            affectedIds.set(id, { depth: 0, reason: 'root' });
        }

        this.walkDependencies(rootNodeIds, adaptiveDepth, affectedIds);
        this.walkDependents(rootNodeIds, adaptiveDepth, affectedIds);

        const fileInfo = this.collapseAffectedNodesToFiles(affectedIds, rootFileSet);
        const affectedFileSet = new Set(fileInfo.keys());
        const dependencyMap = this.buildFileDependencyMap(affectedFileSet);
        const dependentMap = this.reverseFileDependencyMap(dependencyMap);
        const { order: fileOrder, cyclicFiles } = this.topologicallySortFiles(dependencyMap);

        const files: PlannedFile[] = [];
        let executionOrder = 1;
        for (const filePath of fileOrder) {
            const info = fileInfo.get(filePath);
            if (!info) continue;
            const representative = this.graph.getNodesByFile(filePath)[0];
            if (!representative) continue;

            files.push({
                filePath,
                relativePath: path.relative(this.rootDir, filePath).replace(/\\/g, '/'),
                layer: representative.layer,
                dependentCount: dependentMap.get(filePath)?.size ?? 0,
                dependencyCount: dependencyMap.get(filePath)?.size ?? 0,
                executionOrder: executionOrder++,
                reason: info.reason,
                isRoot: rootFileSet.has(filePath),
            });
        }

        const layerBreakdown: Record<string, number> = {};
        for (const file of files) {
            layerBreakdown[file.layer] = (layerBreakdown[file.layer] ?? 0) + 1;
        }

        const crossLayerWarnings = this.buildCrossLayerWarnings(affectedFileSet);
        const cycles = this.describeCycles(dependencyMap, cyclicFiles);
        const complexity: BlastRadiusReport['estimatedComplexity'] =
            files.length >= 20 ? 'high' : files.length >= 8 ? 'medium' : 'low';

        return {
            rootFiles: rootFilePaths,
            affectedFiles: files,
            layerBreakdown,
            crossLayerWarnings,
            cycles,
            totalFiles: files.length,
            executionPlan: files.map(f => f.relativePath),
            estimatedComplexity: complexity,
        };
    }

    private walkDependencies(
        roots: Set<string>,
        maxDepth: number,
        affected: Map<string, AffectedInfo>,
    ): void {
        const queue = Array.from(roots, id => ({ id, depth: 1 }));
        const visited = new Set<string>(roots);

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (current.depth > maxDepth) continue;

            for (const dependencyId of this.getDependencyNodeIds(current.id)) {
                if (visited.has(dependencyId)) continue;
                visited.add(dependencyId);
                this.setAffectedIfBetter(
                    affected,
                    dependencyId,
                    current.depth,
                    `dependency (depth ${current.depth}/${maxDepth})`,
                );
                queue.push({ id: dependencyId, depth: current.depth + 1 });
            }
        }
    }

    private walkDependents(
        roots: Set<string>,
        maxDepth: number,
        affected: Map<string, AffectedInfo>,
    ): void {
        const queue = Array.from(roots, id => ({ id, depth: 1 }));
        const visited = new Set<string>(roots);

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (current.depth > maxDepth) continue;

            for (const dependentId of this.getDependentNodeIds(current.id)) {
                if (visited.has(dependentId)) continue;
                visited.add(dependentId);
                this.setAffectedIfBetter(
                    affected,
                    dependentId,
                    current.depth,
                    `dependent (depth ${current.depth}/${maxDepth})`,
                );
                queue.push({ id: dependentId, depth: current.depth + 1 });
            }
        }
    }

    private setAffectedIfBetter(
        affected: Map<string, AffectedInfo>,
        nodeId: string,
        depth: number,
        reason: string,
    ): void {
        const existing = affected.get(nodeId);
        if (!existing || depth < existing.depth) {
            affected.set(nodeId, { depth, reason });
        }
    }

    private collapseAffectedNodesToFiles(
        affectedIds: Map<string, AffectedInfo>,
        rootFileSet: Set<string>,
    ): Map<string, AffectedInfo> {
        const files = new Map<string, AffectedInfo>();

        for (const [nodeId, info] of affectedIds) {
            const node = this.graph.getNode(nodeId);
            if (!node) continue;
            const absolute = path.resolve(node.filePath);
            const normalizedInfo = rootFileSet.has(absolute)
                ? { depth: 0, reason: 'root' }
                : info;
            const existing = files.get(absolute);
            if (!existing || normalizedInfo.depth < existing.depth) {
                files.set(absolute, normalizedInfo);
            }
        }

        return files;
    }

    /**
     * Returns file -> dependencies. Each source file depends on every target
     * file reached through a dependency-bearing edge.
     */
    private buildFileDependencyMap(fileSet: Set<string>): Map<string, Set<string>> {
        const dependencyMap = new Map<string, Set<string>>();
        for (const filePath of fileSet) dependencyMap.set(filePath, new Set());

        for (const edge of this.graph.edges.values()) {
            if (!this.isDependencyEdge(edge)) continue;
            const source = this.graph.getNode(edge.sourceId);
            const target = this.graph.getNode(edge.targetId);
            if (!source || !target) continue;

            const sourceFile = path.resolve(source.filePath);
            const targetFile = path.resolve(target.filePath);
            if (sourceFile === targetFile) continue;
            if (!fileSet.has(sourceFile) || !fileSet.has(targetFile)) continue;

            dependencyMap.get(sourceFile)!.add(targetFile);
        }

        return dependencyMap;
    }

    private reverseFileDependencyMap(
        dependencyMap: Map<string, Set<string>>,
    ): Map<string, Set<string>> {
        const reverse = new Map<string, Set<string>>();
        for (const filePath of dependencyMap.keys()) reverse.set(filePath, new Set());

        for (const [consumer, dependencies] of dependencyMap) {
            for (const dependency of dependencies) {
                reverse.get(dependency)?.add(consumer);
            }
        }
        return reverse;
    }

    /**
     * Kahn sort on file dependencies.
     *
     * dependencyMap is consumer -> dependency, so the scheduling graph is
     * inverted to dependency -> consumer before in-degrees are computed.
     */
    private topologicallySortFiles(
        dependencyMap: Map<string, Set<string>>,
    ): { order: string[]; cyclicFiles: Set<string> } {
        const inDegree = new Map<string, number>();
        const dependents = new Map<string, Set<string>>();

        for (const filePath of dependencyMap.keys()) {
            inDegree.set(filePath, 0);
            dependents.set(filePath, new Set());
        }

        for (const [consumer, dependencies] of dependencyMap) {
            for (const dependency of dependencies) {
                if (!dependencyMap.has(dependency)) continue;
                dependents.get(dependency)!.add(consumer);
                inDegree.set(consumer, (inDegree.get(consumer) ?? 0) + 1);
            }
        }

        const queue = Array.from(inDegree.entries())
            .filter(([, degree]) => degree === 0)
            .map(([filePath]) => filePath)
            .sort();
        const order: string[] = [];

        while (queue.length > 0) {
            const current = queue.shift()!;
            order.push(current);

            const nextDependents = Array.from(dependents.get(current) ?? []).sort();
            for (const dependent of nextDependents) {
                const nextDegree = (inDegree.get(dependent) ?? 1) - 1;
                inDegree.set(dependent, nextDegree);
                if (nextDegree === 0) {
                    queue.push(dependent);
                    queue.sort();
                }
            }
        }

        const cyclicFiles = new Set<string>();
        for (const [filePath, degree] of inDegree) {
            if (degree > 0) cyclicFiles.add(filePath);
        }

        // Cycles do not have a valid total topological order. Append the affected
        // members deterministically and surface them in `cycles` for review.
        for (const filePath of Array.from(cyclicFiles).sort()) {
            if (!order.includes(filePath)) order.push(filePath);
        }

        return { order, cyclicFiles };
    }

    private describeCycles(
        dependencyMap: Map<string, Set<string>>,
        cyclicFiles: Set<string>,
    ): string[] {
        if (cyclicFiles.size === 0) return [];

        const cycles: string[] = [];
        const visited = new Set<string>();
        const stack = new Set<string>();
        const chain: string[] = [];

        const dfs = (filePath: string): void => {
            if (cycles.length >= 5) return;
            visited.add(filePath);
            stack.add(filePath);
            chain.push(filePath);

            for (const dependency of dependencyMap.get(filePath) ?? []) {
                if (!cyclicFiles.has(dependency)) continue;
                if (!visited.has(dependency)) {
                    dfs(dependency);
                } else if (stack.has(dependency)) {
                    const index = chain.indexOf(dependency);
                    if (index >= 0) {
                        const members = chain.slice(index)
                            .concat(dependency)
                            .map(p => path.relative(this.rootDir, p).replace(/\\/g, '/'));
                        const text = members.join(' -> ');
                        if (!cycles.includes(text)) cycles.push(text);
                    }
                }
            }

            chain.pop();
            stack.delete(filePath);
        };

        for (const filePath of Array.from(cyclicFiles).sort()) {
            if (!visited.has(filePath)) dfs(filePath);
        }

        return cycles;
    }

    private buildCrossLayerWarnings(fileSet: Set<string>): string[] {
        const warnings = new Set<string>();

        for (const edge of this.graph.edges.values()) {
            if (!this.isDependencyEdge(edge)) continue;
            const source = this.graph.getNode(edge.sourceId);
            const target = this.graph.getNode(edge.targetId);
            if (!source || !target || source.layer === target.layer) continue;

            const sourceFile = path.resolve(source.filePath);
            const targetFile = path.resolve(target.filePath);
            if (!fileSet.has(sourceFile) || !fileSet.has(targetFile)) continue;

            warnings.add(
                `${source.name} (${source.layer}) -> ${target.name} (${target.layer}) [${edge.kind}]`,
            );
        }

        return Array.from(warnings).slice(0, 10);
    }

    private getDependencyNodeIds(nodeId: string): string[] {
        return this.graph.getOutgoingEdges(nodeId)
            .filter(edge => this.isDependencyEdge(edge))
            .map(edge => edge.targetId);
    }

    private getDependentNodeIds(nodeId: string): string[] {
        return this.graph.getIncomingEdges(nodeId)
            .filter(edge => this.isDependencyEdge(edge))
            .map(edge => edge.sourceId);
    }

    private isDependencyEdge(edge: GraphEdge): boolean {
        return DEPENDENCY_EDGE_KINDS.has(edge.kind);
    }

    private resolveDepth(maxDependents: number, override?: number): number {
        if (override !== undefined && Number.isFinite(override)) {
            return Math.min(50, Math.max(1, Math.trunc(override)));
        }
        return Math.min(20, Math.max(4, Math.round(Math.log2(maxDependents + 2) * 3)));
    }

    private emptyReport(rootFiles: string[]): BlastRadiusReport {
        return {
            rootFiles,
            affectedFiles: [],
            layerBreakdown: {},
            crossLayerWarnings: [],
            cycles: [],
            totalFiles: 0,
            executionPlan: [],
            estimatedComplexity: 'low',
        };
    }
}
