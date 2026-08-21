import fs from 'fs';
import path from 'path';
import { parse } from '@babel/parser';
import traverse, { type NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { ParsedDBColumn, ParsedDBSchema, SourceLocation } from '../../types/index.js';

export interface ParsedAPICall {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';
    path: string;
    client: 'fetch' | 'axios';
    location: SourceLocation;
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);

function location(filePath: string, node: t.Node): SourceLocation {
    return {
        file: filePath,
        start: { line: node.loc?.start.line ?? 1, column: node.loc?.start.column ?? 0 },
        end: { line: node.loc?.end.line ?? node.loc?.start.line ?? 1, column: node.loc?.end.column ?? node.loc?.start.column ?? 0 },
    };
}

function literalString(node: t.Node | null | undefined): string | null {
    if (t.isStringLiteral(node)) return node.value;
    if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
        return node.quasis.map(part => part.value.cooked ?? part.value.raw).join('');
    }
    return null;
}

function objectStringProperty(node: t.Node | null | undefined, key: string): string | null {
    if (!t.isObjectExpression(node)) return null;
    for (const property of node.properties) {
        if (!t.isObjectProperty(property)) continue;
        const propertyName = t.isIdentifier(property.key) ? property.key.name : literalString(property.key);
        if (propertyName !== key) continue;
        return literalString(property.value as t.Node);
    }
    return null;
}

function normalizeMethod(value: string | null | undefined, fallback = 'GET'): ParsedAPICall['method'] | null {
    const method = (value || fallback).toUpperCase();
    return HTTP_METHODS.has(method) ? method as ParsedAPICall['method'] : null;
}

