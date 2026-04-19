import { EmbeddingIndex } from './EmbeddingIndex.js';
import { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { logger } from '../../utils/logger.js';

export class ContextBuilder {
    constructor(
        private index: EmbeddingIndex,
        private graph: RelationshipGraph
    ) {}

    /**
     * Enriches a raw query with RAG-retrieved semantic chunks and topological dependencies.
     */
    async enrich(query: string, targetFilePath?: string): Promise<string> {
        // 1. Vector Search (RAG)
        let chunks: any[] = [];
        try {
            chunks = await this.index.search(query, 5);
        } catch (err) {
            logger.warn('ContextBuilder: RAG search failed', { error: String(err) });
        }

        // 2. Resolve Topological Binding
        let topologicalDeps = new Set<string>();
        if (targetFilePath) {
            try {
                const nodes = this.graph.getNodesByFile(targetFilePath);
                for (const n of nodes) {
                    const outEdges = this.graph.getOutgoingEdges(n.id);
                    for (const edge of outEdges) {
                        const tNode = this.graph.getNode(edge.targetId);
                        if (tNode) topologicalDeps.add(tNode.name);
                    }
                }
            } catch {}
        }

        // 3. Render Context View
        let contextBlock = `[RAG MEMORY CONTEXT]\n\nThe following code chunks are highly relevant to your query:\n\n`;

        let tokens = 0;
        for (const chunk of chunks) {
            const chunkBody = `--- File: ${chunk.filePath} ---\n${chunk.content}\n\n`;
            const chunkTokens = Math.ceil(chunkBody.length / 4);
            
            if (tokens + chunkTokens > 2000) break;
            
            contextBlock += chunkBody;
            tokens += chunkTokens;
        }

        if (topologicalDeps.size > 0) {
            contextBlock += `\nTopological Dependencies for target file:\n- ${Array.from(topologicalDeps).join('\n- ')}\n`;
        }

        return `${contextBlock}\n\n[USER QUERY/TASK]:\n${query}`;
    }
}

