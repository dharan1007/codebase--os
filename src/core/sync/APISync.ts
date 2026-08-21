import type { SyncIssue } from '../../types/index.js';
import type { RelationshipGraph } from '../graph/RelationshipGraph.js';
import type { Database } from '../../storage/Database.js';
import type { ParsedAPICall } from '../scanner/ContractAnalyzer.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';

interface AnalysisRow {
    file_path: string;
    analysis_json: string;
}

function normalizePathPattern(value: string): string {
    const stripped = value.split('?')[0] || '/';
    const normalized = stripped.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    return normalized.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, ':param');
}

export class APISync {
    constructor(private graph: RelationshipGraph, private db: Database) {}

    detectAPIContractDrift(): SyncIssue[] {
        const issues: SyncIssue[] = [];
        const apiEndpoints = Array.from(this.graph.nodes.values()).filter(node => node.kind === 'api_endpoint');
        const apiPaths = new Map<string, string>();
        for (const endpoint of apiEndpoints) {
            const meta = endpoint.metadata as { method?: string; path?: string };
            if (!meta.method || !meta.path) continue;
            apiPaths.set(`${meta.method.toUpperCase()}:${normalizePathPattern(meta.path)}`, endpoint.id);
        }

        for (const { filePath, calls } of this.loadClientCalls()) {
            const fileNode = this.graph.getNodesByFile(filePath).find(node => node.kind === 'file');
            for (const call of calls) {
                const key = `${call.method.toUpperCase()}:${normalizePathPattern(call.path)}`;
                if (apiPaths.has(key)) continue;
                issues.push({
                    id: uuidv4(),
                    kind: 'api_drift',
                    description: `Client contract '${call.method} ${call.path}' has no matching scanned API endpoint.`,
                    sourceFile: filePath,
                    sourceNodeId: fileNode?.id ?? `api-call:${filePath}:${call.location.start.line}`,
                    severity: 'major',
                    autoFixable: false,
                    suggestedFix: `Verify the route, HTTP method, API prefix, or add the missing endpoint before shipping this client call.`,
                });
            }
        }

        logger.debug('API contract drift detection complete', { endpoints: apiEndpoints.length, issues: issues.length });
        return issues;
    }

    private loadClientCalls(): Array<{ filePath: string; calls: ParsedAPICall[] }> {
        let rows: AnalysisRow[] = [];
        try {
            rows = this.db.prepare(`SELECT file_path, analysis_json FROM file_analyses`).all() as AnalysisRow[];
        } catch (err) {
            logger.warn('APISync: unable to read persisted file analyses', { error: String(err) });
            return [];
        }

        const result: Array<{ filePath: string; calls: ParsedAPICall[] }> = [];
        for (const row of rows) {
            try {
                const parsed = JSON.parse(row.analysis_json) as { apiCalls?: ParsedAPICall[] };
                if (Array.isArray(parsed.apiCalls) && parsed.apiCalls.length > 0) {
                    result.push({ filePath: row.file_path, calls: parsed.apiCalls });
                }
            } catch (err) {
                logger.debug('APISync: skipped malformed persisted analysis', { file: row.file_path, error: String(err) });
            }
        }
        return result;
    }
}