export function extractAPICalls(filePath: string, source: string): ParsedAPICall[] {
    if (!/\.[cm]?[jt]sx?$/i.test(filePath)) return [];
    let ast: ReturnType<typeof parse>;
    try {
        ast = parse(source, {
            sourceType: 'unambiguous', sourceFilename: filePath,
            plugins: ['typescript', 'jsx', 'decorators-legacy', 'classProperties', 'dynamicImport', 'optionalChaining'],
            errorRecovery: true,
        });
    } catch {
        return [];
    }

    const calls: ParsedAPICall[] = [];
    const push = (method: ParsedAPICall['method'] | null, apiPath: string | null, node: t.Node, client: ParsedAPICall['client']): void => {
        if (!method || !apiPath || !apiPath.trim()) return;
        calls.push({ method, path: apiPath, client, location: location(filePath, node) });
    };

    traverse(ast, {
        CallExpression(callPath: NodePath<t.CallExpression>) {
            const node = callPath.node;
            const callee = node.callee;
            if (t.isIdentifier(callee, { name: 'fetch' })) {
                push(normalizeMethod(objectStringProperty(node.arguments[1] as t.Node | undefined, 'method')), literalString(node.arguments[0] as t.Node | undefined), node, 'fetch');
                return;
            }
            if (t.isMemberExpression(callee) && !callee.computed && t.isIdentifier(callee.object, { name: 'axios' }) && t.isIdentifier(callee.property)) {
                push(normalizeMethod(callee.property.name), literalString(node.arguments[0] as t.Node | undefined), node, 'axios');
                return;
            }
            if (t.isIdentifier(callee, { name: 'axios' })) {
                const config = node.arguments[0] as t.Node | undefined;
                push(normalizeMethod(objectStringProperty(config, 'method')), objectStringProperty(config, 'url'), node, 'axios');
            }
        },
    });

    const seen = new Set<string>();
    return calls.filter(call => {
        const key = `${call.method}:${call.path}:${call.location.start.line}:${call.client}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

export function extractPrismaSchemas(filePath: string, source: string): ParsedDBSchema[] {
    if (path.extname(filePath).toLowerCase() !== '.prisma') return [];
    const schemas: ParsedDBSchema[] = [];
    const modelPattern = /\bmodel\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)\}/g;
    let match: RegExpExecArray | null;
    while ((match = modelPattern.exec(source))) {
        const tableName = match[1]!;
        const body = match[2] ?? '';
        const columns: ParsedDBColumn[] = [];
        const relations: ParsedDBSchema['relations'] = [];
        const startLine = source.slice(0, match.index).split('\n').length;
        for (const rawLine of body.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('//') || line.startsWith('@@')) continue;
            const fieldMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\])?(\?)?\s*(.*)$/);
            if (!fieldMatch) continue;
            const [, name, baseType, arrayMarker, nullableMarker, attrs = ''] = fieldMatch;
            if (/@relation\b/.test(attrs) && /^[A-Z]/.test(baseType!)) {
                relations.push({ kind: arrayMarker ? 'one-to-many' : 'one-to-one', targetTable: baseType!, foreignKey: name! });
            }
            columns.push({
                name: name!, type: `${baseType}${arrayMarker ?? ''}`, nullable: Boolean(nullableMarker),
                primaryKey: /@id\b/.test(attrs), unique: /@unique\b/.test(attrs),
                defaultValue: attrs.match(/@default\(([^)]*)\)/)?.[1],
            });
        }
        schemas.push({
            tableName, columns, relations,
            location: { file: filePath, start: { line: startLine, column: 0 }, end: { line: startLine + body.split(/\r?\n/).length + 1, column: 0 } },
        });
    }
    return schemas;
}

function splitTopLevelComma(input: string): string[] {
    const parts: string[] = [];
    let current = '';
    let depth = 0;
    let quote: string | null = null;
    for (let index = 0; index < input.length; index++) {
        const char = input[index]!;
        if (quote) {
            current += char;
            if (char === quote && input[index - 1] !== '\\') quote = null;
            continue;
        }
        if (char === '\'' || char === '"' || char === '`') { quote = char; current += char; continue; }
        if (char === '(') depth++;
        else if (char === ')') depth = Math.max(0, depth - 1);
        if (char === ',' && depth === 0) { if (current.trim()) parts.push(current.trim()); current = ''; }
        else current += char;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

function findClosingParen(source: string, openIndex: number): number {
    let depth = 0;
    let quote: string | null = null;
    for (let index = openIndex; index < source.length; index++) {
        const char = source[index]!;
        if (quote) { if (char === quote && source[index - 1] !== '\\') quote = null; continue; }
        if (char === '\'' || char === '"' || char === '`') { quote = char; continue; }
        if (char === '(') depth++;
        else if (char === ')' && --depth === 0) return index;
    }
    return -1;
}

export function extractSQLSchemas(filePath: string, source: string): ParsedDBSchema[] {
    if (path.extname(filePath).toLowerCase() !== '.sql') return [];
    const schemas: ParsedDBSchema[] = [];
    const createPattern = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"\[]?([A-Za-z_][A-Za-z0-9_.$-]*)[`"\]]?\s*\(/ig;
    let match: RegExpExecArray | null;
    while ((match = createPattern.exec(source))) {
        const openIndex = createPattern.lastIndex - 1;
        const closeIndex = findClosingParen(source, openIndex);
        if (closeIndex < 0) continue;
        const body = source.slice(openIndex + 1, closeIndex);
        const tableName = match[1]!;
        const columns: ParsedDBColumn[] = [];
        const relations: ParsedDBSchema['relations'] = [];
        for (const definition of splitTopLevelComma(body)) {
            const normalized = definition.trim();
            const foreign = normalized.match(/^FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+[`"\[]?([^\s(`"\]]+)[`"\]]?\s*\(([^)]+)\)/i);
            if (foreign) { relations.push({ kind: 'one-to-many', targetTable: foreign[2]!, foreignKey: foreign[1]!.replace(/[`"\[\]]/g, '').trim() }); continue; }
            if (/^(PRIMARY|UNIQUE|CHECK|CONSTRAINT|KEY|INDEX)\b/i.test(normalized)) continue;
            const columnMatch = normalized.match(/^[`"\[]?([A-Za-z_][A-Za-z0-9_$-]*)[`"\]]?\s+([^\s,]+)([\s\S]*)$/);
            if (!columnMatch) continue;
            const [, name, sqlType, attrs = ''] = columnMatch;
            const ref = attrs.match(/REFERENCES\s+[`"\[]?([^\s(`"\]]+)[`"\]]?\s*\(([^)]+)\)/i);
            columns.push({
                name: name!, type: sqlType!, nullable: !/\bNOT\s+NULL\b/i.test(attrs),
                primaryKey: /\bPRIMARY\s+KEY\b/i.test(attrs), unique: /\bUNIQUE\b/i.test(attrs),
                defaultValue: attrs.match(/\bDEFAULT\s+([^\s,]+)/i)?.[1],
                references: ref ? { table: ref[1]!, column: ref[2]!.replace(/[`"\[\]]/g, '').trim() } : undefined,
            });
            if (ref) relations.push({ kind: 'one-to-many', targetTable: ref[1]!, foreignKey: name! });
        }
        const startLine = source.slice(0, match.index).split('\n').length;
        schemas.push({
            tableName, columns, relations,
            location: { file: filePath, start: { line: startLine, column: 0 }, end: { line: startLine + body.split(/\r?\n/).length + 1, column: 0 } },
        });
        createPattern.lastIndex = closeIndex + 1;
    }
    return schemas;
}

export function analyzeContracts(filePath: string): { apiCalls: ParsedAPICall[]; dbSchemas: ParsedDBSchema[] } {
    let source = '';
    try { source = fs.readFileSync(filePath, 'utf8'); } catch { return { apiCalls: [], dbSchemas: [] }; }
    return { apiCalls: extractAPICalls(filePath, source), dbSchemas: [...extractPrismaSchemas(filePath, source), ...extractSQLSchemas(filePath, source)] };
}
