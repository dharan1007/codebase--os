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
 * SessionMemory — the second major differentiator of Codebase OS.
 *
 * Claude Code, Codex, and Cursor start every session completely blank.
 * They have NO memory of what was done in previous sessions.
 *
 * SessionMemory reads the persistent SQLite change_records table and
 * reconstructs a structured "project memory" context block that is
 * injected into the agent's initial prompt at the start of every run.
 *
 * This gives Codebase OS genuine multi-session intelligence:
 * - What files have been most frequently modified
 * - What zones of the codebase keep generating failures (and why)
 * - What was accomplished in the last N sessions
 * - What the agent should NOT repeat (known failure patterns)
 */
export class SessionMemory {
    constructor(private db: Database, private rootDir: string) {}

    load(lastNSessions = 5): ProjectMemory {
        try {
            // Query recent change records, grouped by session
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
                // Table might not exist yet on a fresh project
                return this.empty();
            }

            if (rows.length === 0) return this.empty();

            // Group by session
            const sessionMap = new Map<string, PastSession>();
            for (const row of rows) {
                const relPath = path.relative(this.rootDir, row.file_path).replace(/\\/g, '/');
                if (!sessionMap.has(row.session_id)) {
                    sessionMap.set(row.session_id, {
                        sessionId: row.session_id,
                        filesModified: [],
                        changeCount: 0,
                        appliedAt: row.applied_at,
                    });
                }
                const s = sessionMap.get(row.session_id)!;
                if (!s.filesModified.includes(relPath)) s.filesModified.push(relPath);
                s.changeCount++;
            }

            const pastSessions = [...sessionMap.values()]
                .sort((a, b) => b.appliedAt - a.appliedAt)
                .slice(0, lastNSessions);

            // File modification frequency — "hot files"
            const fileFreq = new Map<string, number>();
            for (const row of rows) {
                const rel = path.relative(this.rootDir, row.file_path).replace(/\\/g, '/');
                fileFreq.set(rel, (fileFreq.get(rel) ?? 0) + 1);
            }
            const hotFiles = [...fileFreq.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([file, changeCount]) => ({ file, changeCount }));

            // Recurring failures from failure_log
            let recurringFailureFiles: ProjectMemory['recurringFailureFiles'] = [];
            try {
                const failures = this.db.prepare(`
                    SELECT file_path, COUNT(*) as failureCount, MAX(message) as lastError
                    FROM failure_log
                    GROUP BY file_path
                    HAVING failureCount >= 2
                    ORDER BY failureCount DESC
                    LIMIT 6
                `).all() as any[];
                recurringFailureFiles = failures.map(f => ({
                    file: path.relative(this.rootDir, f.file_path).replace(/\\/g, '/'),
                    failureCount: f.failureCount,
                    lastError: (f.lastError ?? '').toString().slice(0, 100),
                }));
            } catch { /* table may not exist */ }

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
        return { pastSessions: [], totalChanges: 0, hotFiles: [], recurringFailureFiles: [], formatted: '' };
    }

    private format(m: ProjectMemory): string {
        if (m.totalChanges === 0) return '';

        const lines: string[] = [
            '=== PROJECT MEMORY (persistent across sessions) ===',
            `Total changes recorded: ${m.totalChanges}`,
            '',
        ];

        if (m.pastSessions.length > 0) {
            lines.push('Recent sessions (most recent first):');
            for (const s of m.pastSessions) {
                const date = new Date(s.appliedAt).toISOString().slice(0, 16).replace('T', ' ');
                const fileList = s.filesModified.slice(0, 4).join(', ') + (s.filesModified.length > 4 ? ` +${s.filesModified.length - 4} more` : '');
                lines.push(`  [${date}]  ${s.changeCount} changes  |  ${fileList}`);
            }
            lines.push('');
        }

        if (m.hotFiles.length > 0) {
            lines.push('Hot files (modified most frequently — approach with care):');
            for (const f of m.hotFiles.slice(0, 5)) {
                lines.push(`  ${f.file}  (${f.changeCount}x)`);
            }
            lines.push('');
        }

        if (m.recurringFailureFiles.length > 0) {
            lines.push('Recurring failure zones (do NOT repeat these mistakes):');
            for (const f of m.recurringFailureFiles) {
                lines.push(`  ${f.file}  (${f.failureCount} failures): ${f.lastError}`);
            }
            lines.push('');
        }

        lines.push('=== END PROJECT MEMORY ===');
        return lines.join('\n');
    }
}
