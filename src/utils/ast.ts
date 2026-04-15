import * as parser from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import crypto from 'crypto';
import type { Language, SourceLocation } from '../types/index.js';

export function detectLanguage(filePath: string): Language {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, Language> = {
        ts: 'typescript',
        tsx: 'typescript',
        js: 'javascript',
        jsx: 'javascript',
        mjs: 'javascript',
        cjs: 'javascript',
        py: 'python',
        go: 'go',
        rs: 'rust',
        java: 'java',
        cs: 'csharp',
        kt: 'kotlin',
        kts: 'kotlin',
        swift: 'swift',
        dart: 'dart',
        rb: 'ruby',
        php: 'php',
        c: 'c',
        h: 'c',
        cpp: 'cpp',
        cc: 'cpp',
        cxx: 'cpp',
        hpp: 'cpp',
        html: 'html',
        htm: 'html',
        css: 'css',
        scss: 'scss',
        sass: 'scss',
        sql: 'sql',
        graphql: 'graphql',
        gql: 'graphql',
        yaml: 'yaml',
        yml: 'yaml',
        json: 'json',
        dockerfile: 'dockerfile',
    };
    if (filePath.toLowerCase().endsWith('dockerfile')) return 'dockerfile';
    return map[ext] ?? 'unknown';
}

export interface BabelAST {
    ast: parser.ParseResult<t.File>;
    raw: t.File;
}

export function parseBabel(source: string, filePath: string): BabelAST | null {
    const isTS = filePath.endsWith('.ts') || filePath.endsWith('.tsx');
    const isJSX = filePath.endsWith('.jsx') || filePath.endsWith('.tsx');

    const plugins: parser.ParserPlugin[] = [
        'decorators-legacy',
        'classProperties',
        'classStaticBlock',
        'exportDefaultFrom',
        'dynamicImport',
        'importMeta',
        'nullishCoalescingOperator',
        'optionalChaining',
        'logicalAssignment',
        'numericSeparator',
        'topLevelAwait',
    ];

    if (isTS) plugins.push('typescript');
    if (isJSX) plugins.push('jsx');

    try {
        const ast = parser.parse(source, {
            sourceType: 'module',
            allowImportExportEverywhere: true,
            allowReturnOutsideFunction: true,
            plugins,
            strictMode: false,
        });
        return { ast, raw: ast.program as unknown as t.File };
    } catch {
        try {
            const ast = parser.parse(source, {
                sourceType: 'script',
                plugins,
                strictMode: false,
            });
            return { ast, raw: ast.program as unknown as t.File };
        } catch {
            return null;
        }
    }
}

export function extractImports(ast: BabelAST): Array<{
    source: string;
    specifiers: string[];
    isDefault: boolean;
    isNamespace: boolean;
}> {
    const imports: Array<{ source: string; specifiers: string[]; isDefault: boolean; isNamespace: boolean }> = [];

    traverse(ast.ast, {
        ImportDeclaration(path: NodePath<t.ImportDeclaration>) {
            const source = path.node.source.value;
            const specifiers: string[] = [];
            let isDefault = false;
            let isNamespace = false;

            for (const spec of path.node.specifiers) {
                if (t.isImportDefaultSpecifier(spec)) {
                    specifiers.push(spec.local.name);
                    isDefault = true;
                } else if (t.isImportNamespaceSpecifier(spec)) {
                    specifiers.push(`* as ${spec.local.name}`);
                    isNamespace = true;
                } else if (t.isImportSpecifier(spec)) {
                    const imported = t.isIdentifier(spec.imported)
                        ? spec.imported.name
                        : (spec.imported as t.StringLiteral).value;
                    specifiers.push(imported !== spec.local.name ? `${imported} as ${spec.local.name}` : imported);
                }
            }

            imports.push({ source, specifiers, isDefault, isNamespace });
        },
        CallExpression(path: NodePath<t.CallExpression>) {
            const callee = path.node.callee;
            if (
                (t.isIdentifier(callee) && callee.name === 'require') ||
                (t.isImport(callee))
            ) {
                const arg = path.node.arguments[0];
                if (arg && t.isStringLiteral(arg)) {
                    imports.push({ source: arg.value, specifiers: [], isDefault: true, isNamespace: false });
                }
            }
        },
    });

    return imports;
}

