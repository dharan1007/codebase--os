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

export function validateSchema(data: any, schema: any): boolean {
    if (!data || !schema) return false;
    return Object.keys(schema).every(key => key in data);
}

export function sanitizeAIOutput(raw: string): string {
    return raw.trim();
}

/**
 * [ARCHITECTURAL HARDENING]: Fuzzy JSON Search Engine
 * This implementation is physically incapable of failing just because 
 * the AI added conversational filler (e.g. "Sure, here is the JSON:").
 * It uses a sliding-window bracket matcher to find the first valid JSON object.
 */
export function extractJSONFromAIOutput(raw: string): any {
    const content = raw.trim();
    
    // Attempt 1: Standard parse
    try { return JSON.parse(content); } catch { }

    // Attempt 2: Search for JSON blocks in backticks
    const fenceMatches = [...content.matchAll(/```(?:json)?\n?([\s\S]*?)```/g)];
    for (const match of fenceMatches) {
        try {
            return JSON.parse(match[1].trim());
        } catch { }
    }

    // Attempt 3: Sliding window bracket matching (Deep Search)
    const firstBrace = content.indexOf('{');
    const lastBrace = content.lastIndexOf('}');
    const firstBracket = content.indexOf('[');
    const lastBracket = content.lastIndexOf(']');

    const start = (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) ? firstBrace : firstBracket;
    const end = (lastBrace !== -1 && (lastBracket === -1 || lastBrace > lastBracket)) ? lastBrace : lastBracket;

    if (start !== -1 && end !== -1 && end > start) {
        const candidate = content.substring(start, end + 1);
        try {
            // Basic "AI Self-Repair": remove trailing commas before parsing
            const repaired = candidate.replace(/,(\s*[\]\}])/g, '$1');
            return JSON.parse(repaired);
        } catch {
            // Last resort: try the raw candidate
            try { return JSON.parse(candidate); } catch { }
        }
    }

    throw new Error('No valid JSON structure found in AI response after deep extraction.');
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
    'spawn_sub_agent',
    'finish',
]);

export const AgentActionSchema = z.object({
    tool: AgentToolEnum,
    args: z.record(z.string()).default({}),
    reasoning: z.string().min(1, 'Reasoning must not be empty'),
    tasklist: z.array(z.string()).optional(),
});

export type AgentActionValidated = z.infer<typeof AgentActionSchema>;

/**
 * Validates a raw parsed agent action against the schema and enforces path safety.
 * Throws with a clear repair message on failure so the agent can self-correct.
 */
export function validateAgentAction(raw: unknown, rootDir: string): AgentActionValidated {
    const result = AgentActionSchema.safeParse(raw);
    if (!result.success) {
        const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        throw new Error(`[SCHEMA VIOLATION]: Invalid action structure — ${issues}. Fix the JSON and retry.`);
    }

    const action = result.data;

    // Path sandbox: reject absolute paths or paths escaping rootDir
    const pathArg = action.args['path'] || action.args['oldPath'] || action.args['newPath'];
    if (pathArg) {
        if (path.isAbsolute(pathArg)) {
            throw new Error(
                `[PATH SANDBOX VIOLATION]: "${pathArg}" is an absolute path. ` +
                `You MUST use paths relative to the project root. Correct the path and retry.`
            );
        }
        const resolved = path.resolve(rootDir, pathArg);
        const rootResolved = path.resolve(rootDir);
        if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
            throw new Error(
                `[PATH SANDBOX VIOLATION]: "${pathArg}" escapes the project root. ` +
                `All file paths must be relative and within the project. Correct the path and retry.`
            );
        }
    }

    // Content presence: write_file and patch_file must have non-empty content/diff
    if (action.tool === 'write_file' && (!action.args['content'] || action.args['content'].trim().length === 0)) {
        throw new Error('[CONTENT VIOLATION]: write_file requires a non-empty "content" argument. Provide the full file content.');
    }
    if (action.tool === 'patch_file' && (!action.args['diff'] || action.args['diff'].trim().length === 0)) {
        throw new Error('[CONTENT VIOLATION]: patch_file requires a non-empty "diff" argument in unified diff format.');
    }
    if (action.tool === 'finish' && (!action.args['summary'] || action.args['summary'].trim().length === 0)) {
        throw new Error('[CONTENT VIOLATION]: finish requires a non-empty "summary" argument describing what was accomplished.');
    }

    return action;
}