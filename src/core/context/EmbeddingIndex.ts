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

const SKETCH_DIM = 16;
const OVER_FETCH = 12;
const EXACT_SCAN_THRESHOLD = 1000;

/**
 * SQLite-backed semantic retrieval with bounded full-vector memory.
 *
 * This is intentionally not presented as an ANN index: large-corpus searches
 * perform an O(N) scan over compact 16-float sketches, then load full vectors
 * only for the highest-scoring candidates. A future HNSW/DiskANN backend can be
 * introduced behind this interface without changing callers.
 */
export class EmbeddingIndex {
    constructor(private db: Database, private ai: AIProvider) {
        this.runMigration();
    }

    private runMigration(): void {
        try {
            this.db.prepare('SELECT sketchBlob, dim, updatedAt FROM embeddings_cache LIMIT 1').get();
        } catch {
            try {
                this.db.exec('ALTER TABLE embeddings_cache ADD COLUMN sketchBlob BLOB');
            } catch { /* column already exists */ }
            try {
                this.db.exec('ALTER TABLE embeddings_cache ADD COLUMN dim INTEGER NOT NULL DEFAULT 0');
            } catch { /* column already exists */ }
            try {
                this.db.exec('ALTER TABLE embeddings_cache ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0');
            } catch { /* column already exists */ }
        }
    }

    async embedAndStore(chunks: CodeChunk[], onProgress?: (count: number) => void): Promise<void> {
        if (chunks.length === 0) return;

        const batchSize = 50;
        const ids = chunks.map(chunk => chunk.id);
        const placeholders = ids.map(() => '?').join(',');
        const existingRows = this.db.prepare(
            `SELECT id, contentHash FROM embeddings_cache WHERE id IN (${placeholders})`,
        ).all(...ids) as Array<{ id: string; contentHash: string }>;
        const existingById = new Map(existingRows.map(row => [row.id, row.contentHash]));

        const pending = chunks.filter(chunk =>
            existingById.get(chunk.id) !== this.hashContent(chunk.content),
        );
        let processedCount = chunks.length - pending.length;
        onProgress?.(processedCount);
        if (pending.length === 0) return;

        for (let offset = 0; offset < pending.length; offset += batchSize) {
            const batch = pending.slice(offset, offset + batchSize);
            try {
                const texts = batch.map(chunk => chunk.content);
                let vectors: number[][];

                if (this.ai.batchEmbed) {
                    vectors = await this.ai.batchEmbed(texts);
                } else if (this.ai.embed) {
                    vectors = [];
                    for (const text of texts) vectors.push(await this.ai.embed(text));
                } else {
                    logger.warn('EmbeddingIndex: configured provider has no embedding capability.');
                    processedCount += batch.length;
                    onProgress?.(processedCount);
                    continue;
                }

                if (vectors.length !== batch.length) {
                    throw new Error(
                        `Embedding provider returned ${vectors.length} vectors for ${batch.length} inputs`,
                    );
                }

                this.db.transaction(() => {
                    for (let index = 0; index < batch.length; index++) {
                        const chunk = batch[index]!;
                        const vector = vectors[index];
                        if (!vector || vector.length === 0 || vector.some(value => !Number.isFinite(value))) {
                            logger.warn('EmbeddingIndex: invalid vector skipped', { id: chunk.id });
                            continue;
                        }
                        if (vector.every(value => value === 0)) {
                            logger.warn('EmbeddingIndex: zero vector skipped', { id: chunk.id });
                            continue;
                        }

                        const embeddingBlob = Buffer.from(new Float32Array(vector).buffer);
                        const sketchBlob = Buffer.from(
                            new Float32Array(this.computeSketch(vector, SKETCH_DIM)).buffer,
                        );

                        this.db.prepare(`
                            INSERT OR REPLACE INTO embeddings_cache
                                (id, filePath, contentHash, content, embeddingBlob, sketchBlob, dim, updatedAt)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        `).run(
                            chunk.id,
                            chunk.filePath,
                            this.hashContent(chunk.content),
                            chunk.content,
                            embeddingBlob,
                            sketchBlob,
                            vector.length,
                            Date.now(),
                        );
                    }
                });

                processedCount += batch.length;
                onProgress?.(processedCount);
            } catch (err) {
                logger.warn('EmbeddingIndex: embedding batch failed', {
                    batchStart: offset,
                    error: String(err),
                });
                processedCount += batch.length;
                onProgress?.(processedCount);
            }
        }
    }

