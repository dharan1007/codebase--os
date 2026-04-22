import { Database } from '../../storage/Database.js';
import crypto from 'crypto';

export interface CachedResponse {
    queryHash: string;
    taskProfile: string;
    response: string;
    timestamp: number;
}

export class ResponseCache {
    constructor(private db: Database) {}

    get(queryHash: string): string | null {
        try {
            const row = this.db.prepare('SELECT response FROM response_cache WHERE queryHash = ?').get(queryHash) as any;
            return row ? row.response : null;
        } catch { return null; }
    }

    set(queryHash: string, taskProfile: string, response: string): void {
        try {
            this.db.prepare(`
                INSERT OR REPLACE INTO response_cache (queryHash, taskProfile, response, timestamp)
                VALUES (?, ?, ?, ?)
            `).run(queryHash, taskProfile, response, Date.now());
        } catch {}
    }

    static hashQuery(systemPrompt: string, userPrompt: string): string {
        return crypto.createHash('sha256').update(systemPrompt + '|' + userPrompt).digest('hex');
    }
}
