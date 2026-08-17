import { Project, SourceFile, Diagnostic, DiagnosticCategory } from 'ts-morph';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
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
            let sourceFile: SourceFile | undefined = this.project.getSourceFile(filePath);
            if (sourceFile) {
                sourceFile.replaceWithText(content);
            } else {
                sourceFile = this.project.createSourceFile(filePath, content, { overwrite: true });
            }

            const diagnostics: Diagnostic[] = sourceFile.getPreEmitDiagnostics();
            const errors: ValidationError[] = [];
            const warnings: ValidationWarning[] = [];

            for (const diagnostic of diagnostics) {
                const start = diagnostic.getStart();
                const diagnosticSourceFile = diagnostic.getSourceFile();
                let line = 0;
                let column = 0;

                if (start !== undefined && diagnosticSourceFile) {
                    const pos = diagnosticSourceFile.getLineAndColumnAtPos(start);
                    line = pos.line;
                    column = pos.column;
                }

                const entry = {
                    file: filePath,
                    line,
                    column,
                    message: diagnostic.getMessageText().toString(),
                    code: diagnostic.getCode(),
                };

                if (diagnostic.getCategory() === DiagnosticCategory.Error) {
                    errors.push(entry);
                } else if (diagnostic.getCategory() === DiagnosticCategory.Warning) {
                    warnings.push(entry);
                }
            }

            return { valid: errors.length === 0, errors, warnings };
        } catch (err) {
            const message = `Validator execution failed: ${String(err)}`;
            logger.warn('TypeScript validation failed closed', { error: String(err), file: filePath });
            return {
                valid: false,
                errors: [{
                    file: filePath,
                    line: 0,
                    column: 0,
                    message,
                    // A synthetic compiler-range code keeps callers that gate on
                    // low-numbered TS diagnostics from accidentally ignoring this.
                    code: 1999,
                }],
                warnings: [],
            };
        }
    }

    validateSyntax(content: string, filePath: string): boolean {
        const result = this.validateFile(filePath, content);
        return result.valid && result.errors.filter(e => e.code < 2000).length === 0;
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

export function validateSchema(data: any, schema: any): boolean {
    if (!data || !schema) return false;
    return Object.keys(schema).every(key => key in data);
}

/**
 * Removes a single outer Markdown code fence when a provider ignored the
 * raw-code-only instruction. Internal fences are preserved.
 */
export function sanitizeAIOutput(raw: string): string {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/^```(?:[\w.+-]+)?\s*\n([\s\S]*?)\n```$/);
    return fenced ? fenced[1]!.trim() : trimmed;
}

/** Extracts the first parseable JSON object/array from provider output. */
export function extractJSONFromAIOutput(raw: string): any {
    const content = raw.trim();

    try { return JSON.parse(content); } catch { /* continue */ }

    const fenceMatches = [...content.matchAll(/```(?:json)?\n?([\s\S]*?)```/g)];
    for (const match of fenceMatches) {
        try {
            return JSON.parse(match[1]!.trim());
        } catch { /* continue */ }
    }

    const firstBrace = content.indexOf('{');
    const lastBrace = content.lastIndexOf('}');
    const firstBracket = content.indexOf('[');
    const lastBracket = content.lastIndexOf(']');

    const start = (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) ? firstBrace : firstBracket;
    const end = (lastBrace !== -1 && (lastBracket === -1 || lastBrace > lastBracket)) ? lastBrace : lastBracket;

    if (start !== -1 && end !== -1 && end > start) {
        const candidate = content.substring(start, end + 1);
        try {
            const repaired = candidate.replace(/,(\s*[\]\}])/g, '$1');
            return JSON.parse(repaired);
        } catch {
            try { return JSON.parse(candidate); } catch { /* continue */ }
        }
    }

    throw new Error('No valid JSON structure found in AI response.');
}

// ─── Agent Action Schema ──────────────────────────────────────────────────────

const AgentToolEnum = z.enum([
    'read_file',
    'write_file',
    'patch_file',
    'delete_file',
    'move_file',
    'list_files',
    'run_shell',
    'search_code',
    'find_references',
    'pause_and_ask',
    'finish',
]);

export const AgentActionSchema = z.object({
    tool: AgentToolEnum,
    args: z.record(z.string()).default({}),
    reasoning: z.string().min(1, 'Reasoning must not be empty'),
    tasklist: z.array(z.string()).optional(),
});

export type AgentActionValidated = z.infer<typeof AgentActionSchema>;

export function validateAgentAction(raw: unknown, rootDir: string): AgentActionValidated {
    const result = AgentActionSchema.safeParse(raw);
    if (!result.success) {
        const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        throw new Error(`[SCHEMA VIOLATION]: Invalid action structure — ${issues}. Fix the JSON and retry.`);
    }

    const action = result.data;
    const pathArgs = [
        action.args['path'],
        action.args['oldPath'],
        action.args['newPath'],
        action.args['dir'],
    ].filter((value): value is string => Boolean(value));

    for (const pathArg of pathArgs) {
        if (path.isAbsolute(pathArg)) {
            throw new Error(
                `[PATH SANDBOX VIOLATION]: "${pathArg}" is an absolute path. ` +
                'Use paths relative to the project root.',
            );
        }
        const resolved = path.resolve(rootDir, pathArg);
        const rootResolved = path.resolve(rootDir);
        if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
            throw new Error(
                `[PATH SANDBOX VIOLATION]: "${pathArg}" escapes the project root.`,
            );
        }
    }

    if (action.tool === 'write_file' && (!action.args['content'] || action.args['content'].trim().length === 0)) {
        throw new Error('[CONTENT VIOLATION]: write_file requires non-empty "content".');
    }
    if (action.tool === 'patch_file' && (!action.args['diff'] || action.args['diff'].trim().length === 0)) {
        throw new Error('[CONTENT VIOLATION]: patch_file requires a non-empty unified "diff".');
    }
    if (action.tool === 'finish' && (!action.args['summary'] || action.args['summary'].trim().length === 0)) {
        throw new Error('[CONTENT VIOLATION]: finish requires a non-empty "summary".');
    }

    return action;
}
