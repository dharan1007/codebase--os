import type { SyncReport, SyncIssue } from '../../types/index.js';
import type { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { SchemaSync } from './SchemaSync.js';
import { APISync } from './APISync.js';
import { TypeSync } from './TypeSync.js';
import { TypeScriptAnalyzer } from '../scanner/TypeScriptAnalyzer.js';
import { Database } from '../../storage/Database.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';

/** Read-only cross-layer contract analysis. Mutations are delegated to AgentLoop. */
export class CrossLayerSynchronizer {
    private schemaSync: SchemaSync;
    private apiSync: APISync;
    private typeSync: TypeSync;

    constructor(
        private graph: RelationshipGraph,
        private tsAnalyzer: TypeScriptAnalyzer,
        private db: Database,
    ) {
        this.schemaSync = new SchemaSync(graph, db);
        this.apiSync = new APISync(graph, db);
        this.typeSync = new TypeSync(graph, tsAnalyzer);
    }

    runFullSync(): SyncReport {
        logger.info('Running read-only cross-layer contract analysis...');
        const allIssues: SyncIssue[] = [
            ...this.schemaSync.detectSchemaDrift(),
            ...this.apiSync.detectAPIContractDrift(),
            ...this.typeSync.detectTypeMismatches(),
        ];
        const deduplicated = this.deduplicateIssues(allIssues);

        // This command is intentionally observational. Previous code exposed an
        // "auto-fixed" concept while attemptAutoFix always returned false. That
        // was misleading. Repairs must go through the transactional AgentLoop.
        const autoFixed: SyncIssue[] = [];
        const requiresManualFix = deduplicated;
        const bySeverity = {
            breaking: deduplicated.filter(issue => issue.severity === 'breaking').length,
            major: deduplicated.filter(issue => issue.severity === 'major').length,
            minor: deduplicated.filter(issue => issue.severity === 'minor').length,
            patch: deduplicated.filter(issue => issue.severity === 'patch').length,
        };
        const summary = [
            `Found ${deduplicated.length} cross-layer contract issue(s).`,
            `Breaking: ${bySeverity.breaking}; major: ${bySeverity.major}; minor: ${bySeverity.minor}; patch: ${bySeverity.patch}.`,
            deduplicated.length > 0
                ? 'No files were changed. Use `cos fix` or `cos agent` to repair findings through verified mutations.'
                : 'No cross-layer contract drift was detected from the currently indexed evidence.',
        ].join('\n');

        const report: SyncReport = {
            id: uuidv4(),
            timestamp: Date.now(),
            issues: deduplicated,
            autoFixed,
            requiresManualFix,
            summary,
        };
        this.persistReport(report);
        logger.info('Cross-layer analysis complete', { total: deduplicated.length, ...bySeverity });
        return report;
    }

    private deduplicateIssues(issues: SyncIssue[]): SyncIssue[] {
        const seen = new Set<string>();
        return issues.filter(issue => {
            const key = [
                issue.kind,
                issue.sourceFile,
                issue.targetFile ?? '',
                issue.sourceNodeId,
                issue.targetNodeId ?? '',
                issue.description,
            ].join(':');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    private persistReport(report: SyncReport): void {
        try {
            this.db.prepare(`
                INSERT INTO sync_reports (id, timestamp, issues_json, auto_fixed_json, requires_manual_json, summary)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(
                report.id,
                report.timestamp,
                JSON.stringify(report.issues),
                JSON.stringify(report.autoFixed),
                JSON.stringify(report.requiresManualFix),
                report.summary,
            );
        } catch (err) {
            logger.warn('Failed to persist sync report', { error: String(err) });
        }
    }
}
