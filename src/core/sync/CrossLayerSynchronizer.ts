import type { SyncReport, SyncIssue } from '../../types/index.js';
import type { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { SchemaSync } from './SchemaSync.js';
import { APISync } from './APISync.js';
import { TypeSync } from './TypeSync.js';
import { TypeScriptAnalyzer } from '../scanner/TypeScriptAnalyzer.js';
import { Database } from '../../storage/Database.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';

export class CrossLayerSynchronizer {
    private schemaSync: SchemaSync;
    private apiSync: APISync;
    private typeSync: TypeSync;

    constructor(
        private graph: RelationshipGraph,
        private tsAnalyzer: TypeScriptAnalyzer,
        private db: Database
    ) {
        this.schemaSync = new SchemaSync(graph);
        this.apiSync = new APISync(graph);
        this.typeSync = new TypeSync(graph, tsAnalyzer);
    }

    runFullSync(): SyncReport {
        logger.info('Running full cross-layer synchronization...');

        const allIssues: SyncIssue[] = [
            ...this.schemaSync.detectSchemaDrift(),
            ...this.apiSync.detectAPIContractDrift(),
            ...this.typeSync.detectTypeMismatches(),
        ];

        const deduplicated = this.deduplicateIssues(allIssues);
        const autoFixed: SyncIssue[] = [];
        const requiresManualFix: SyncIssue[] = [];

        for (const issue of deduplicated) {
            if (issue.autoFixable) {
                const fixed = this.attemptAutoFix(issue);
                if (fixed) {
                    autoFixed.push(issue);
                } else {
                    requiresManualFix.push(issue);
                }
            } else {
                requiresManualFix.push(issue);
            }
        }

        const summary = [
            `Found ${deduplicated.length} sync issue(s)`,
            `Auto-fixed: ${autoFixed.length}`,
            `Requires manual fix: ${requiresManualFix.length}`,
            deduplicated.filter(i => i.severity === 'breaking').length > 0
                ? `⚠ ${deduplicated.filter(i => i.severity === 'breaking').length} BREAKING issue(s) detected`
                : '',
        ].filter(Boolean).join('\n');

        const report: SyncReport = {
            id: uuidv4(),
            timestamp: Date.now(),
            issues: deduplicated,
            autoFixed,
            requiresManualFix,
            summary,
        };

        this.persistReport(report);
        logger.info('Cross-layer sync complete', {
            total: deduplicated.length,
            autoFixed: autoFixed.length,
            manual: requiresManualFix.length,
        });

        return report;
    }

    private deduplicateIssues(issues: SyncIssue[]): SyncIssue[] {
        const seen = new Set<string>();
        return issues.filter(issue => {
            const key = `${issue.kind}:${issue.sourceNodeId}:${issue.targetNodeId ?? ''}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    private attemptAutoFix(_issue: SyncIssue): boolean {
        return false;
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
                report.summary
            );
        } catch (err) {
            logger.debug('Failed to persist sync report', { error: String(err) });
        }
    }
}