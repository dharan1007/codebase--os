import fs from 'fs';
import type { ParsedDBSchema, ParsedDBColumn, ParsedDBRelation, Layer } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

export interface SQLParseResult {
    schemas: ParsedDBSchema[];
    errors: string[];
}

export class SQLAnalyzer {
    parse(filePath: string): SQLParseResult {
        const errors: string[] = [];
        const schemas: ParsedDBSchema[] = [];

        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf8');
        } catch (err) {
            return { schemas, errors: [`Cannot read file: ${String(err)}`] };
        }

        const createTableRegex =
            /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?(\w+)"?\.)?("?(\w+)"?)\s*\(([\s\S]*?)\);/gi;

        let match: RegExpExecArray | null;
        while ((match = createTableRegex.exec(content)) !== null) {
            const tableName = (match[3] ?? match[1] ?? '').replace(/"/g, '');
            const columnBlock = match[4] ?? '';
            const lineNumber = content.slice(0, match.index).split('\n').length;

            try {
                const { columns, relations } = this.parseColumnBlock(columnBlock, tableName);
                schemas.push({
                    tableName,
                    columns,
                    relations,
                    location: {
                        file: filePath,
                        start: { line: lineNumber, column: 0 },
                        end: { line: lineNumber + columnBlock.split('\n').length, column: 0 },
                    },
                });
            } catch (err) {
                errors.push(`Failed to parse table '${tableName}': ${String(err)}`);
            }
        }

        logger.debug('SQL analysis complete', { file: filePath, tables: schemas.length });
        return { schemas, errors };
    }

    private parseColumnBlock(
        block: string,
        tableName: string
    ): { columns: ParsedDBColumn[]; relations: ParsedDBRelation[] } {
        const columns: ParsedDBColumn[] = [];
        const relations: ParsedDBRelation[] = [];

        const lines = block
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0 && !l.startsWith('--'));

        const primaryKeys = new Set<string>();
        const uniqueKeys = new Set<string>();

