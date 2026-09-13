import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { logger } from '../../utils/logger.js';
import type { Diagnostic, DiagnosticReport } from '../../types/index.js';

interface ProcessResult {
    output: string;
    exitCode: number;
    spawnError?: string;
}

export class ErrorDetector {
    constructor(private rootDir: string) {}

    private run(executable: string, args: string[]): ProcessResult {
        const result = spawnSync(executable, args, {
            cwd: this.rootDir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
            timeout: 300_000,
            windowsHide: true,
            env: process.env,
        });

        const stdout = typeof result.stdout === 'string' ? result.stdout : '';
        const stderr = typeof result.stderr === 'string' ? result.stderr : '';
        const spawnError = result.error ? result.error.message : undefined;
        return {
            output: `${stdout}${stderr}`,
            exitCode: typeof result.status === 'number' ? result.status : spawnError ? -1 : 0,
            spawnError,
        };
    }

    async runAll(filePaths?: string[]): Promise<DiagnosticReport[]> {
        const reports: DiagnosticReport[] = [];

        if (fs.existsSync(path.join(this.rootDir, 'tsconfig.json'))) {
            reports.push(await this.runTypeScript());
        }

        const eslintBinary = path.join(
            this.rootDir,
            'node_modules',
            '.bin',
            process.platform === 'win32' ? 'eslint.cmd' : 'eslint',
        );
        const eslintConfig = [
            'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs',
            '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
        ].some(file => fs.existsSync(path.join(this.rootDir, file)));
        if (eslintConfig || fs.existsSync(eslintBinary)) {
            reports.push(await this.runESLint(filePaths));
        }

        const pyFiles = filePaths?.filter(file => file.endsWith('.py')) ?? [];
        if (pyFiles.length > 0 || (!filePaths && this.hasPythonFiles())) {
            reports.push(await this.runPython(pyFiles));
        }

        return reports.filter(report => report.errors.length > 0 || report.warnings.length > 0);
    }

    groupByFile(reports: DiagnosticReport[]): Map<string, Diagnostic[]> {
        const map = new Map<string, Diagnostic[]>();
        for (const report of reports) {
            for (const diagnostic of [...report.errors, ...report.warnings]) {
                const existing = map.get(diagnostic.file) ?? [];
                existing.push(diagnostic);
                map.set(diagnostic.file, existing);
            }
        }
        return map;
    }

    async runTypeScript(): Promise<DiagnosticReport> {
        const start = Date.now();
        const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        const result = this.run(npx, ['--no-install', 'tsc', '--noEmit', '--pretty', 'false']);
        const diagnostics = this.parseTypeScriptOutput(result.output);

        if (result.spawnError) {
            diagnostics.errors.push({
                file: '',
                line: 0,
                column: 0,
                message: `Unable to run TypeScript diagnostics: ${result.spawnError}`,
                severity: 'error',
                tool: 'tsc',
            });
        } else if (result.exitCode !== 0 && diagnostics.errors.length === 0 && result.output.trim()) {
            diagnostics.errors.push({
                file: '',
                line: 0,
                column: 0,
                message: result.output.trim().slice(0, 2000),
                severity: 'error',
                tool: 'tsc',
            });
        }

        logger.debug('TypeScript check complete', { errors: diagnostics.errors.length });
        return {
            ...diagnostics,
            tool: 'TypeScript (tsc)',
            durationMs: Date.now() - start,
        };
    }

    async runESLint(filePaths?: string[]): Promise<DiagnosticReport> {
        const start = Date.now();
        const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        const targets = filePaths && filePaths.length > 0
            ? filePaths
            : ['src'];
        const args = ['--no-install', 'eslint', ...targets, '--ext', '.ts,.tsx,.js,.jsx', '--format', 'json'];
        const result = this.run(npx, args);
        const diagnostics = this.parseESLintOutput(result.output);

        if (result.spawnError) {
            diagnostics.errors.push({
                file: '',
                line: 0,
                column: 0,
                message: `Unable to run ESLint: ${result.spawnError}`,
                severity: 'error',
                tool: 'eslint',
            });
        } else if (result.exitCode > 1 && diagnostics.errors.length === 0) {
            diagnostics.errors.push({
                file: '',
                line: 0,
                column: 0,
                message: result.output.trim().slice(0, 2000) || `ESLint exited with code ${result.exitCode}`,
                severity: 'error',
                tool: 'eslint',
            });
        }

        logger.debug('ESLint check complete', { errors: diagnostics.errors.length });
        return {
            ...diagnostics,
            tool: 'ESLint',
            durationMs: Date.now() - start,
        };
    }

