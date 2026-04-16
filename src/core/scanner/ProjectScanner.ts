import fg from 'fast-glob';
import path from 'path';
import fs from 'fs';
import type { FileAnalysis, GraphNode, GraphEdge, ProjectConfig } from '../../types/index.js';
import { FileAnalyzer } from './FileAnalyzer.js';
import { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { TypeScriptAnalyzer } from './TypeScriptAnalyzer.js';
import { Database } from '../../storage/Database.js';
import { GraphStore } from '../../storage/GraphStore.js';
import { contentHash, detectLanguage } from '../../utils/ast.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';
import { normalizePath, resolveNormalized } from '../../utils/paths.js';
import ora from 'ora';
import chalk from 'chalk';
import type { AIProvider } from '../../types/index.js';
import { RateLimiter } from '../../utils/RateLimiter.js';

export interface ScanResult {
    totalFiles: number;
    analyzedFiles: number;
    nodesCreated: number;
    edgesCreated: number;
    errors: Array<{ file: string; error: string }>;
    durationMs: number;
}

export class ProjectScanner {
    private fileAnalyzer: FileAnalyzer;
    private tsAnalyzer: TypeScriptAnalyzer;
    private graphStore: GraphStore;
    private db: Database;

    constructor(
        private rootDir: string,
        private graph: RelationshipGraph,
        private config: ProjectConfig,
        db: Database,
        private aiProvider?: AIProvider
    ) {
        this.fileAnalyzer = new FileAnalyzer(rootDir, {
            database: config.layers.database,
            backend: config.layers.backend,
            api: config.layers.api,
            frontend: config.layers.frontend,
        });
        this.tsAnalyzer = new TypeScriptAnalyzer(rootDir);
        this.graphStore = new GraphStore(db);
        this.db = db;
    }

    async scanProject(incremental = false): Promise<ScanResult> {
        const startTime = Date.now();
        const spinner = ora('Discovering files...').start();

        const patterns = ['**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,java,kt,kts,swift,dart,rb,php,c,h,cpp,cc,cxx,hpp,html,htm,css,scss,sass,rs,cs,sql,graphql,gql}'];
        const ignored = this.config.exclude.map(e => `**/${e}/**`);

        const rawFiles = await fg(patterns, {
            cwd: this.rootDir,
            absolute: true,
            ignore: ignored,
            followSymbolicLinks: false,
        });
        const files = rawFiles.map(f => normalizePath(f));

        spinner.text = `Found ${files.length} files. Building graph...`;

        const errors: Array<{ file: string; error: string }> = [];
        let analyzedFiles = 0;
        let nodesCreated = 0;
        let edgesCreated = 0;

        const fileAnalyses = new Map<string, FileAnalysis>();

        // SUPREMACY UPGRADE: Parallel Incremental Analysis
        spinner.text = `Analyzing files using parallel incremental scan...`;
        
        const CONCURRENCY = 8; // Parallel workers
        const chunks: string[][] = [];
        for (let i = 0; i < files.length; i += CONCURRENCY) {
            chunks.push(files.slice(i, i + CONCURRENCY));
        }

        for (const chunk of chunks) {
            await Promise.all(chunk.map(async (filePath) => {
                try {
                    // Incremental Check: Check if hash exists and hasn't changed
                    const content = fs.readFileSync(filePath, 'utf8');
                    const currentHash = contentHash(content);
                    
                    if (incremental) {
                        const existing = this.db.prepare('SELECT hash FROM file_analyses WHERE file_path = ?').get(filePath) as { hash: string } | undefined;
                        if (existing && existing.hash === currentHash) {
                            return; // Skip analysis
                        }
                    }

                    const analysis = this.fileAnalyzer.analyze(filePath);
                    fileAnalyses.set(filePath, analysis);
                    errors.push(...analysis.errors.map(e => ({ file: filePath, error: e })));
                    analyzedFiles++;
                    spinner.text = `Analyzing [Parallel]: ${path.relative(this.rootDir, filePath)}`;
                } catch (err) {
                    errors.push({ file: filePath, error: String(err) });
                }
            }));
        }

        spinner.text = 'Building relationship graph...';
        this.db.transaction(() => {
            for (const [filePath, analysis] of fileAnalyses) {
                this.graph.removeNodesForFile(filePath);

                const fileNode = this.graph.addNode({
                    kind: 'file',
                    name: path.relative(this.rootDir, filePath).replace(/\\/g, '/'),
                    filePath,
                    layer: analysis.layer,
                    language: analysis.language,
                    hash: analysis.hash,
                    metadata: { imports: analysis.imports.length, exports: analysis.exports.length },
                });
                nodesCreated++;

                for (const fn of analysis.functions) {
                    const fnNode = this.graph.addNode({
                        kind: 'function',
                        name: fn.name,
                        filePath,
                        layer: analysis.layer,
                        language: analysis.language,
                        signature: `${fn.name}(${fn.params.join(', ')})`,
                        location: fn.location,
                        hash: contentHash(fn.name + fn.params.join(',') + filePath),
                        metadata: { isAsync: fn.isAsync, isExported: fn.isExported, params: fn.params },
                    });
                    nodesCreated++;

                    try {
                        this.graph.addEdge({
                            kind: 'provides',
                            sourceId: fileNode.id,
                            targetId: fnNode.id,
                            weight: 1,
                            metadata: {},
                        });
                        edgesCreated++;
                    } catch { /* node may not exist */ }
                }

                for (const cls of analysis.classes) {
                    const clsNode = this.graph.addNode({
                        kind: 'class',
                        name: cls.name,
                        filePath,
                        layer: analysis.layer,
                        language: analysis.language,
                        hash: contentHash(cls.name + filePath),
                        metadata: {
                            extends: cls.extends,
                            implements: cls.implements,
                            isExported: cls.isExported,
                            methodCount: cls.methods.length,
                        },
                    });
                    nodesCreated++;

                    try {
                        this.graph.addEdge({
                            kind: 'provides',
                            sourceId: fileNode.id,
                            targetId: clsNode.id,
                            weight: 1,
                            metadata: {},
                        });
                        edgesCreated++;
                    } catch { /* skip */ }
                }

                for (const iface of analysis.interfaces) {
                    const ifaceNode = this.graph.addNode({
                        kind: 'interface',
                        name: iface.name,
                        filePath,
                        layer: analysis.layer,
                        language: analysis.language,
                        hash: contentHash(iface.name + filePath),
                        metadata: { extends: iface.extends, isExported: iface.isExported },
                    });
                    nodesCreated++;

                    try {
                        this.graph.addEdge({
                            kind: 'provides',
                            sourceId: fileNode.id,
                            targetId: ifaceNode.id,
                            weight: 1,
                            metadata: {},
                        });
                        edgesCreated++;
                    } catch { /* skip */ }
                }

                for (const endpoint of analysis.apiEndpoints) {
                    const epNode = this.graph.addNode({
                        kind: 'api_endpoint',
                        name: `${endpoint.method} ${endpoint.path}`,
                        filePath,
                        layer: 'api',
                        language: analysis.language,
                        hash: contentHash(endpoint.method + endpoint.path + filePath),
                        location: endpoint.location,
                        metadata: { method: endpoint.method, path: endpoint.path, handler: endpoint.handler },
                    });
                    nodesCreated++;

                    try {
                        this.graph.addEdge({
                            kind: 'provides',
                            sourceId: fileNode.id,
                            targetId: epNode.id,
                            weight: 1,
                            metadata: {},
                        });
                        edgesCreated++;
                    } catch { /* skip */ }
                }
            }
        });

        spinner.text = 'Resolving import relationships...';
        this.db.transaction(() => {
            for (const [filePath, analysis] of fileAnalyses) {
                const fileNode = this.graph.getNodesByFile(filePath).find(n => n.kind === 'file');
                if (!fileNode) continue;

                for (const imp of analysis.imports) {
                    const resolvedPath = this.fileAnalyzer.resolveImportPath(imp.source, filePath);
                    if (!resolvedPath) continue;

                    const targetFileNodes = this.graph.getNodesByFile(resolvedPath).filter(n => n.kind === 'file');
                    for (const targetNode of targetFileNodes) {
                        try {
                            this.graph.addEdge({
                                kind: 'imports',
                                sourceId: fileNode.id,
                                targetId: targetNode.id,
                                weight: 1,
                                metadata: { specifiers: imp.specifiers },
                            });
                            edgesCreated++;
                        } catch { /* skip */ }
                    }
                }
            }
        });

        // --- NEW: Semantic Indexing (Vector Embeddings) ---
        if (this.aiProvider?.batchEmbed) {
            spinner.text = 'Generating semantic embeddings (Vector RAG)...';
            const nodesToEmbed = Array.from(this.graph.nodes.values()).filter(n => 
                n.kind !== 'package' && n.kind !== 'module'
            );
            
            if (nodesToEmbed.length > 0) {
                const total = nodesToEmbed.length;
                let indexed = 0;
                
                // Prepare semantic descriptions for better retrieval
                const texts = nodesToEmbed.map(n => {
                    const relativePath = path.relative(this.rootDir, n.filePath);
                    return `${n.kind} "${n.name}" in ${relativePath}\nSignature: ${n.signature || 'N/A'}\nDoc: ${n.docComment || 'N/A'}`;
                });

                try {
                    // Use RateLimiter.withRetry for industrial-grade stability
                    await RateLimiter.withRetry(async () => {
                        const embeddings = await this.aiProvider!.batchEmbed!(texts);
                        for (let i = 0; i < nodesToEmbed.length; i++) {
                            this.graphStore.updateNodeEmbedding(nodesToEmbed[i].id, embeddings[i]);
                            indexed++;
                            if (indexed % 10 === 0) {
                                spinner.text = `Indexing semantic nodes: ${indexed}/${total}`;
                            }
                        }
                    }, 3);
                } catch (err) {
                    logger.warn('Semantic indexing partially failed or skipped due to rate limits', { error: String(err) });
                    errors.push({ file: '(global)', error: `Semantic indexing error: ${String(err)}` });
                }
            }
        }

        const elapsed = Date.now() - startTime;
        spinner.succeed(
            chalk.green(`Scan complete: ${analyzedFiles} files, ${nodesCreated} nodes, ${edgesCreated} edges in ${elapsed}ms`)
        );

        logger.info('Project scan complete', { analyzedFiles, nodesCreated, edgesCreated, errors: errors.length });

        return {
            totalFiles: files.length,
            analyzedFiles,
            nodesCreated,
            edgesCreated,
            errors,
            durationMs: elapsed,
        };
    }

    async scanFile(filePath: string): Promise<{ nodesCreated: number; edgesCreated: number }> {
        const normalizedFilePath = normalizePath(filePath);
        let nodesCreated = 0;
        let edgesCreated = 0;

        const analysis = this.fileAnalyzer.analyze(normalizedFilePath);
        const existingNodes = this.graph.getNodesByFile(normalizedFilePath);
        const existingIds = new Set(existingNodes.map(n => n.id));
        const currentIds = new Set<string>();

        // 1. Upsert File Node
        const fileNode = this.graph.addNode({
            kind: 'file',
            name: path.relative(this.rootDir, normalizedFilePath).replace(/\\/g, '/'),
            filePath: normalizedFilePath,
            layer: analysis.layer,
            language: analysis.language,
            hash: analysis.hash,
            metadata: { imports: analysis.imports.length, exports: analysis.exports.length },
        });
        currentIds.add(fileNode.id);
        nodesCreated++;

        // 2. Upsert Symbols (Functions, Classes, etc.)
        for (const fn of analysis.functions) {
            const fnNode = this.graph.addNode({
                kind: 'function',
                name: fn.name,
                filePath,
                layer: analysis.layer,
                language: analysis.language,
                hash: contentHash(fn.name + filePath),
                location: fn.location,
                metadata: { isAsync: fn.isAsync, isExported: fn.isExported },
            });
            currentIds.add(fnNode.id);
            nodesCreated++;
            try {
                this.graph.addEdge({ kind: 'provides', sourceId: fileNode.id, targetId: fnNode.id, weight: 1, metadata: {} });
                edgesCreated++;
            } catch { /* skip */ }
        }

        for (const cls of analysis.classes) {
            const clsNode = this.graph.addNode({
                kind: 'class',
                name: cls.name,
                filePath,
                layer: analysis.layer,
                language: analysis.language,
                hash: contentHash(cls.name + filePath),
                metadata: { isExported: cls.isExported },
            });
            currentIds.add(clsNode.id);
            nodesCreated++;
            try {
                this.graph.addEdge({ kind: 'provides', sourceId: fileNode.id, targetId: clsNode.id, weight: 1, metadata: {} });
                edgesCreated++;
            } catch { /* skip */ }
        }

        for (const endpoint of analysis.apiEndpoints) {
            const epNode = this.graph.addNode({
                kind: 'api_endpoint',
                name: `${endpoint.method} ${endpoint.path}`,
                filePath,
                layer: 'api',
                language: analysis.language,
                hash: contentHash(endpoint.method + endpoint.path + filePath),
                location: endpoint.location,
                metadata: { method: endpoint.method, path: endpoint.path, handler: endpoint.handler },
            });
            currentIds.add(epNode.id);
            nodesCreated++;
            try {
                this.graph.addEdge({ kind: 'provides', sourceId: fileNode.id, targetId: epNode.id, weight: 1, metadata: {} });
                edgesCreated++;
            } catch { /* skip */ }
        }

        // 3. Prune disappeared nodes
        for (const id of existingIds) {
            if (!currentIds.has(id)) {
                this.graph.removeNode(id);
            }
        }

        // 4. Resolve Outgoing Imports
        for (const imp of analysis.imports) {
            const resolvedPath = this.fileAnalyzer.resolveImportPath(imp.source, filePath);
            if (!resolvedPath) continue;

            const targetFileNodes = this.graph.getNodesByFile(resolvedPath).filter(n => n.kind === 'file');
            for (const targetNode of targetFileNodes) {
                try {
                    this.graph.addEdge({
                        kind: 'imports',
                        sourceId: fileNode.id,
                        targetId: targetNode.id,
                        weight: 1,
                        metadata: { specifiers: imp.specifiers },
                    });
                    edgesCreated++;
                } catch { /* skip */ }
            }
        }

        return { nodesCreated, edgesCreated };
    }
}