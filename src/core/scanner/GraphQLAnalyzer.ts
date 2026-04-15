import fs from 'fs';
import { logger } from '../../utils/logger.js';
import type { SourceLocation } from '../../types/index.js';

export interface GraphQLType {
    name: string;
    kind: 'type' | 'input' | 'interface' | 'enum' | 'union' | 'scalar';
    fields: GraphQLField[];
    implements: string[];
    location: SourceLocation;
}

export interface GraphQLField {
    name: string;
    type: string;
    nullable: boolean;
    isList: boolean;
    args: Array<{ name: string; type: string; defaultValue?: string }>;
    isDeprecated: boolean;
}

export interface GraphQLOperation {
    kind: 'query' | 'mutation' | 'subscription';
    name: string;
    returnType: string;
    args: GraphQLField['args'];
    location: SourceLocation;
}

export interface GraphQLSchema {
    types: GraphQLType[];
    operations: GraphQLOperation[];
    enums: Array<{ name: string; values: string[] }>;
    errors: string[];
}

export class GraphQLAnalyzer {
    parse(filePath: string): GraphQLSchema {
        const errors: string[] = [];
        const types: GraphQLType[] = [];
        const operations: GraphQLOperation[] = [];
        const enums: Array<{ name: string; values: string[] }> = [];

        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf8');
        } catch (err) {
            return { types, operations, enums, errors: [`Cannot read file: ${String(err)}`] };
        }

        const typeRegex = /(?:type|input|interface|union)\s+(\w+)(?:\s+implements\s+([\w\s&]+))?\s*\{([\s\S]*?)\}/g;
        const enumRegex = /enum\s+(\w+)\s*\{([\s\S]*?)\}/g;
        const opRegex = /(?:type\s+)?(Query|Mutation|Subscription)\s*\{([\s\S]*?)\}/g;

        let match: RegExpExecArray | null;

        while ((match = typeRegex.exec(content)) !== null) {
            const typeName = match[1]!;
            const implementsStr = match[2] ?? '';
            const body = match[3]!;
            const lineNumber = content.slice(0, match.index).split('\n').length;

            const implements_ = implementsStr
                .split('&')
                .map(s => s.trim())
                .filter(Boolean);

            const fields = this.parseFields(body);

            const kindMatch = content.slice(match.index, match.index + 20).match(/^(type|input|interface|union)/);
            const kind = (kindMatch?.[1] as GraphQLType['kind']) ?? 'type';

            if (['Query', 'Mutation', 'Subscription'].includes(typeName)) {
                for (const field of fields) {
                    operations.push({
                        kind: typeName.toLowerCase() as GraphQLOperation['kind'],
                        name: field.name,
                        returnType: field.type,
                        args: field.args,
                        location: {
                            file: filePath,
                            start: { line: lineNumber, column: 0 },
                            end: { line: lineNumber + 1, column: 0 },
                        },
                    });
                }
            } else {
                types.push({
                    name: typeName,
                    kind,
                    fields,
                    implements: implements_,
                    location: {
                        file: filePath,
                        start: { line: lineNumber, column: 0 },
                        end: { line: lineNumber + body.split('\n').length, column: 0 },
                    },
                });
            }
        }

        while ((match = enumRegex.exec(content)) !== null) {
            const enumName = match[1]!;
            const enumBody = match[2]!;
            const values = enumBody
                .split('\n')
                .map(l => l.trim())
                .filter(l => l && !l.startsWith('#'));
            enums.push({ name: enumName, values });
        }

        logger.debug('GraphQL analysis complete', { file: filePath, types: types.length, operations: operations.length });
        return { types, operations, enums, errors };
    }

    private parseFields(body: string): GraphQLField[] {
        const fields: GraphQLField[] = [];

        for (const line of body.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;

            const fieldMatch = trimmed.match(
                /^(\w+)(?:\(([^)]*)\))?\s*:\s*(\[?)(\w+)(\]?)(!?)\s*(@deprecated)?/
            );
            if (!fieldMatch) continue;

            const name = fieldMatch[1]!;
            const argsStr = fieldMatch[2] ?? '';
            const isList = fieldMatch[3] === '[';
            const typeName = fieldMatch[4]!;
            const nullable = fieldMatch[6] !== '!';
            const isDeprecated = !!fieldMatch[7];

            const args: GraphQLField['args'] = [];
            if (argsStr) {
                for (const arg of argsStr.split(',')) {
                    const argMatch = arg.trim().match(/^(\w+)\s*:\s*(\w+)(!?)\s*(?:=\s*(.+))?$/);
                    if (argMatch) {
                        args.push({
                            name: argMatch[1]!,
                            type: argMatch[2]! + argMatch[3]!,
                            defaultValue: argMatch[4],
                        });
                    }
                }
            }

            fields.push({ name, type: typeName, nullable, isList, args, isDeprecated });
        }

        return fields;
    }
}