    async runPython(filePaths?: string[]): Promise<DiagnosticReport> {
        const start = Date.now();
        const errors: Diagnostic[] = [];
        const targets = filePaths && filePaths.length > 0 ? filePaths : this.findPythonFiles();
        const python = process.env['PYTHON'] || (process.platform === 'win32' ? 'python.exe' : 'python3');

        for (const file of targets.slice(0, 200)) {
            const result = this.run(python, ['-m', 'py_compile', file]);
            if (result.spawnError) {
                errors.push({
                    file: path.resolve(this.rootDir, file),
                    line: 0,
                    column: 0,
                    message: `Unable to run Python diagnostics: ${result.spawnError}`,
                    severity: 'error',
                    tool: 'python',
                });
                break;
            }
            if (result.exitCode === 0) continue;

            const match = result.output.match(/File "([^"]+)", line (\d+)/);
            errors.push({
                file: match?.[1]
                    ? path.resolve(this.rootDir, match[1])
                    : path.resolve(this.rootDir, file),
                line: match ? Number.parseInt(match[2]!, 10) : 0,
                column: 0,
                message: result.output.split('\n').filter(Boolean).pop() ?? result.output,
                severity: 'error',
                tool: 'python',
            });
        }

        return {
            errors,
            warnings: [],
            tool: 'Python (py_compile)',
            durationMs: Date.now() - start,
        };
    }

    private parseTypeScriptOutput(output: string): { errors: Diagnostic[]; warnings: Diagnostic[] } {
        const errors: Diagnostic[] = [];
        const warnings: Diagnostic[] = [];

        for (const rawLine of output.split('\n').filter(Boolean)) {
            const line = rawLine.replace(/\r$/, '');
            const match = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/);
            if (!match) continue;

            const diagnostic: Diagnostic = {
                file: path.resolve(this.rootDir, match[1]!),
                line: Number.parseInt(match[2]!, 10),
                column: Number.parseInt(match[3]!, 10),
                message: match[6]!,
                code: match[5],
                severity: match[4] as 'error' | 'warning',
                tool: 'tsc',
            };
            if (diagnostic.severity === 'error') errors.push(diagnostic);
            else warnings.push(diagnostic);
        }

        return { errors, warnings };
    }

    private parseESLintOutput(output: string): { errors: Diagnostic[]; warnings: Diagnostic[] } {
        const errors: Diagnostic[] = [];
        const warnings: Diagnostic[] = [];

        try {
            const jsonStart = output.indexOf('[');
            const jsonEnd = output.lastIndexOf(']') + 1;
            if (jsonStart === -1 || jsonEnd <= jsonStart) return { errors, warnings };

            const data = JSON.parse(output.slice(jsonStart, jsonEnd)) as Array<{
                filePath: string;
                messages: Array<{
                    line: number;
                    column: number;
                    message: string;
                    ruleId: string | null;
                    severity: number;
                }>;
            }>;

            for (const file of data) {
                for (const message of file.messages) {
                    const diagnostic: Diagnostic = {
                        file: file.filePath,
                        line: message.line,
                        column: message.column,
                        message: message.message,
                        code: message.ruleId ?? undefined,
                        severity: message.severity === 2 ? 'error' : 'warning',
                        tool: 'eslint',
                    };
                    if (diagnostic.severity === 'error') errors.push(diagnostic);
                    else warnings.push(diagnostic);
                }
            }
        } catch (err) {
            if (output.trim()) {
                warnings.push({
                    file: '',
                    line: 0,
                    column: 0,
                    message: `Unable to parse ESLint JSON output: ${String(err)}; ${output.trim().slice(0, 1000)}`,
                    severity: 'warning',
                    tool: 'eslint',
                });
            }
        }

        return { errors, warnings };
    }

    private hasPythonFiles(): boolean {
        return this.findPythonFiles(1).length > 0;
    }

    private findPythonFiles(limit = 200): string[] {
        const results: string[] = [];

        const walk = (directory: string): void => {
            if (results.length >= limit) return;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(directory, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                if (results.length >= limit) return;
                const fullPath = path.join(directory, entry.name);
                if (entry.isDirectory()) {
                    if (['node_modules', '.git', '.cos', 'dist', 'build', '__pycache__', '.venv', 'venv'].includes(entry.name)) {
                        continue;
                    }
                    walk(fullPath);
                } else if (entry.isFile() && entry.name.endsWith('.py')) {
                    results.push(path.relative(this.rootDir, fullPath));
                }
            }
        };

        walk(this.rootDir);
        return results;
    }
}
