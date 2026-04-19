import { Project, SourceFile, SyntaxKind, Node } from 'ts-morph';
import path from 'path';
import fs from 'fs';
import type { FileAnalysis, Language, Layer } from '../../types/index.js';
import { detectLanguage } from '../../utils/ast.js';
import { logger } from '../../utils/logger.js';

export class TypeScriptAnalyzer {
    private project: Project;

    constructor(private rootDir: string) {
        const tsConfigPath = path.join(rootDir, 'tsconfig.json');
        if (fs.existsSync(tsConfigPath)) {
            this.project = new Project({
                tsConfigFilePath: tsConfigPath,
                skipAddingFilesFromTsConfig: false,
                skipFileDependencyResolution: true,
            });
        } else {
            this.project = new Project({
                compilerOptions: {
                    target: 99,
                    module: 99,
                    strict: false,
                    esModuleInterop: true,
                    allowJs: true,
                    resolveJsonModule: true,
                },
            });
        }
    }

    addOrUpdateFile(filePath: string, content: string): SourceFile {
        let sf = this.project.getSourceFile(filePath);
        if (sf) {
            sf.replaceWithText(content);
        } else {
            sf = this.project.createSourceFile(filePath, content, { overwrite: true });
        }
        return sf;
    }

    extractDetailedTypes(filePath: string): Array<{
        name: string;
        kind: 'interface' | 'type' | 'enum' | 'class';
        properties: Array<{ name: string; type: string; optional: boolean }>;
        exported: boolean;
    }> {
        const sf = this.project.getSourceFile(filePath);
        if (!sf) return [];

        const results: ReturnType<typeof this.extractDetailedTypes> = [];

        for (const iface of sf.getInterfaces()) {
            results.push({
                name: iface.getName(),
                kind: 'interface',
                exported: iface.isExported(),
                properties: iface.getProperties().map((p: any) => ({
                    name: p.getName(),
                    type: p.getType().getText(),
                    optional: p.hasQuestionToken(),
                })),
            });
        }

        for (const typeAlias of sf.getTypeAliases()) {
            results.push({
                name: typeAlias.getName(),
                kind: 'type',
                exported: typeAlias.isExported(),
                properties: [],
            });
        }

        for (const enumDecl of sf.getEnums()) {
            results.push({
                name: enumDecl.getName(),
                kind: 'enum',
                exported: enumDecl.isExported(),
                properties: enumDecl.getMembers().map((m: any) => ({
                    name: m.getName(),
                    type: 'enum_member',
                    optional: false,
                })),
            });
        }

        for (const classDecl of sf.getClasses()) {
            const name = classDecl.getName();
            if (!name) continue;
            results.push({
                name,
                kind: 'class',
                exported: classDecl.isExported(),
                properties: classDecl.getProperties().map((p: any) => ({
                    name: p.getName(),
                    type: p.getType().getText(),
                    optional: p.hasQuestionToken(),
                })),
            });
        }

        return results;
    }

    findTypeUsages(typeName: string): Array<{ filePath: string; line: number; context: string }> {
        // High-Performance Semantic Search via LanguageService
        const usages: Array<{ filePath: string; line: number; context: string }> = [];
        const languageService = this.project.getLanguageService();

        for (const sf of this.project.getSourceFiles()) {
            const nodes = sf.getDescendantsOfKind(SyntaxKind.Identifier)
                .filter(id => id.getText() === typeName);

            for (const node of nodes) {
                const referencedSymbols = languageService.findReferences(node);
                for (const refSymbol of referencedSymbols) {
                    for (const ref of refSymbol.getReferences()) {
                        const refSf = ref.getSourceFile();
                        const { line } = refSf.getLineAndColumnAtPos(ref.getTextSpan().getStart());
                        usages.push({
                            filePath: refSf.getFilePath(),
                            line,
                            context: refSymbol.getDefinition().getDeclarationNode()?.getText().slice(0, 100) || ''
                        });
                    }
                }
            }
        }

        return usages;
    }

    findAllReferences(symbolName: string): Array<{ filePath: string; line: number; context: string }> {
        return this.findTypeUsages(symbolName);
    }

    schemaRename(oldName: string, newName: string): number {
        const languageService = this.project.getLanguageService();
        let totalRenames = 0;

        for (const sf of this.project.getSourceFiles()) {
            const nodes = sf.getDescendantsOfKind(SyntaxKind.Identifier)
                .filter(id => id.getText() === oldName);

            for (const node of nodes) {
                // ts-morph node.rename handles cross-file renaming semantically
                node.rename(newName);
                totalRenames++;
            }
        }
        return totalRenames;
    }

