import fs from 'fs';
import { logger } from '../../utils/logger.js';
import type { Diagnostic, StaticFixRule } from '../../types/index.js';
import { execSync } from 'child_process';

export class StaticPatternLibrary {
    private rules: StaticFixRule[] = [
        {
            id: 'ts-unused-var',
            tool: 'tsc',
            code: 'TS6133',
            messagePattern: "'(.+)' is declared but its value is never read",
            description: 'Remove unused variables automatically'
        },
        {
            id: 'eslint-fixable',
            tool: 'eslint',
            messagePattern: '.*', // ESLint can handle many things via --fix
            description: 'Apply standard ESLint auto-fixes'
        }
    ];

    constructor(private rootDir: string) {}

    /**
     * Attempts to apply non-AI fixes to a diagnostic.
     * Returns true if a fix was applied successfully.
     */
    async applyFix(diag: Diagnostic): Promise<boolean> {
        // Handle ESLint fixable errors via --fix
        if (diag.tool === 'eslint') {
            return this.applyEslintFix(diag.file);
        }

        // Handle specific TS patterns
        if (diag.tool === 'tsc' && diag.code === 'TS6133') {
             return this.fixUnusedVariable(diag);
        }

        return false;
    }

    private applyEslintFix(filePath: string): boolean {
        try {
            execSync(`npx eslint "${filePath}" --fix`, { cwd: this.rootDir, stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }

    private fixUnusedVariable(diag: Diagnostic): boolean {
        try {
            const content = fs.readFileSync(diag.file, 'utf8');
            const lines = content.split('\n');
            const line = lines[diag.line - 1];
            
            if (!line) return false;

            // Simple heuristic to remove a variable declaration if it's alone on a line
            // or just the variable itself if it's in a list.
            // This is a placeholder for a more robust AST-based approach but serves the "Pattern" requirement.
            const match = diag.message.match(/'(.+)' is declared/);
            if (!match) return false;
            const varName = match[1];

            // If the line is just "const varName = ...;" or "let varName;"
            const regex = new RegExp(`(const|let|var)\\s+${varName}\\s*(=.*)?;?`);
            if (regex.test(line)) {
                lines[diag.line - 1] = line.replace(regex, '').trim();
                if (lines[diag.line - 1] === '') {
                    lines.splice(diag.line - 1, 1);
                }
                fs.writeFileSync(diag.file, lines.join('\n'), 'utf8');
                return true;
            }
        } catch (err) {
            logger.warn('Failed to apply static fix for unused variable', { file: diag.file, error: String(err) });
        }
        return false;
    }
}