        for (const line of lines) {
            const upperLine = line.toUpperCase();

            if (upperLine.startsWith('PRIMARY KEY')) {
                const match = line.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
                if (match?.[1]) {
                    match[1].split(',').map(k => k.trim().replace(/"/g, '')).forEach(k => primaryKeys.add(k));
                }
                continue;
            }

            if (upperLine.startsWith('UNIQUE')) {
                const match = line.match(/UNIQUE\s*\(([^)]+)\)/i);
                if (match?.[1]) {
                    match[1].split(',').map(k => k.trim().replace(/"/g, '')).forEach(k => uniqueKeys.add(k));
                }
                continue;
            }

            if (upperLine.startsWith('FOREIGN KEY') || upperLine.startsWith('CONSTRAINT')) {
                const fkMatch = line.match(
                    /FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+(?:"?(\w+)"?\.)?("?(\w+)"?)\s*\(([^)]+)\)/i
                );
                if (fkMatch) {
                    const fkColumn = (fkMatch[1] ?? '').trim().replace(/"/g, '');
                    const refTable = (fkMatch[4] ?? fkMatch[2] ?? '').replace(/"/g, '');
                    const refColumn = (fkMatch[5] ?? '').trim().replace(/"/g, '');
                    relations.push({
                        kind: 'many-to-many',
                        targetTable: refTable,
                        foreignKey: fkColumn,
                    });
                }
                continue;
            }

            if (
                upperLine.startsWith('INDEX') ||
                upperLine.startsWith('KEY ') ||
                upperLine.startsWith('CHECK')
            ) {
                continue;
            }

            const colMatch = line.match(
                /^"?(\w+)"?\s+(\w+(?:\([^)]*\))?(?:\s+\w+)*?)\s*(.*)?$/i
            );
            if (!colMatch) continue;

            const colName = (colMatch[1] ?? '').replace(/"/g, '');
            const colType = (colMatch[2] ?? '').split(/\s+/)[0] ?? '';
            const rest = (colMatch[3] ?? '').toUpperCase();

            if (!colName || !colType) continue;

            const isNotNull = rest.includes('NOT NULL');
            const isPK = rest.includes('PRIMARY KEY') || primaryKeys.has(colName);
            const isUnique = rest.includes('UNIQUE') || uniqueKeys.has(colName);

            let defaultValue: string | undefined;
            const defaultMatch = rest.match(/DEFAULT\s+([^\s,]+)/i);
            if (defaultMatch?.[1]) defaultValue = defaultMatch[1];

            let references: ParsedDBColumn['references'];
            const refMatch = line.match(/REFERENCES\s+(?:"?(\w+)"?\.)?("?(\w+)"?)\s*\(([^)]+)\)/i);
            if (refMatch) {
                const refTable = (refMatch[3] ?? refMatch[1] ?? '').replace(/"/g, '');
                const refCol = (refMatch[4] ?? '').trim().replace(/"/g, '');
                references = { table: refTable, column: refCol };
                relations.push({
                    kind: 'many-to-many',
                    targetTable: refTable,
                    foreignKey: colName,
                });
            }

            columns.push({
                name: colName,
                type: colType,
                nullable: !isNotNull && !isPK,
                primaryKey: isPK,
                unique: isUnique || isPK,
                defaultValue,
                references,
            });
        }

        return { columns, relations };
    }

    parsePrismaSchema(filePath: string): SQLParseResult {
        const errors: string[] = [];
        const schemas: ParsedDBSchema[] = [];

        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf8');
        } catch (err) {
            return { schemas, errors: [`Cannot read Prisma schema: ${String(err)}`] };
        }

        const modelRegex = /model\s+(\w+)\s*\{([\s\S]*?)\}/g;
        let match: RegExpExecArray | null;

        while ((match = modelRegex.exec(content)) !== null) {
            const modelName = match[1]!;
            const modelBody = match[2]!;
            const lineNumber = content.slice(0, match.index).split('\n').length;

            const columns: ParsedDBColumn[] = [];
            const relations: ParsedDBRelation[] = [];

            for (const line of modelBody.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) continue;

                const fieldMatch = trimmed.match(/^(\w+)\s+(\w+)(\?)?(\[\])?\s*(.*)?$/);
                if (!fieldMatch) continue;

                const fieldName = fieldMatch[1]!;
                const fieldType = fieldMatch[2]!;
                const isOptional = fieldMatch[3] === '?';
                const isArray = fieldMatch[4] === '[]';
                const attributes = fieldMatch[5] ?? '';

                const isPK = attributes.includes('@id');
                const isUnique = attributes.includes('@unique');

                const defaultMatch = attributes.match(/@default\(([^)]+)\)/);
                const defaultValue = defaultMatch?.[1];

                const relationMatch = attributes.match(/@relation\(fields:\s*\[(\w+)\],\s*references:\s*\[(\w+)\]\)/);
                if (relationMatch) {
                    relations.push({
                        kind: isArray ? 'one-to-many' : 'one-to-one',
                        targetTable: fieldType,
                        foreignKey: relationMatch[1]!,
                    });
                    continue;
                }

                const scalarTypes = new Set(['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'Bytes', 'BigInt', 'Decimal']);
                if (!scalarTypes.has(fieldType) && !isPK) {
                    continue;
                }

                columns.push({
                    name: fieldName,
                    type: fieldType,
                    nullable: isOptional,
                    primaryKey: isPK,
                    unique: isUnique || isPK,
                    defaultValue,
                });
            }

            schemas.push({
                tableName: modelName,
                columns,
                relations,
                location: {
                    file: filePath,
                    start: { line: lineNumber, column: 0 },
                    end: { line: lineNumber + modelBody.split('\n').length, column: 0 },
                },
            });
        }

        logger.debug('Prisma schema analysis complete', { file: filePath, models: schemas.length });
        return { schemas, errors };
    }
}