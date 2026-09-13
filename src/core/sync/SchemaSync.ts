import type { FileAnalysis, ParsedDBSchema, SyncIssue } from '../../types/index.js';
import type { RelationshipGraph } from '../graph/RelationshipGraph.js';
import type { Database } from '../../storage/Database.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';

interface AnalysisRow {
    file_path: string;
    analysis_json: string;
}

export class SchemaSync {
    constructor(private graph: RelationshipGraph, private db: Database) {}

    detectSchemaDrift(): SyncIssue[] {
        const issues: SyncIssue[] = [];
        const backendNodes = this.graph.findNodesByLayer('backend');
        const schemas = this.loadSchemas();

        for (const { filePath, schema } of schemas) {
            const tableName = schema.tableName.toLowerCase();
            const sourceNode = this.graph.getNodesByFile(filePath).find(node => node.kind === 'file');
            const correspondingModels = backendNodes.filter(node => {
                if (!['class', 'interface', 'type', 'file'].includes(node.kind)) return false;
                const meta = node.metadata as { modelName?: string; tableName?: string };
                const names = [node.name, meta.modelName, meta.tableName].filter(Boolean).map(value => String(value).toLowerCase());
                return names.some(name => name === tableName || name === `${tableName}model` || name === `${tableName}entity` || name.includes(`/${tableName}.`));
            });

            if (correspondingModels.length === 0) {
                issues.push({
                    id: uuidv4(),
                    kind: 'schema_drift',
                    description: `Database contract '${schema.tableName}' has no corresponding backend model/entity in the current relationship graph.`,
                    sourceFile: filePath,
                    sourceNodeId: sourceNode?.id ?? `schema:${filePath}:${schema.tableName}`,
                    severity: 'minor',
                    autoFixable: false,
                    suggestedFix: `Map or implement a backend model/entity for '${schema.tableName}', then rescan.`,
                });
                continue;
            }

            // Where a graph model exposes field/property metadata, compare it to
            // the authoritative DB contract rather than silently ignoring drift.
            for (const model of correspondingModels) {
                const metadata = model.metadata as { properties?: Array<{ name?: string }> };
                if (!Array.isArray(metadata.properties) || metadata.properties.length === 0) continue;
                const modelFields = new Set(metadata.properties.map(property => String(property.name ?? '').toLowerCase()).filter(Boolean));
                const missing = schema.columns.filter(column => !modelFields.has(column.name.toLowerCase()));
                if (missing.length === 0) continue;
                issues.push({
                    id: uuidv4(),
                    kind: 'missing_field',
                    description: `Backend model '${model.name}' is missing DB field(s): ${missing.map(column => column.name).join(', ')}.`,
                    sourceFile: filePath,
                    targetFile: model.filePath,
                    sourceNodeId: sourceNode?.id ?? `schema:${filePath}:${schema.tableName}`,
                    targetNodeId: model.id,
                    severity: 'major',
                    autoFixable: false,
                    suggestedFix: `Reconcile '${model.name}' with the persisted '${schema.tableName}' database contract.`,
                });
            }
        }

        logger.debug('Schema drift detection complete', { schemas: schemas.length, issues: issues.length });
        return issues;
    }

    private loadSchemas(): Array<{ filePath: string; schema: ParsedDBSchema }> {
        let rows: AnalysisRow[] = [];
        try {
            rows = this.db.prepare(`
                SELECT file_path, analysis_json
                FROM file_analyses
                WHERE layer = 'database' OR file_path LIKE '%.sql' OR file_path LIKE '%.prisma'
            `).all() as AnalysisRow[];
        } catch (err) {
            logger.warn('SchemaSync: unable to read persisted file analyses', { error: String(err) });
            return [];
        }

        const result: Array<{ filePath: string; schema: ParsedDBSchema }> = [];
        for (const row of rows) {
            try {
                const analysis = JSON.parse(row.analysis_json) as FileAnalysis;
                for (const schema of analysis.dbSchemas ?? []) result.push({ filePath: row.file_path, schema });
            } catch (err) {
                logger.debug('SchemaSync: skipped malformed persisted analysis', { file: row.file_path, error: String(err) });
            }
        }
        return result;
    }
}
