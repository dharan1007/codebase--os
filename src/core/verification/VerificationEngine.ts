import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import type { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { SandboxManager, type SandboxResult } from '../sandbox/SandboxManager.js';
import { parseBabel, detectLanguage } from '../../utils/ast.js';

export interface VerificationCheck {
    name: string;
    command?: string;
    success: boolean;
    durationMs: number;
    output: string;
    error?: string;
}

export interface VerificationReport {
    success: boolean;
    checks: VerificationCheck[];
    commands: string[];
    summary: string;
}

/** Independent post-mutation verification. The model never chooses these gates. */
export class VerificationEngine {
    constructor(
        private rootDir: string,
        private graph: RelationshipGraph,
        private sandbox: SandboxManager = new SandboxManager(rootDir),
    ) {}

    async verify(changedFiles: string[]): Promise<VerificationReport> {
        const normalizedFiles = [...new Set(changedFiles.map(file =>
            path.isAbsolute(file) ? path.resolve(file) : path.resolve(this.rootDir, file),
        ))];
        const checks: VerificationCheck[] = [];

        checks.push(...this.runLocalSyntaxChecks(normalizedFiles));
        if (checks.some(check => !check.success)) return this.finish(checks);

        const commands = this.discoverVerificationCommands(normalizedFiles);
        if (commands.length === 0 && normalizedFiles.length > 0) {
            checks.push({
                name: 'verification-strategy',
                success: false,
                durationMs: 0,
                output: '',
                error:
                    'No executable verification strategy was found for the changed project. ' +
                    'Add a build/test/typecheck script or a supported language manifest before autonomous completion.',
            });
            return this.finish(checks);
        }

        for (const command of commands) {
            const start = Date.now();
            const result = await this.sandbox.execute(command);
            checks.push(this.commandCheck(command, result, Date.now() - start));
            if (!result.success) break;
        }
        return this.finish(checks);
    }

    private runLocalSyntaxChecks(files: string[]): VerificationCheck[] {
        const checks: VerificationCheck[] = [];
        for (const filePath of files) {
            if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
            const language = detectLanguage(filePath);
            const start = Date.now();

            if (language === 'typescript' || language === 'javascript') {
                const parsed = parseBabel(fs.readFileSync(filePath, 'utf8'), filePath);
                checks.push({
                    name: `syntax:${path.relative(this.rootDir, filePath)}`,
                    success: Boolean(parsed),
                    durationMs: Date.now() - start,
                    output: parsed ? 'AST parse succeeded.' : '',
                    error: parsed ? undefined : 'Babel parser rejected the changed source file.',
                });
            } else if (filePath.endsWith('.json')) {
                try {
                    JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    checks.push({ name: `json:${path.relative(this.rootDir, filePath)}`, success: true, durationMs: Date.now() - start, output: 'JSON parse succeeded.' });
                } catch (err) {
                    checks.push({ name: `json:${path.relative(this.rootDir, filePath)}`, success: false, durationMs: Date.now() - start, output: '', error: `Invalid JSON: ${String(err)}` });
                }
            } else if (/\.ya?ml$/i.test(filePath)) {
                try {
                    yaml.parse(fs.readFileSync(filePath, 'utf8'));
                    checks.push({ name: `yaml:${path.relative(this.rootDir, filePath)}`, success: true, durationMs: Date.now() - start, output: 'YAML parse succeeded.' });
                } catch (err) {
                    checks.push({ name: `yaml:${path.relative(this.rootDir, filePath)}`, success: false, durationMs: Date.now() - start, output: '', error: `Invalid YAML: ${String(err)}` });
                }
            }
        }
        return checks;
    }

    private discoverVerificationCommands(changedFiles: string[]): string[] {
        const commands: string[] = [];
        const packageJsonPath = path.join(this.rootDir, 'package.json');

        if (fs.existsSync(packageJsonPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> };
                const scripts = pkg.scripts ?? {};
                const manager = this.nodePackageManager();
                for (const script of ['typecheck', 'check', 'lint', 'test', 'build']) {
                    if (scripts[script]?.trim()) commands.push(this.packageScriptCommand(manager, script));
                }
            } catch {
                // A malformed package.json is caught by the local JSON check if changed.
            }
        }

        if (fs.existsSync(path.join(this.rootDir, 'pyproject.toml')) ||
            fs.existsSync(path.join(this.rootDir, 'pytest.ini')) ||
            fs.existsSync(path.join(this.rootDir, 'requirements.txt'))) {
            commands.push('python -m pytest');
        }

        if (fs.existsSync(path.join(this.rootDir, 'go.mod'))) commands.push('go test ./...');
        if (fs.existsSync(path.join(this.rootDir, 'Cargo.toml'))) commands.push('cargo test --all-targets');

        if (fs.existsSync(path.join(this.rootDir, 'pom.xml'))) {
            commands.push(fs.existsSync(path.join(this.rootDir, 'mvnw')) ? 'sh ./mvnw test' : 'mvn test');
        }
        if (fs.existsSync(path.join(this.rootDir, 'build.gradle')) || fs.existsSync(path.join(this.rootDir, 'build.gradle.kts'))) {
            commands.push(fs.existsSync(path.join(this.rootDir, 'gradlew')) ? 'sh ./gradlew test' : 'gradle test');
        }

        const rootEntries = this.safeRootEntries();
        if (changedFiles.some(file => file.endsWith('.csproj') || file.endsWith('.cs')) ||
            rootEntries.some(name => name.endsWith('.sln') || name.endsWith('.csproj'))) {
            commands.push('dotnet test');
        }

        if (fs.existsSync(path.join(this.rootDir, 'pubspec.yaml'))) {
            if (this.isFlutterProject()) {
                commands.push('flutter analyze');
                commands.push('flutter test');
            } else {
                commands.push('dart analyze');
                commands.push('dart test');
            }
        }

        return [...new Set(commands)];
    }

    private isFlutterProject(): boolean {
        if (fs.existsSync(path.join(this.rootDir, '.metadata'))) return true;
        if (fs.existsSync(path.join(this.rootDir, 'android')) && fs.existsSync(path.join(this.rootDir, 'lib'))) return true;
        try {
            const pubspec = yaml.parse(fs.readFileSync(path.join(this.rootDir, 'pubspec.yaml'), 'utf8')) as any;
            return Boolean(
                pubspec?.dependencies?.flutter ||
                pubspec?.dev_dependencies?.flutter_test ||
                pubspec?.environment?.flutter,
            );
        } catch {
            return false;
        }
    }

    private safeRootEntries(): string[] {
        try { return fs.readdirSync(this.rootDir); } catch { return []; }
    }

    private nodePackageManager(): 'npm' | 'pnpm' | 'yarn' | 'bun' {
        if (fs.existsSync(path.join(this.rootDir, 'pnpm-lock.yaml'))) return 'pnpm';
        if (fs.existsSync(path.join(this.rootDir, 'yarn.lock'))) return 'yarn';
        if (fs.existsSync(path.join(this.rootDir, 'bun.lockb')) || fs.existsSync(path.join(this.rootDir, 'bun.lock'))) return 'bun';
        return 'npm';
    }

    private packageScriptCommand(manager: 'npm' | 'pnpm' | 'yarn' | 'bun', script: string): string {
        if (manager === 'npm') return script === 'test' ? 'npm test' : `npm run ${script}`;
        if (manager === 'pnpm') return script === 'test' ? 'pnpm test' : `pnpm run ${script}`;
        if (manager === 'yarn') return `yarn ${script}`;
        return `bun run ${script}`;
    }

    private commandCheck(command: string, result: SandboxResult, durationMs: number): VerificationCheck {
        return {
            name: `command:${command}`,
            command,
            success: result.success,
            durationMs,
            output: result.output.slice(-8000),
            error: result.error?.slice(-4000),
        };
    }

    private finish(checks: VerificationCheck[]): VerificationReport {
        const failures = checks.filter(check => !check.success);
        const success = checks.length > 0 && failures.length === 0;
        const commands = checks.flatMap(check => check.command ? [check.command] : []);
        const summary = success
            ? `Verification passed: ${checks.length} check(s), ${commands.length} command gate(s).`
            : `Verification failed: ${failures.length} of ${checks.length} check(s) failed.`;
        return { success, checks, commands, summary };
    }
}
