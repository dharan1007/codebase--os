import { Database } from '../../storage/Database.js';
import type { FailureCategory, FailureSnapshot } from '../../types/index.js';
import crypto from 'crypto';
import { logger } from '../../utils/logger.js';

export class FailureStore {
    constructor(private db: Database) {}

    async record(category: FailureCategory, filePath: string, message: string, context: string, stack?: string): Promise<FailureSnapshot> {
        const signature = this.generateSignature(message, filePath);
        
        const existing = this.db.prepare('SELECT id, frequency FROM failure_snapshots WHERE signature = ?').get(signature) as any;

        if (existing) {
            const newFreq = (existing.frequency || 1) + 1;
            this.db.prepare('UPDATE failure_snapshots SET frequency = ?, timestamp = ?, message = ? WHERE id = ?')
                .run(newFreq, Date.now(), message, existing.id);
            
            return {
                id: existing.id,
                category,
                filePath,
                message,
                stackTrace: stack,
                contextBefore: context,
                timestamp: Date.now(),
                frequency: newFreq
            };
        }

        const id = crypto.randomUUID();
        this.db.prepare(`
            INSERT INTO failure_snapshots (id, category, filePath, signature, message, stackTrace, contextBefore, timestamp, frequency)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, category, filePath, signature, message, stack, context, Date.now(), 1);

        return {
            id,
            category,
            filePath,
            message,
            stackTrace: stack,
            contextBefore: context,
            timestamp: Date.now(),
            frequency: 1
        };
    }

    getFrequentFailures(minFrequency: number = 3): FailureSnapshot[] {
        const rows = this.db.prepare('SELECT * FROM failure_snapshots WHERE frequency >= ? ORDER BY frequency DESC').all(minFrequency) as any[];
        return rows.map(r => ({
            ...r,
            timestamp: Number(r.timestamp),
            frequency: Number(r.frequency)
        }));
    }

    private generateSignature(message: string, filePath: string): string {
        // Normalize message to remove specific paths/hashes for signature matching
        const normalized = message.replace(/\/.*?:\d+:\d+/g, '[PATH]').replace(/0x[a-f0-9]+/gi, '[HEX]');
        return crypto.createHash('sha256').update(`${filePath}:${normalized}`).digest('hex');
    }
}
