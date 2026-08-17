import { exec, spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { promisify } from 'util';
import fg from 'fast-glob';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

export interface SandboxResult {
    success: boolean;
    output: string;
    error?: string;
    exitCode?: number;
}

const FORBIDDEN_SHELL_METACHARACTERS = /[;&|`$<>{}()\n\r]/;
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;
const SENSITIVE_ARGUMENT = /(^|[\\/])(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|[^\\/]*(?:credentials|service-account)[^\\/]*\.json|[^\\/]*\.(?:pem|key))$/i;

const ALL_ALLOWED_BINS = new Set([
    'node', 'npx', 'npm', 'yarn', 'pnpm', 'bun', 'ts-node', 'tsc',
    'python', 'python3', 'pip', 'pip3', 'pytest',
    'go', 'cargo', 'rustc',
    'javac', 'java', 'mvn', 'gradle',
    'dotnet', 'swift', 'flutter', 'dart',
    'echo', 'ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'pwd',
    'jest', 'vitest', 'mocha',
]);

const SECRET_GLOBS = [
    '**/.env',
    '**/.env.*',
    '**/.npmrc',
    '**/.pypirc',
    '**/.netrc',
    '**/*.pem',
    '**/*.key',
    '**/*credentials*.json',
    '**/*service-account*.json',
];

export class SandboxManager {
    private dockerAvailable: boolean | null = null;

    constructor(private rootDir: string) {}

    async execute(
        command: string,
        requireNetwork = false,
        onOutput?: (chunk: string) => void,
    ): Promise<SandboxResult> {
        const validation = this.validateCommand(command);
        if (!validation.valid) {
            logger.warn('Sandbox: command blocked', { reason: validation.reason, command });
            return {
                success: false,
                output: '',
                error: `[SANDBOX BLOCKED] ${validation.reason}`,
            };
        }

        if (await this.isDockerAvailable()) {
            return this.executeInDocker(command, validation.bin!, requireNetwork, onOutput);
        }

        if (process.env['COS_ALLOW_NATIVE_SANDBOX'] !== '1') {
            return {
                success: false,
                output: '',
                error:
                    '[SANDBOX BLOCKED] Docker is unavailable. Native execution is disabled by default because ' +
                    'project scripts are arbitrary host code. Install/start Docker or explicitly set ' +
                    'COS_ALLOW_NATIVE_SANDBOX=1 to accept reduced isolation.',
            };
        }

        return this.executeNatively(command, onOutput);
    }

    private validateCommand(command: string): { valid: boolean; reason?: string; bin?: string } {
        const trimmed = command.trim();
        if (!trimmed) return { valid: false, reason: 'Empty command' };
        if (trimmed.length > 8192) return { valid: false, reason: 'Command exceeds the 8KB safety limit' };

        if (FORBIDDEN_SHELL_METACHARACTERS.test(trimmed)) {
            return {
                valid: false,
                reason: 'Command contains shell-control characters. Only a single simple command is allowed.',
            };
        }

        const tokens = trimmed.split(/\s+/);
        const rawBin = tokens[0]!;
        const bin = path.basename(rawBin).toLowerCase();
        if (!ALL_ALLOWED_BINS.has(bin)) {
            return {
                valid: false,
                reason: `Binary "${rawBin}" is not in the execution allowlist.`,
            };
        }

        for (const rawArg of tokens.slice(1)) {
            const arg = rawArg.replace(/^['"]|['"]$/g, '');
            if (/(^|[\\/])\.\.([\\/]|$)/.test(arg)) {
                return { valid: false, reason: `Directory traversal is not allowed in argument "${rawArg}".` };
            }
            if ((arg.startsWith('/') && !arg.startsWith('/tmp/')) || WINDOWS_ABSOLUTE_PATH.test(arg)) {
                return { valid: false, reason: `Absolute filesystem paths are not allowed: "${rawArg}".` };
            }
            if (SENSITIVE_ARGUMENT.test(arg)) {
                return { valid: false, reason: `Direct access to sensitive credential material is blocked: "${rawArg}".` };
            }
        }

        return { valid: true, bin };
    }

    private async executeInDocker(
        command: string,
        bin: string,
        requireNetwork: boolean,
        onOutput?: (chunk: string) => void,
    ): Promise<SandboxResult> {
        const maskRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-os-mask-'));
        const emptyFile = path.join(maskRoot, 'empty');
        const emptyDir = path.join(maskRoot, 'empty-dir');
        fs.writeFileSync(emptyFile, '', { mode: 0o600 });
        fs.mkdirSync(emptyDir, { mode: 0o700 });

        try {
            const needsNetwork = requireNetwork || this.commandRequiresNetwork(command, bin);
            const image = this.imageForCommand(bin);
            const memory = process.env['COS_SANDBOX_MEMORY'] || '2g';
            const cpus = process.env['COS_SANDBOX_CPUS'] || '1.0';

            const dockerArgs = [
                'run', '--rm', '--interactive',
                '--read-only',
                `--cpus=${cpus}`,
                `--memory=${memory}`,
                `--memory-swap=${memory}`,
                '--pids-limit=256',
                needsNetwork ? '--network=bridge' : '--network=none',
                '--mount', `type=bind,source=${path.resolve(this.rootDir)},target=/source,readonly`,
                '--mount', 'type=volume,target=/workspace',
                '--mount', 'type=tmpfs,target=/tmp,tmpfs-size=512m',
                '--mount', 'type=tmpfs,target=/root/.cache,tmpfs-size=256m',
                '--mount', 'type=tmpfs,target=/root/.npm,tmpfs-size=256m',
                '--security-opt=no-new-privileges',
                '--cap-drop=ALL',
                '--workdir=/workspace',
            ];

            // Hide repository metadata and Codebase OS state from commands.
            for (const directory of ['.git', '.cos']) {
                if (fs.existsSync(path.join(this.rootDir, directory))) {
                    dockerArgs.push(
                        '--mount',
                        `type=bind,source=${emptyDir},target=/source/${directory},readonly`,
                    );
                }
            }

            // Mask credential-shaped files before the read-only source tree is
            // copied into the disposable writable workspace.
            const sensitiveFiles = fg.sync(SECRET_GLOBS, {
                cwd: this.rootDir,
                dot: true,
                onlyFiles: true,
                followSymbolicLinks: false,
                ignore: [
                    '**/node_modules/**',
                    '**/.git/**',
                    '**/.cos/**',
                    '**/dist/**',
                    '**/.env.example',
                    '**/.env.sample',
                    '**/.env.template',
                ],
            }).slice(0, 256);
            for (const relative of sensitiveFiles) {
                const containerTarget = `/source/${relative.replace(/\\/g, '/')}`;
                dockerArgs.push(
                    '--mount',
                    `type=bind,source=${emptyFile},target=${containerTarget},readonly`,
                );
            }

            const effectiveCommand = this.wrapPackageManagerCommand(command, bin);
            const shellCommand =
                'set -eu; ' +
                'cp -a /source/. /workspace/; ' +
                'cd /workspace; ' +
                'export PATH="/workspace/node_modules/.bin:$PATH"; ' +
                `exec ${effectiveCommand}`;

            dockerArgs.push(image, '/bin/sh', '-c', shellCommand);
            return await this.spawnWithOutput(['docker', ...dockerArgs], onOutput);
        } finally {
            try { fs.rmSync(maskRoot, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    }

    private async executeNatively(
        command: string,
        onOutput?: (chunk: string) => void,
    ): Promise<SandboxResult> {
        logger.warn('Sandbox: native execution explicitly enabled; isolation is reduced.');
        const tokens = command.trim().split(/\s+/);
        const bin = tokens[0]!;
        const args = tokens.slice(1);

        return this.spawnWithOutput([bin, ...args], onOutput, {
            cwd: this.rootDir,
            env: this.buildSanitizedEnvironment(),
        });
    }

    private buildSanitizedEnvironment(): NodeJS.ProcessEnv {
        const safeNames = new Set([
            'PATH', 'Path', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP',
            'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
            'LANG', 'LC_ALL', 'TERM', 'CI', 'NODE_ENV', 'NO_COLOR', 'FORCE_COLOR',
        ]);
        for (const name of (process.env['COS_SANDBOX_ENV_ALLOW'] || '').split(',')) {
            if (name.trim()) safeNames.add(name.trim());
        }

        const env: NodeJS.ProcessEnv = {};
        for (const name of safeNames) {
            const value = process.env[name];
            if (value !== undefined) env[name] = value;
        }
        return env;
    }

    private commandRequiresNetwork(command: string, bin: string): boolean {
        const tokens = command.trim().split(/\s+/);
        const subcommand = (tokens[1] || '').toLowerCase();
        const second = (tokens[2] || '').toLowerCase();

        if (['npm', 'pnpm', 'yarn', 'bun'].includes(bin)) {
            return ['install', 'i', 'add', 'update', 'upgrade', 'ci'].includes(subcommand);
        }
        if (['pip', 'pip3'].includes(bin)) {
            return ['install', 'download', 'wheel'].includes(subcommand);
        }
        if (bin === 'go') {
            return subcommand === 'get' || (subcommand === 'mod' && ['download', 'tidy'].includes(second));
        }
        if (bin === 'cargo') {
            return ['fetch', 'install', 'update', 'search'].includes(subcommand);
        }
        return false;
    }

    private imageForCommand(bin: string): string {
        const overrides: Record<string, string | undefined> = {
            node: process.env['COS_SANDBOX_NODE_IMAGE'],
            python: process.env['COS_SANDBOX_PYTHON_IMAGE'],
            go: process.env['COS_SANDBOX_GO_IMAGE'],
            rust: process.env['COS_SANDBOX_RUST_IMAGE'],
            java: process.env['COS_SANDBOX_JAVA_IMAGE'],
            dotnet: process.env['COS_SANDBOX_DOTNET_IMAGE'],
        };

        if (['python', 'python3', 'pip', 'pip3', 'pytest'].includes(bin)) {
            return overrides.python || 'python:3.12-slim';
        }
        if (bin === 'go') return overrides.go || 'golang:1.24-bookworm';
        if (['cargo', 'rustc'].includes(bin)) return overrides.rust || 'rust:1-bookworm';
        if (bin === 'mvn') return process.env['COS_SANDBOX_MAVEN_IMAGE'] || 'maven:3.9-eclipse-temurin-21';
        if (bin === 'gradle') return process.env['COS_SANDBOX_GRADLE_IMAGE'] || 'gradle:8-jdk21';
        if (['java', 'javac'].includes(bin)) return overrides.java || 'eclipse-temurin:21-jdk';
        if (bin === 'dotnet') return overrides.dotnet || 'mcr.microsoft.com/dotnet/sdk:8.0';
        if (bin === 'bun') return process.env['COS_SANDBOX_BUN_IMAGE'] || 'oven/bun:1';
        return overrides.node || 'node:20-bookworm-slim';
    }

    private wrapPackageManagerCommand(command: string, bin: string): string {
        if (bin === 'pnpm' || bin === 'yarn') return `corepack ${command}`;
        return command;
    }

    private spawnWithOutput(
        args: string[],
        onOutput?: (chunk: string) => void,
        options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
    ): Promise<SandboxResult> {
        return new Promise(resolve => {
            const [bin, ...rest] = args;
            const proc = spawn(bin!, rest, {
                cwd: options.cwd ?? this.rootDir,
                env: options.env ?? process.env,
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: false,
            });

            const outputChunks: string[] = [];
            const errorChunks: string[] = [];
            const maxOutputBytes = this.positiveInt(process.env['COS_SANDBOX_MAX_OUTPUT_BYTES'], 2_000_000);
            const timeoutMs = this.positiveInt(process.env['COS_SANDBOX_TIMEOUT_MS'], 300_000);
            let capturedBytes = 0;
            let timedOut = false;
            let outputLimited = false;

            const timeout = setTimeout(() => {
                timedOut = true;
                proc.kill('SIGKILL');
            }, timeoutMs);

            const capture = (chunk: Buffer, target: string[]): void => {
                if (outputLimited) return;
                const remaining = maxOutputBytes - capturedBytes;
                if (remaining <= 0) {
                    outputLimited = true;
                    proc.kill('SIGKILL');
                    return;
                }

                const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
                const text = slice.toString('utf8');
                capturedBytes += slice.byteLength;
                target.push(text);
                onOutput?.(text);

                if (chunk.byteLength > remaining) {
                    outputLimited = true;
                    proc.kill('SIGKILL');
                }
            };

            proc.stdout?.on('data', (chunk: Buffer) => capture(chunk, outputChunks));
            proc.stderr?.on('data', (chunk: Buffer) => capture(chunk, errorChunks));

            proc.on('close', code => {
                clearTimeout(timeout);
                const output = outputChunks.join('');
                const errorOutput = errorChunks.join('');

                if (timedOut) {
                    resolve({
                        success: false,
                        output,
                        error: `Command timed out after ${timeoutMs}ms.`,
                        exitCode: -1,
                    });
                    return;
                }
                if (outputLimited) {
                    resolve({
                        success: false,
                        output,
                        error: `Command exceeded the ${maxOutputBytes}-byte output safety limit.`,
                        exitCode: -1,
                    });
                    return;
                }

                resolve({
                    success: code === 0,
                    output,
                    error: code !== 0 ? errorOutput || `Process exited with code ${code}` : undefined,
                    exitCode: code ?? -1,
                });
            });

            proc.on('error', err => {
                clearTimeout(timeout);
                resolve({ success: false, output: '', error: err.message, exitCode: -1 });
            });
        });
    }

    private async isDockerAvailable(): Promise<boolean> {
        if (this.dockerAvailable !== null) return this.dockerAvailable;
        try {
            await execAsync('docker info', { timeout: 5000 });
            this.dockerAvailable = true;
        } catch {
            this.dockerAvailable = false;
        }
        return this.dockerAvailable;
    }

    private positiveInt(value: string | undefined, fallback: number): number {
        const parsed = Number.parseInt(value ?? '', 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }
}
