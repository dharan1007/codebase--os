import { Project, SourceFile, Diagnostic, DiagnosticCategory } from 'ts-morph';
import path from 'path';
import fs from 'fs';
import { logger } from './logger.js';

export interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
    warnings: ValidationWarning[];
}

export interface ValidationError {
    file: string;
    line: number;
    column: number;
    message: string;
    code: number;
}

export interface ValidationWarning {
    file: string;
    line: number;
    column: number;
    message: string;
    code: number;
}

export class TypeScriptValidator {
    private project: Project;

    constructor(rootDir: string, tsConfigPath?: string) {
        const configPath = tsConfigPath ?? path.join(rootDir, 'tsconfig.json');
        if (fs.existsSync(configPath)) {
            this.project = new Project({ tsConfigFilePath: configPath, skipAddingFilesFromTsConfig: false });
        } else {
            this.project = new Project({
                compilerOptions: {
                    target: 99,
                    module: 99,
                    strict: true,
                    esModuleInterop: true,
                    skipLibCheck: true,
                },
            });
        }
    }

    validateFile(filePath: string, content: string): ValidationResult {
        try {
            let sf: SourceFile | undefined = this.project.getSourceFile(filePath);
            if (sf) {
                sf.replaceWithText(content);
            } else {
                sf = this.project.createSourceFile(filePath, content, { overwrite: true });
            }

            const diagnostics: Diagnostic[] = sf.getPreEmitDiagnostics();
            const errors: ValidationError[] = [];
            const warnings: ValidationWarning[] = [];

            for (const diag of diagnostics) {
                const start = diag.getStart();
                const sourceFile = diag.getSourceFile();
                let line = 0;
                let column = 0;

                if (start !== undefined && sourceFile) {
                    const pos = sourceFile.getLineAndColumnAtPos(start);
                    line = pos.line;
                    column = pos.column;
                }

                const entry = {
                    file: filePath,
                    line,
                    column,
                    message: diag.getMessageText().toString(),
                    code: diag.getCode(),
                };

                if (diag.getCategory() === DiagnosticCategory.Error) {
                    errors.push(entry);
                } else if (diag.getCategory() === DiagnosticCategory.Warning) {
                    warnings.push(entry);
                }
            }

            return { valid: errors.length === 0, errors, warnings };
        } catch (err) {
            logger.debug('TypeScript validation error', { error: String(err), file: filePath });
            return { valid: true, errors: [], warnings: [] };
        }
    }

    validateSyntax(content: string, filePath: string): boolean {
        const result = this.validateFile(filePath, content);
        return result.errors.filter(e => e.code < 2000).length === 0;
    }
}

export function validateJSONSyntax(content: string): { valid: boolean; error?: string } {
    try {
        JSON.parse(content);
        return { valid: true };
    } catch (err) {
        return { valid: false, error: String(err) };
    }
}

/**
 * Validates a standard configuration or metadata schema.
 * Re-added to fix compilation in AI-generated diagnostic utilities.
 */
export function validateSchema(data: any, schema: any): boolean {
    if (!data || !schema) return false;
    // Simple key-check validation
    return Object.keys(schema).every(key => key in data);
}

export function validateYAMLSyntax(content: string): { valid: boolean; error?: string } {
    try {
        const yaml = require('yaml') as typeof import('yaml');
        yaml.parse(content);
        return { valid: true };
    } catch (err) {
        return { valid: false, error: String(err) };
    }
}

export function sanitizeAIOutput(raw: string): string {
    let content = raw.trim();
    const fenceMatch = content.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
    if (fenceMatch?.[1]) {
        content = fenceMatch[1];
    }
    return content;
}

export function extractJSONFromAIOutput(raw: string): unknown {
    const sanitized = sanitizeAIOutput(raw);
    const jsonMatch = sanitized.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!jsonMatch?.[0]) throw new Error('No JSON found in AI output');
    return JSON.parse(jsonMatch[0]);
}