    async search(query: string, topK = 5): Promise<CodeChunk[]> {
        if (topK <= 0) return [];
        const queryVector = await this.embedQuery(query);
        if (!queryVector) return [];

        const countRow = this.db.prepare(
            'SELECT COUNT(*) AS count FROM embeddings_cache WHERE embeddingBlob IS NOT NULL',
        ).get() as { count: number } | undefined;
        const corpusSize = Number(countRow?.count ?? 0);
        if (corpusSize === 0) return [];

        let candidates: Array<{ id: string; filePath: string; content: string; embeddingBlob: Buffer }>;
        if (corpusSize <= EXACT_SCAN_THRESHOLD) {
            candidates = this.db.prepare(`
                SELECT id, filePath, content, embeddingBlob
                FROM embeddings_cache
                WHERE embeddingBlob IS NOT NULL
            `).all() as typeof candidates;
        } else {
            candidates = this.fetchCandidatesBySketch(queryVector, Math.max(topK * OVER_FETCH, topK));
        }

        return candidates
            .map(row => ({
                id: row.id,
                filePath: row.filePath,
                content: row.content,
                similarity: this.cosineSimilarity(queryVector, this.decodeVector(row.embeddingBlob)),
            }))
            .filter(chunk => Number.isFinite(chunk.similarity) && (chunk.similarity ?? 0) > 0)
            .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
            .slice(0, topK);
    }

    async hybridSearch(query: string, topK = 5): Promise<CodeChunk[]> {
        const [vectorResults, keywordResults] = await Promise.all([
            this.search(query, topK * 2),
            Promise.resolve(this.keywordSearch(query, topK * 2)),
        ]);

        const scores = new Map<string, number>();
        const chunks = new Map<string, CodeChunk>();
        const damping = 60;

        vectorResults.forEach((chunk, rank) => {
            scores.set(chunk.id, (scores.get(chunk.id) ?? 0) + 1 / (damping + rank + 1));
            chunks.set(chunk.id, chunk);
        });
        keywordResults.forEach((chunk, rank) => {
            scores.set(chunk.id, (scores.get(chunk.id) ?? 0) + 1 / (damping + rank + 1));
            if (!chunks.has(chunk.id)) chunks.set(chunk.id, chunk);
        });

        return [...scores.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, topK)
            .map(([id]) => chunks.get(id))
            .filter((chunk): chunk is CodeChunk => Boolean(chunk));
    }

    invalidateFile(filePath: string): void {
        this.db.prepare('DELETE FROM embeddings_cache WHERE filePath = ?').run(filePath);
    }

    getStats(): { totalChunks: number; totalFiles: number } {
        const row = this.db.prepare(
            'SELECT COUNT(*) AS totalChunks, COUNT(DISTINCT filePath) AS totalFiles FROM embeddings_cache',
        ).get() as { totalChunks: number; totalFiles: number } | undefined;
        return row ?? { totalChunks: 0, totalFiles: 0 };
    }

    private async embedQuery(query: string): Promise<number[] | null> {
        try {
            if (this.ai.batchEmbed) {
                const vectors = await this.ai.batchEmbed([query]);
                return vectors[0]?.length ? vectors[0] : null;
            }
            if (this.ai.embed) {
                const vector = await this.ai.embed(query);
                return vector?.length ? vector : null;
            }
            return null;
        } catch (err) {
            logger.warn('EmbeddingIndex: query embedding failed', { error: String(err) });
            return null;
        }
    }

