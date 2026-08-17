import { Database } from './Database.js';
import type { ChangeOperation, ChangeRecord } from '../types/index.js';

interface ChangeRow {
    id: string;
    session_id: string;
    task_id: string;
    file_path: string;
    original_content: string;
    updated_content: string;
    diff: string;
    applied_at: number;
    rolled_back: number;
    rolled_back_at: number | null;
    provider: string;
    confidence: number;
    impact_report_id: string | null;
    operation: string | null;
    source_path: string | null;
}

export class ChangeHistory {
    constructor(private db: Database) {}

    record(change: Omit<ChangeRecord, 'rolledBack' | 'rolledBackAt'>): ChangeRecord {
        const operation: ChangeOperation = change.operation ?? 'modify';
        this.db.prepare(`
            INSERT INTO change_records
                (id, session_id, task_id, file_path, original_content, updated_content,
                 diff, applied_at, rolled_back, provider, confidence, impact_report_id,
                 operation, source_path)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
        `).run(
            change.id,
            change.sessionId,
            change.taskId,
            change.filePath,
            change.originalContent,
            change.updatedContent,
            change.diff,
            change.appliedAt,
            change.provider,
            change.confidence,
            change.impactReportId ?? null,
            operation,
            change.sourcePath ?? null,
        );

        return { ...change, operation, rolledBack: false };
    }

    markRolledBack(id: string): void {
        this.db.prepare(
            'UPDATE change_records SET rolled_back = 1, rolled_back_at = ? WHERE id = ?',
        ).run(Date.now(), id);
    }

    getById(id: string): ChangeRecord | null {
        const row = this.db.prepare('SELECT * FROM change_records WHERE id = ?').get(id) as ChangeRow | undefined;
        return row ? this.rowToRecord(row) : null;
    }

    getBySession(sessionId: string): ChangeRecord[] {
        const rows = this.db.prepare(
            'SELECT * FROM change_records WHERE session_id = ? ORDER BY applied_at DESC, id DESC',
        ).all(sessionId) as ChangeRow[];
        return rows.map(row => this.rowToRecord(row));
    }

    getByFile(filePath: string, limit = 50): ChangeRecord[] {
        const rows = this.db.prepare(`
            SELECT * FROM change_records
            WHERE file_path = ? OR source_path = ?
            ORDER BY applied_at DESC, id DESC
            LIMIT ?
        `).all(filePath, filePath, limit) as ChangeRow[];
        return rows.map(row => this.rowToRecord(row));
    }

    getLatestForFile(filePath: string): ChangeRecord | null {
        const row = this.db.prepare(`
            SELECT * FROM change_records
            WHERE (file_path = ? OR source_path = ?) AND rolled_back = 0
            ORDER BY applied_at DESC, id DESC
            LIMIT 1
        `).get(filePath, filePath) as ChangeRow | undefined;
        return row ? this.rowToRecord(row) : null;
    }

    getRecent(limit = 20): ChangeRecord[] {
        const rows = this.db.prepare(
            'SELECT * FROM change_records ORDER BY applied_at DESC, id DESC LIMIT ?',
        ).all(limit) as ChangeRow[];
        return rows.map(row => this.rowToRecord(row));
    }

    getActiveByFile(filePath: string): ChangeRecord[] {
        const rows = this.db.prepare(`
            SELECT * FROM change_records
            WHERE (file_path = ? OR source_path = ?) AND rolled_back = 0
            ORDER BY applied_at DESC, id DESC
        `).all(filePath, filePath) as ChangeRow[];
        return rows.map(row => this.rowToRecord(row));
    }

    private rowToRecord(row: ChangeRow): ChangeRecord {
        const operation = (row.operation || 'modify') as ChangeOperation;
        return {
            id: row.id,
            sessionId: row.session_id,
            taskId: row.task_id,
            filePath: row.file_path,
            originalContent: row.original_content,
            updatedContent: row.updated_content,
            diff: row.diff,
            appliedAt: row.applied_at,
            rolledBack: row.rolled_back === 1,
            rolledBackAt: row.rolled_back_at ?? undefined,
            provider: row.provider as ChangeRecord['provider'],
            confidence: row.confidence,
            impactReportId: row.impact_report_id ?? undefined,
            operation,
            sourcePath: row.source_path ?? undefined,
        };
    }
}