export function extractExports(ast: BabelAST): Array<{
    name: string;
    kind: string;
    isDefault: boolean;
}> {
    const exports: Array<{ name: string; kind: string; isDefault: boolean }> = [];

    traverse(ast.ast, {
        ExportNamedDeclaration(path: NodePath<t.ExportNamedDeclaration>) {
            const decl = path.node.declaration;
            if (decl) {
                if (t.isFunctionDeclaration(decl) && decl.id) {
                    exports.push({ name: decl.id.name, kind: 'function', isDefault: false });
                } else if (t.isClassDeclaration(decl) && decl.id) {
                    exports.push({ name: decl.id.name, kind: 'class', isDefault: false });
                } else if (t.isVariableDeclaration(decl)) {
                    for (const declarator of decl.declarations) {
                        if (t.isIdentifier(declarator.id)) {
                            exports.push({ name: declarator.id.name, kind: decl.kind === 'const' ? 'constant' : 'variable', isDefault: false });
                        }
                    }
                } else if (t.isTSTypeAliasDeclaration(decl)) {
                    exports.push({ name: decl.id.name, kind: 'type', isDefault: false });
                } else if (t.isTSInterfaceDeclaration(decl)) {
                    exports.push({ name: decl.id.name, kind: 'interface', isDefault: false });
                } else if (t.isTSEnumDeclaration(decl)) {
                    exports.push({ name: decl.id.name, kind: 'enum', isDefault: false });
                }
            }
            for (const spec of path.node.specifiers) {
                if (t.isExportSpecifier(spec)) {
                    const exported = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;
                    exports.push({ name: exported, kind: 're-export', isDefault: false });
                }
            }
        },
        ExportDefaultDeclaration(path: NodePath<t.ExportDefaultDeclaration>) {
            const decl = path.node.declaration;
            let name = 'default';
            let kind = 'default';
            if (t.isIdentifier(decl)) {
                name = decl.name;
            } else if (t.isFunctionDeclaration(decl) && decl.id) {
                name = decl.id.name;
                kind = 'function';
            } else if (t.isClassDeclaration(decl) && decl.id) {
                name = decl.id.name;
                kind = 'class';
            }
            exports.push({ name, kind, isDefault: true });
        },
    });

    return exports;
}

export function extractFunctionCalls(ast: BabelAST): string[] {
    const calls = new Set<string>();

    traverse(ast.ast, {
        CallExpression(path: NodePath<t.CallExpression>) {
            const callee = path.node.callee;
            if (t.isIdentifier(callee)) {
                calls.add(callee.name);
            } else if (t.isMemberExpression(callee)) {
                if (t.isIdentifier(callee.object) && t.isIdentifier(callee.property)) {
                    calls.add(`${callee.object.name}.${callee.property.name}`);
                }
            }
        },
    });

    return Array.from(calls);
}

export function nodeToLocation(node: t.Node, filePath: string): SourceLocation {
    return {
        file: filePath,
        start: { line: node.loc?.start.line ?? 0, column: node.loc?.start.column ?? 0 },
        end: { line: node.loc?.end.line ?? 0, column: node.loc?.end.column ?? 0 },
    };
}

export function contentHash(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
}

export function extractHTTPRoutes(ast: BabelAST): Array<{
    method: string;
    path: string;
    handlerName: string;
    location: SourceLocation;
}> {
    const routes: Array<{ method: string; path: string; handlerName: string; location: SourceLocation }> = [];
    const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'use']);

    traverse(ast.ast, {
        CallExpression(nodePath: NodePath<t.CallExpression>) {
            const callee = nodePath.node.callee;
            if (!t.isMemberExpression(callee)) return;
            if (!t.isIdentifier(callee.property)) return;

            const method = callee.property.name.toLowerCase();
            if (!HTTP_METHODS.has(method)) return;

            const args = nodePath.node.arguments;
            if (args.length < 2) return;

            const firstArg = args[0];
            if (!firstArg || !t.isStringLiteral(firstArg)) return;

            const routePath = firstArg.value;
            const handlers: string[] = [];

            for (let i = 1; i < args.length; i++) {
                const arg = args[i];
                if (!arg) continue;
                if (t.isIdentifier(arg)) {
                    handlers.push(arg.name);
                } else if (t.isFunctionExpression(arg) || t.isArrowFunctionExpression(arg)) {
                    handlers.push('anonymous');
                }
            }

            routes.push({
                method: method.toUpperCase(),
                path: routePath,
                handlerName: handlers.join(', '),
                location: nodeToLocation(nodePath.node, ''),
            });
        },
    });

    return routes;
}