    private fetchCandidatesBySketch(
        queryVector: number[],
        candidateCount: number,
    ): Array<{ id: string; filePath: string; content: string; embeddingBlob: Buffer }> {
        const querySketch = this.computeSketch(queryVector, SKETCH_DIM);
        const rows = this.db.prepare(`
            SELECT id, sketchBlob
            FROM embeddings_cache
            WHERE sketchBlob IS NOT NULL
        `).all() as Array<{ id: string; sketchBlob: Buffer }>;

        const selectedIds = rows
            .map(row => ({
                id: row.id,
                score: this.dotProduct(querySketch, this.decodeVector(row.sketchBlob)),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, candidateCount)
            .map(row => row.id);

        if (selectedIds.length === 0) return [];
        const placeholders = selectedIds.map(() => '?').join(',');
        return this.db.prepare(`
            SELECT id, filePath, content, embeddingBlob
            FROM embeddings_cache
            WHERE id IN (${placeholders})
        `).all(...selectedIds) as Array<{
            id: string;
            filePath: string;
            content: string;
            embeddingBlob: Buffer;
        }>;
    }

    private keywordSearch(query: string, topK: number): CodeChunk[] {
        const terms = query.toLowerCase().split(/\s+/)
            .filter(term => term.length > 2)
            .slice(0, 5);
        if (terms.length === 0) return [];

        const where = terms.map(() => 'LOWER(content) LIKE ?').join(' OR ');
        const params = terms.map(term => `%${term}%`);
        try {
            const rows = this.db.prepare(`
                SELECT id, filePath, content
                FROM embeddings_cache
                WHERE ${where}
                LIMIT ?
            `).all(...params, topK) as Array<{ id: string; filePath: string; content: string }>;
            return rows.map(row => ({ ...row, similarity: 0.5 }));
        } catch (err) {
            logger.debug('EmbeddingIndex: keyword search failed', { error: String(err) });
            return [];
        }
    }

    /**
     * Produces a deterministic compact block-mean sketch. It is a heuristic
     * pre-filter, not PCA and not a trained ANN projection.
     */
    private computeSketch(vector: number[], dims: number): number[] {
        if (vector.length <= dims) return vector.slice();
        const sketch: number[] = [];
        for (let bucket = 0; bucket < dims; bucket++) {
            const start = Math.floor((bucket * vector.length) / dims);
            const end = Math.max(start + 1, Math.floor(((bucket + 1) * vector.length) / dims));
            let sum = 0;
            for (let index = start; index < Math.min(end, vector.length); index++) {
                sum += vector[index]!;
            }
            sketch.push(sum / Math.max(1, Math.min(end, vector.length) - start));
        }
        return sketch;
    }

    private decodeVector(blob: Buffer): number[] {
        const view = new Float32Array(
            blob.buffer,
            blob.byteOffset,
            blob.byteLength / Float32Array.BYTES_PER_ELEMENT,
        );
        return Array.from(view);
    }

    private dotProduct(a: number[], b: number[]): number {
        let sum = 0;
        const length = Math.min(a.length, b.length);
        for (let index = 0; index < length; index++) sum += a[index]! * b[index]!;
        return sum;
    }

    private cosineSimilarity(a: number[], b: number[]): number {
        if (a.length !== b.length || a.length === 0) return 0;
        let dot = 0;
        let magnitudeA = 0;
        let magnitudeB = 0;
        for (let index = 0; index < a.length; index++) {
            const av = a[index]!;
            const bv = b[index]!;
            dot += av * bv;
            magnitudeA += av * av;
            magnitudeB += bv * bv;
        }
        if (magnitudeA === 0 || magnitudeB === 0) return 0;
        return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
    }

    private hashContent(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }
}
