import { Database } from '../../storage/Database.js';
import type { AIProvider } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import crypto from 'crypto';

export interface CodeChunk {
    id: string;
    filePath: string;
    content: string;
    embedding?: number[];
    startLine?: number;
    endLine?: number;
    similarity?: number;
}

export class EmbeddingIndex {
    constructor(private db: Database, private ai: AIProvider) {}

    init() {
        this.db.prepare(`
            CREATE TABLE IF NOT EXISTS embeddings_cache (
                id TEXT PRIMARY KEY,
                filePath TEXT NOT NULL,
                contentHash TEXT NOT NULL,
                content TEXT NOT NULL,
                embeddingBlob BLOB NOT NULL
            )
        `).run();
    }

    private hashContent(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    async embedAndStore(chunks: CodeChunk[], onProgress?: (count: number) => void): Promise<void> {
        let processedCount = 0;
        const BATCH_SIZE = 50;
        const CONCURRENCY = 3;

        // 1. Filter out already cached chunks to save AI costs & time
        const pendingChunks: CodeChunk[] = [];
        for (const chunk of chunks) {
            const contentHash = this.hashContent(chunk.content);
            const cached = this.db.prepare('SELECT id FROM embeddings_cache WHERE filePath = ? AND contentHash = ?').get(chunk.filePath, contentHash);
            if (!cached) {
                pendingChunks.push(chunk);
            } else {
                processedCount++;
                if (onProgress) onProgress(processedCount);
            }
        }

        if (pendingChunks.length === 0) return;

        // 2. Process in Parallel Batches
        for (let i = 0; i < pendingChunks.length; i += BATCH_SIZE * CONCURRENCY) {
            const batchGroup = [];
            for (let j = 0; j < CONCURRENCY; j++) {
                const start = i + (j * BATCH_SIZE);
                if (start < pendingChunks.length) {
                    batchGroup.push(pendingChunks.slice(start, start + BATCH_SIZE));
                }
            }

            await Promise.all(batchGroup.map(async (batch) => {
                try {
                    const texts = batch.map(c => c.content);
                    let vectors: number[][] = [];

                    if (this.ai.batchEmbed) {
                        vectors = await this.ai.batchEmbed(texts);
                    } else if (this.ai.embed) {
                        vectors = await Promise.all(texts.map(t => this.ai.embed!(t)));
                    } else {
                        vectors = batch.map(() => new Array(1536).fill(0));
                    }

                    // 3. Store Results Transactionally
                    this.db.transaction(() => {
                        for (let k = 0; k < batch.length; k++) {
                            const chunk = batch[k];
                            const embedVector = vectors[k] || new Array(1536).fill(0);
                            const blob = new Float32Array(embedVector).buffer;
                            const contentHash = this.hashContent(chunk.content);

                            this.db.prepare(`
                                INSERT OR REPLACE INTO embeddings_cache (id, filePath, contentHash, content, embeddingBlob)
                                VALUES (?, ?, ?, ?, ?)
                            `).run(chunk.id, chunk.filePath, contentHash, chunk.content, Buffer.from(blob));
                        }
                    });

                    processedCount += batch.length;
                    if (onProgress) onProgress(processedCount);

                } catch (err) {
                    logger.warn(`Failed to process embedding batch`, { error: String(err) });
                }
            }));
        }
    }

    async search(query: string, topK: number = 5): Promise<CodeChunk[]> {
        let queryVector: number[] = [];
        if (this.ai.batchEmbed) {
            const vectors = await this.ai.batchEmbed([query]);
            queryVector = vectors[0];
        } else if (this.ai.embed) {
             queryVector = await this.ai.embed(query);
        } else {
             queryVector = new Array(1536).fill(0);
        }

        const rows = this.db.prepare('SELECT id, filePath, content, embeddingBlob FROM embeddings_cache').all() as any[];
        
        const results: CodeChunk[] = rows.map(row => {
            const vector = Array.from(new Float32Array(row.embeddingBlob.buffer, row.embeddingBlob.byteOffset, row.embeddingBlob.byteLength / Float32Array.BYTES_PER_ELEMENT));
            const similarity = this.cosineSimilarity(queryVector, vector);
            return {
                id: row.id,
                filePath: row.filePath,
                content: row.content,
                similarity
            };
        });

        results.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
        return results.slice(0, topK);
    }

    private cosineSimilarity(a: number[], b: number[]): number {
        if (a.length !== b.length || a.length === 0) return 0;
        let dotProduct = 0, aMag = 0, bMag = 0;
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            aMag += a[i] * a[i];
            bMag += b[i] * b[i];
        }
        return aMag === 0 || bMag === 0 ? 0 : dotProduct / (Math.sqrt(aMag) * Math.sqrt(bMag));
    }
}
