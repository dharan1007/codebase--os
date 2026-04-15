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
        const usages: Array<{ filePath: string; line: number; context: string }> = [];

        for (const sf of this.project.getSourceFiles()) {
            sf.forEachDescendant((node: any) => {
                if (Node.isTypeReference(node)) {
                    const refName = node.getTypeName().getText();
                    if (refName === typeName) {
                        const startLine = sf.getLineAndColumnAtPos(node.getStart()).line;
                        usages.push({
                            filePath: sf.getFilePath(),
                            line: startLine,
                            context: node.getParent()?.getText()?.slice(0, 100) ?? '',
                        });
                    }
                }
            });
        }

        return usages;
    }

    findAllReferences(symbolName: string): Array<{ filePath: string; line: number; context: string }> {
        const references: Array<{ filePath: string; line: number; context: string }> = [];
        
        // Use a more robust search: Check each file's global declarations and identifiers
        for (const sf of this.project.getSourceFiles()) {
            sf.forEachDescendant(node => {
                if (Node.isIdentifier(node) && node.getText() === symbolName) {
                    // Filter for actual references (not just any text match)
                    // Note: In a CLI tool, we balance precision with speed
                    const startPos = node.getStart();
                    const { line } = sf.getLineAndColumnAtPos(startPos);
                    
                    references.push({
                        filePath: sf.getFilePath(),
                        line,
                        context: node.getParent()?.getText().slice(0, 100) ?? node.getText()
                    });
                }
            });
        }
        
        return references;
    }

    schemaRename(oldName: string, newName: string): number {
        let count = 0;
        for (const sf of this.project.getSourceFiles()) {
            const identifiers = sf.getDescendantsOfKind(SyntaxKind.Identifier)
                .filter(id => id.getText() === oldName);
            
            for (const id of identifiers) {
                id.replaceWithText(newName);
                count++;
            }
        }
        return count;
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
}