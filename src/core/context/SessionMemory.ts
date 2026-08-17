import type { Database } from '../../storage/Database.js';
import path from 'path';

export interface PastSession {
    sessionId: string;
    filesModified: string[];
    changeCount: number;
    appliedAt: number;
}

export interface ProjectMemory {
    pastSessions: PastSession[];
    totalChanges: number;
    hotFiles: Array<{ file: string; changeCount: number }>;
    recurringFailureFiles: Array<{ file: string; failureCount: number; lastError: string }>;
    formatted: string;
}

/**
 * Reconstructs project-scoped engineering memory from durable change and
 * failure records. This is evidence-backed memory, not raw chat history.
 */
export class SessionMemory {
    constructor(private db: Database, private rootDir: string) {}

    load(lastNSessions = 5): ProjectMemory {
        try {
            let rows: any[] = [];
            try {
                rows = this.db.prepare(`
                    SELECT session_id, file_path, applied_at, confidence
                    FROM change_records
                    WHERE rolled_back = 0
                    ORDER BY applied_at DESC
                    LIMIT 300
                `).all() as any[];
            } catch {
                return this.empty();
            }

            const sessionMap = new Map<string, PastSession>();
            const fileFreq = new Map<string, number>();

            for (const row of rows) {
                const relPath = path.relative(this.rootDir, row.file_path).replace(/\\/g, '/');
                const session: PastSession = sessionMap.get(row.session_id) ?? {
                    sessionId: String(row.session_id),
                    filesModified: [],
                    changeCount: 0,
                    appliedAt: Number(row.applied_at) || 0,
                };
                if (!session.filesModified.includes(relPath)) session.filesModified.push(relPath);
                session.changeCount++;
                session.appliedAt = Math.max(session.appliedAt, Number(row.applied_at) || 0);
                sessionMap.set(session.sessionId, session);
                fileFreq.set(relPath, (fileFreq.get(relPath) ?? 0) + 1);
            }

            const pastSessions = [...sessionMap.values()]
                .sort((a, b) => b.appliedAt - a.appliedAt)
                .slice(0, Math.max(0, lastNSessions));

            const hotFiles = [...fileFreq.entries()]
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .slice(0, 8)
                .map(([file, changeCount]) => ({ file, changeCount }));

            let recurringFailureFiles: ProjectMemory['recurringFailureFiles'] = [];
            try {
                const failures = this.db.prepare(`
                    SELECT
                        fs.filePath AS file_path,
                        SUM(COALESCE(fs.frequency, 1)) AS failureCount,
                        (
                            SELECT latest.message
                            FROM failure_snapshots latest
                            WHERE latest.filePath = fs.filePath
                            ORDER BY latest.timestamp DESC
                            LIMIT 1
                        ) AS lastError
                    FROM failure_snapshots fs
                    GROUP BY fs.filePath
                    HAVING SUM(COALESCE(fs.frequency, 1)) >= 2
                    ORDER BY failureCount DESC
                    LIMIT 6
                `).all() as any[];

                recurringFailureFiles = failures.map(failure => ({
                    file: path.relative(this.rootDir, failure.file_path).replace(/\\/g, '/'),
                    failureCount: Number(failure.failureCount) || 0,
                    lastError: String(failure.lastError ?? '').slice(0, 160),
                }));
            } catch {
                recurringFailureFiles = [];
            }

            const memory: ProjectMemory = {
                pastSessions,
                totalChanges: rows.length,
                hotFiles,
                recurringFailureFiles,
                formatted: '',
            };
            memory.formatted = this.format(memory);
            return memory;
        } catch {
            return this.empty();
        }
    }

    private empty(): ProjectMemory {
        return {
            pastSessions: [],
            totalChanges: 0,
            hotFiles: [],
            recurringFailureFiles: [],
            formatted: '',
        };
    }

    private format(memory: ProjectMemory): string {
        if (memory.totalChanges === 0 && memory.recurringFailureFiles.length === 0) return '';

        const lines: string[] = [
            '=== PROJECT MEMORY (durable engineering evidence) ===',
            `Recorded successful changes: ${memory.totalChanges}`,
            '',
        ];

        if (memory.pastSessions.length > 0) {
            lines.push('Recent recorded sessions:');
            for (const session of memory.pastSessions) {
                const date = new Date(session.appliedAt).toISOString().slice(0, 16).replace('T', ' ');
                const fileList = session.filesModified.slice(0, 4).join(', ') +
                    (session.filesModified.length > 4 ? ` +${session.filesModified.length - 4} more` : '');
                lines.push(`  [${date}] ${session.changeCount} changes | ${fileList}`);
            }
            lines.push('');
        }

        if (memory.hotFiles.length > 0) {
            lines.push('Frequently modified files:');
            for (const file of memory.hotFiles.slice(0, 5)) {
                lines.push(`  ${file.file} (${file.changeCount}x)`);
            }
            lines.push('');
        }

        if (memory.recurringFailureFiles.length > 0) {
            lines.push('Recurring failure zones:');
            for (const failure of memory.recurringFailureFiles) {
                lines.push(`  ${failure.file} (${failure.failureCount} failures): ${failure.lastError}`);
            }
            lines.push('');
        }

        lines.push('=== END PROJECT MEMORY ===');
        return lines.join('\n');
    }
}
