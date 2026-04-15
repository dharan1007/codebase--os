import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { logger } from '../../utils/logger.js';

export interface Diagnostic {
    file: string;
    line: number;
    column: number;
    message: string;
    code?: string;
    severity: 'error' | 'warning';
    tool: string;
}

export interface DiagnosticReport {
    errors: Diagnostic[];
    warnings: Diagnostic[];
    tool: string;
    durationMs: number;
}

export class ErrorDetector {
    constructor(private rootDir: string) {}

    private exec(cmd: string): string {
        try {
            return execSync(cmd, {
                cwd: this.rootDir,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (err: any) {
            return String(err?.stdout ?? '') + String(err?.stderr ?? '');
        }
    }

    async runAll(filePaths?: string[]): Promise<DiagnosticReport[]> {
        const reports: DiagnosticReport[] = [];

        const tsconfigPath = path.join(this.rootDir, 'tsconfig.json');
        if (fs.existsSync(tsconfigPath)) {
            reports.push(await this.runTypeScript());
        }

        const eslintPath = path.join(this.rootDir, '.bin', 'eslint');
        const eslintConfig = ['eslint.config.js', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml']
            .map(f => path.join(this.rootDir, f))
            .some(p => fs.existsSync(p));
        if (eslintConfig || fs.existsSync(eslintPath)) {
            reports.push(await this.runESLint(filePaths));
        }

        const pyFiles = filePaths?.filter(f => f.endsWith('.py')) ?? [];
        if (pyFiles.length > 0 || (!filePaths && this.hasPythonFiles())) {
            reports.push(await this.runPython(pyFiles));
        }

        return reports.filter(r => r.errors.length > 0 || r.warnings.length > 0);
    }

    groupByFile(reports: DiagnosticReport[]): Map<string, Diagnostic[]> {
        const map = new Map<string, Diagnostic[]>();
        for (const report of reports) {
            for (const diag of [...report.errors, ...report.warnings]) {
                const existing = map.get(diag.file) ?? [];
                existing.push(diag);
                map.set(diag.file, existing);
            }
        }
        return map;
    }

    async runTypeScript(): Promise<DiagnosticReport> {
        const start = Date.now();
        const output = this.exec('npx tsc --noEmit 2>&1');
        const diagnostics = this.parseTypeScriptOutput(output);

        logger.debug('TypeScript check complete', { errors: diagnostics.errors.length });

        return {
            ...diagnostics,
            tool: 'TypeScript (tsc)',
            durationMs: Date.now() - start,
        };
    }

    async runESLint(filePaths?: string[]): Promise<DiagnosticReport> {
        const start = Date.now();
        const target = filePaths && filePaths.length > 0
            ? filePaths.map(f => `"${f}"`).join(' ')
            : 'src --ext .ts,.tsx,.js,.jsx';
        const output = this.exec(`npx eslint ${target} --format json 2>&1`);

        const diagnostics = this.parseESLintOutput(output);
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
        for (const f of targets.slice(0, 50)) {
            const output = this.exec(`python -m py_compile "${f}" 2>&1`);
            if (output.trim()) {
                const match = output.match(/File "([^"]+)", line (\d+)/);
                errors.push({
                    file: match?.[1] ? path.resolve(this.rootDir, match[1]) : path.resolve(this.rootDir, f),
                    line: match ? parseInt(match[2]!, 10) : 0,
                    column: 0,
                    message: output.split('\n').filter(Boolean).pop() ?? output,
                    severity: 'error',
                    tool: 'python',
                });
            }
        }

        return { errors, warnings: [], tool: 'Python (py_compile)', durationMs: Date.now() - start };
    }

    private parseTypeScriptOutput(output: string): { errors: Diagnostic[]; warnings: Diagnostic[] } {
        const errors: Diagnostic[] = [];
        const warnings: Diagnostic[] = [];

        for (const line of output.split('\n').filter(Boolean)) {
            const match = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/);
            if (match) {
                const diag: Diagnostic = {
                    file: path.resolve(this.rootDir, match[1]!),
                    line: parseInt(match[2]!, 10),
                    column: parseInt(match[3]!, 10),
                    message: match[6]!,
                    code: match[5],
                    severity: match[4] as 'error' | 'warning',
                    tool: 'tsc',
                };
                if (diag.severity === 'error') errors.push(diag);
                else warnings.push(diag);
            }
        }

        return { errors, warnings };
    }

    private parseESLintOutput(output: string): { errors: Diagnostic[]; warnings: Diagnostic[] } {
        const errors: Diagnostic[] = [];
        const warnings: Diagnostic[] = [];

        try {
            const jsonStart = output.indexOf('[');
            const jsonEnd = output.lastIndexOf(']') + 1;
            if (jsonStart !== -1 && jsonEnd > jsonStart) {
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
                    for (const msg of file.messages) {
                        const diag: Diagnostic = {
                            file: file.filePath,
                            line: msg.line,
                            column: msg.column,
                            message: msg.message,
                            code: msg.ruleId ?? undefined,
                            severity: msg.severity === 2 ? 'error' : 'warning',
                            tool: 'eslint',
                        };

                        if (diag.severity === 'error') errors.push(diag);
                        else warnings.push(diag);
                    }
                }
            }
        } catch {
            for (const line of output.split('\n').filter(Boolean)) {
                warnings.push({
                    file: '',
                    line: 0,
                    column: 0,
                    message: line,
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

        const walk = (dir: string): void => {
            if (results.length >= limit) return;

            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                if (results.length >= limit) return;

                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build') {
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