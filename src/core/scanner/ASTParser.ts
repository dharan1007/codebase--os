import fs from 'fs';
import { parseBabel, extractImports, extractExports, extractFunctionCalls, extractHTTPRoutes, nodeToLocation, contentHash, detectLanguage } from '../../utils/ast.js';
import type { ParsedImport, ParsedExport, ParsedFunction, ParsedClass, ParsedInterface, ParsedAPIEndpoint, Language, SourceLocation } from '../../types/index.js';
import traverse, { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { GenericAnalyzer } from './GenericAnalyzer.js';

export interface RawParseResult {
    language: Language;
    hash: string;
    imports: ParsedImport[];
    exports: ParsedExport[];
    functions: ParsedFunction[];
    classes: ParsedClass[];
    interfaces: ParsedInterface[];
    types: Array<{ name: string; definition: string; location: SourceLocation; isExported: boolean }>;
    variables: Array<{ name: string; type?: string; isConst: boolean; isExported: boolean; location: SourceLocation }>;
    apiEndpoints: ParsedAPIEndpoint[];
    errors: string[];
}

export function parseFile(filePath: string): RawParseResult {
    const language = detectLanguage(filePath);
    const errors: string[] = [];

    let source: string;
    try {
        source = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        return {
            language, hash: '', imports: [], exports: [], functions: [],
            classes: [], interfaces: [], types: [], variables: [], apiEndpoints: [],
            errors: [`Cannot read file: ${String(err)}`],
        };
    }

    const hash = contentHash(source);

    if (language !== 'typescript' && language !== 'javascript') {
        const genericAnalyzer = new GenericAnalyzer();
        const genericResult = genericAnalyzer.analyze(filePath, language);
        return {
            language: genericResult.language,
            hash: genericResult.hash,
            imports: genericResult.imports,
            exports: genericResult.exports,
            functions: genericResult.functions,
            classes: genericResult.classes,
            interfaces: [],
            types: [],
            variables: [],
            apiEndpoints: [],
            errors: genericResult.errors,
        };
    }

    const babelAST = parseBabel(source, filePath);
    if (!babelAST) {
        return {
            language, hash, imports: [], exports: [], functions: [],
            classes: [], interfaces: [], types: [], variables: [], apiEndpoints: [],
            errors: [`Failed to parse AST for ${filePath}`],
        };
    }

    const rawImports = extractImports(babelAST);
    const imports: ParsedImport[] = rawImports.map(i => ({
        source: i.source,
        specifiers: i.specifiers,
        isDefault: i.isDefault,
        isNamespace: i.isNamespace,
    }));

    const rawExports = extractExports(babelAST);
    const exports_: ParsedExport[] = rawExports.map(e => ({
        name: e.name,
        kind: e.kind as ParsedExport['kind'],
        isDefault: e.isDefault,
    }));

    const exportedNames = new Set(rawExports.map(e => e.name));

    const functions: ParsedFunction[] = [];
    const classes: ParsedClass[] = [];
    const interfaces: ParsedInterface[] = [];
    const types: RawParseResult['types'] = [];
    const variables: RawParseResult['variables'] = [];

    traverse(babelAST.ast, {
        FunctionDeclaration(nodePath: NodePath<t.FunctionDeclaration>) {
            if (!nodePath.node.id) return;
            const name = nodePath.node.id.name;
            const params = nodePath.node.params.map((p: any) => {
                if (t.isIdentifier(p)) return p.name;
                if (t.isRestElement(p) && t.isIdentifier(p.argument)) return `...${p.argument.name}`;
                if (t.isAssignmentPattern(p) && t.isIdentifier(p.left)) return p.left.name;
                return 'unknown';
            });
            functions.push({
                name,
                params,
                isAsync: nodePath.node.async,
                isExported: exportedNames.has(name),
                location: nodeToLocation(nodePath.node, filePath),
                calls: extractFunctionCalls(babelAST),
                usesTypes: [],
            });
        },
        ArrowFunctionExpression(nodePath: NodePath<t.ArrowFunctionExpression>) {
            const parent = nodePath.parent;
            if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) {
                const name = parent.id.name;
                const params = nodePath.node.params.map((p: any) => {
                    if (t.isIdentifier(p)) return p.name;
                    return 'unknown';
                });
                functions.push({
                    name,
                    params,
                    isAsync: nodePath.node.async,
                    isExported: exportedNames.has(name),
                    location: nodeToLocation(nodePath.node, filePath),
                    calls: [],
                    usesTypes: [],
                });
            }
        },
        ClassDeclaration(nodePath: NodePath<t.ClassDeclaration>) {
            if (!nodePath.node.id) return;
            const name = nodePath.node.id.name;
            const superClass = nodePath.node.superClass && t.isIdentifier(nodePath.node.superClass)
                ? nodePath.node.superClass.name
                : undefined;

            const implements_: string[] = [];
            if (nodePath.node.implements) {
                for (const impl of nodePath.node.implements) {
                    if (t.isTSExpressionWithTypeArguments(impl) && t.isIdentifier(impl.expression)) {
                        implements_.push(impl.expression.name);
                    }
                }
            }

            const methods: ParsedFunction[] = [];
            for (const member of nodePath.node.body.body) {
                if (t.isClassMethod(member) && t.isIdentifier(member.key)) {
                    const methodName = member.key.name;
                    const params = member.params.map((p: any) => {
                        if (t.isIdentifier(p)) return p.name;
                        if (t.isTSParameterProperty(p) && t.isIdentifier(p.parameter)) return p.parameter.name;
                        return 'param';
                    });
                    methods.push({
                        name: methodName,
                        params,
                        isAsync: member.async,
                        isExported: false,
                        location: nodeToLocation(member, filePath),
                        calls: [],
                        usesTypes: [],
                    });
                }
            }

            classes.push({
                name,
                extends: superClass,
                implements: implements_,
                methods,
                properties: [],
                isExported: exportedNames.has(name),
                location: nodeToLocation(nodePath.node, filePath),
            });
        },
        TSInterfaceDeclaration(nodePath: NodePath<t.TSInterfaceDeclaration>) {
            const name = nodePath.node.id.name;
            const extended: string[] = [];
            if (nodePath.node.extends) {
                for (const ext of nodePath.node.extends) {
                    if (t.isIdentifier(ext.expression)) extended.push(ext.expression.name);
                }
            }
            interfaces.push({
                name,
                extends: extended,
                properties: [],
                methods: [],
                isExported: exportedNames.has(name),
                location: nodeToLocation(nodePath.node, filePath),
            });
        },
        TSTypeAliasDeclaration(nodePath: NodePath<t.TSTypeAliasDeclaration>) {
            const name = nodePath.node.id.name;
            types.push({
                name,
                definition: source.slice(nodePath.node.start ?? 0, nodePath.node.end ?? 0),
                location: nodeToLocation(nodePath.node, filePath),
                isExported: exportedNames.has(name),
            });
        },
        VariableDeclaration(nodePath: NodePath<t.VariableDeclaration>) {
            if (nodePath.scope.block.type !== 'Program') return;
            for (const decl of nodePath.node.declarations) {
                if (t.isIdentifier(decl.id)) {
                    variables.push({
                        name: decl.id.name,
                        isConst: nodePath.node.kind === 'const',
                        isExported: exportedNames.has(decl.id.name),
                        location: nodeToLocation(decl, filePath),
                    });
                }
            }
        },
    });

    const rawRoutes = extractHTTPRoutes(babelAST);
    const apiEndpoints: ParsedAPIEndpoint[] = rawRoutes
        .filter(r => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].includes(r.method))
        .map(r => ({
            method: r.method as ParsedAPIEndpoint['method'],
            path: r.path,
            handler: r.handlerName,
            middleware: [],
            location: { ...r.location, file: filePath },
        }));

    return {
        language, hash, imports, exports: exports_, functions, classes,
        interfaces, types, variables, apiEndpoints, errors,
    };
}