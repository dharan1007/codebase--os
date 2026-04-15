import { Database } from '../../storage/Database.js';
import type { AITask, AITaskResult } from '../../types/index.js';

export interface AgentCheckpoint {
    id: string;
    sessionId: string;
    taskType: 'ask' | 'agent';
    status: 'pending' | 'in_progress' | 'paused' | 'failed' | 'finished';
    plan: AITask[];
    results: AITaskResult[];
    metadata: Record<string, any>;
    updatedAt: number;
}

export class CheckpointManager {
    constructor(private readonly db: Database) {}

    save(checkpoint: AgentCheckpoint): void {
        const sql = `
            INSERT OR REPLACE INTO agent_checkpoints (
                id, session_id, task_type, status, plan_json, results_json, metadata_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;
        this.db.prepare(sql).run(
            checkpoint.id,
            checkpoint.sessionId,
            checkpoint.taskType,
            checkpoint.status,
            JSON.stringify(checkpoint.plan),
            JSON.stringify(checkpoint.results),
            JSON.stringify(checkpoint.metadata),
            checkpoint.updatedAt
        );
    }

    getLatest(): AgentCheckpoint | null {
        const sql = `
            SELECT * FROM agent_checkpoints 
            ORDER BY updated_at DESC LIMIT 1
        `;
        const row = this.db.prepare(sql).get();
        if (!row) return null;

        return {
            id: row.id,
            sessionId: row.session_id,
            taskType: row.task_type as any,
            status: row.status as any,
            plan: JSON.parse(row.plan_json),
            results: JSON.parse(row.results_json),
            metadata: JSON.parse(row.metadata_json),
            updatedAt: row.updated_at
        };
    }

    clear(id: string): void {
        this.db.prepare('DELETE FROM agent_checkpoints WHERE id = ?').run(id);
    }

    markFinished(id: string): void {
        this.db.prepare("UPDATE agent_checkpoints SET status = 'finished' WHERE id = ?").run(id);
    }
}