    detectTypeBreakingChanges(
        filePath: string,
        oldContent: string,
        newContent: string
    ): Array<{ kind: string; name: string; description: string }> {
        const breaks: Array<{ kind: string; name: string; description: string }> = [];

        try {
            const oldSF = this.project.createSourceFile(`__old_${path.basename(filePath)}`, oldContent, { overwrite: true });
            const newSF = this.project.createSourceFile(`__new_${path.basename(filePath)}`, newContent, { overwrite: true });

            const oldInterfaces = new Map<string, any>(oldSF.getInterfaces().map((i: any) => [i.getName(), i]));
            const newInterfaces = new Map<string, any>(newSF.getInterfaces().map((i: any) => [i.getName(), i]));

            for (const [name, oldIface] of oldInterfaces) {
                const newIface = newInterfaces.get(name);
                if (!newIface) {
                    if (oldIface.isExported()) {
                        breaks.push({ kind: 'interface_removed', name, description: `Exported interface '${name}' was removed` });
                    }
                    continue;
                }

                const oldProps = new Map<string, any>(oldIface.getProperties().map((p: any) => [p.getName(), p]));
                const newProps = new Map<string, any>(newIface.getProperties().map((p: any) => [p.getName(), p]));

                for (const [propName, oldProp] of oldProps) {
                    const newProp = newProps.get(propName);
                    if (!newProp) {
                        breaks.push({ kind: 'property_removed', name: `${name}.${propName}`, description: `Property '${propName}' removed from interface '${name}'` });
                    } else if (oldProp.getType().getText() !== newProp.getType().getText()) {
                        breaks.push({
                            kind: 'type_changed',
                            name: `${name}.${propName}`,
                            description: `Type of '${name}.${propName}' changed from '${oldProp.getType().getText()}' to '${newProp.getType().getText()}'`,
                        });
                    }
                }
            }

            this.project.removeSourceFile(oldSF);
            this.project.removeSourceFile(newSF);
        } catch (err) {
            logger.debug('Type breaking change detection error', { error: String(err) });
        }

        return breaks;
    }

    buildCallGraph(): Array<{ sourceFile: string; callerName: string; calleeName: string; targetFile?: string }> {
        const calls: Array<{ sourceFile: string; callerName: string; calleeName: string; targetFile?: string }> = [];
        const languageService = this.project.getLanguageService();

        for (const sf of this.project.getSourceFiles()) {
            const filePath = sf.getFilePath();
            
            const callExpressions = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
            for (const callExpr of callExpressions) {
                try {
                    const expr = callExpr.getExpression();
                    let calleeName = '';
                    
                    if (Node.isIdentifier(expr)) {
                        calleeName = expr.getText();
                    } else if (Node.isPropertyAccessExpression(expr)) {
                        calleeName = expr.getName();
                    } else {
                        continue;
                    }

                    const callerFunc = callExpr.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration) ||
                                       callExpr.getFirstAncestorByKind(SyntaxKind.MethodDeclaration) ||
                                       callExpr.getFirstAncestorByKind(SyntaxKind.ArrowFunction);
                    let callerName = '(anonymous)';
                    if (callerFunc) {
                        if (Node.isFunctionDeclaration(callerFunc) || Node.isMethodDeclaration(callerFunc)) {
                            callerName = callerFunc.getName() || '(anonymous)';
                        } else if (Node.isArrowFunction(callerFunc)) {
                            const varDecl = callerFunc.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
                            if (varDecl) {
                                callerName = varDecl.getName();
                            }
                        }
                    } else {
                        callerName = '(top_level)';
                    }

                    const typeChecker = this.project.getTypeChecker();
                    const symbol = typeChecker.getSymbolAtLocation(expr);
                    let targetFile: string | undefined;
                    
                    if (symbol) {
                        const decls = symbol.getDeclarations();
                        if (decls && decls.length > 0) {
                            targetFile = decls[0].getSourceFile()?.getFilePath();
                        }
                    }

                    calls.push({ sourceFile: filePath, callerName, calleeName, targetFile });
                } catch {
                    // Ignore errors during node resolution
                }
            }
        }
        return calls;
    }
}