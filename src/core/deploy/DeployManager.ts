import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { logger } from '../../utils/logger.js';

export type DeployTarget = 'vercel' | 'firebase' | 'fly' | 'docker';

export interface DeployOptions {
    production?: boolean;
    tag?: string;
    target?: string;
    dryRun?: boolean;
}

export interface DeployResult {
    success: boolean;
    output: string;
    error?: string;
    url?: string;
}

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20 * 60_000;

export class DeployManager {
    constructor(private rootDir: string) {}

    private async runStreaming(
        command: string,
        args: string[],
        onLine: (line: string) => void,
        timeoutMs = DEFAULT_TIMEOUT_MS,
    ): Promise<{ exitCode: number; output: string; error?: string }> {
        return new Promise(resolve => {
            let proc: ChildProcessWithoutNullStreams;
            try {
                proc = spawn(command, args, {
                    cwd: this.rootDir,
                    shell: false,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    windowsHide: true,
                    env: process.env,
                });
            } catch (err) {
                resolve({ exitCode: -1, output: '', error: String(err) });
                return;
            }

            const chunks: string[] = [];
            let outputBytes = 0;
            let settled = false;
            const append = (chunk: Buffer): void => {
                const text = chunk.toString('utf8');
                if (outputBytes < MAX_OUTPUT_BYTES) {
                    const remaining = MAX_OUTPUT_BYTES - outputBytes;
                    const clipped = Buffer.from(text).subarray(0, remaining).toString('utf8');
                    chunks.push(clipped);
                    outputBytes += Buffer.byteLength(clipped);
                }
                for (const line of text.split(/\r?\n/).filter(Boolean)) onLine(line);
            };

            proc.stdout.on('data', append);
            proc.stderr.on('data', append);

            const timeout = setTimeout(() => {
                if (settled) return;
                logger.warn('Deployment process exceeded timeout; terminating', { command, timeoutMs });
                proc.kill('SIGTERM');
                setTimeout(() => {
                    if (!settled && !proc.killed) proc.kill('SIGKILL');
                }, 5000).unref();
            }, timeoutMs);
            timeout.unref();

            proc.once('error', err => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve({ exitCode: -1, output: chunks.join(''), error: err.message });
            });
            proc.once('close', code => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve({ exitCode: code ?? 1, output: chunks.join('') });
            });
        });
    }

    async deploy(target: DeployTarget, options: DeployOptions, onLine: (line: string) => void): Promise<DeployResult> {
        const validationError = this.validateOptions(target, options);
        if (validationError) return { success: false, output: '', error: validationError };

        if (options.dryRun) {
            const summary = this.describeDeployment(target, options);
            onLine(`[DRY RUN] ${summary}`);
            return { success: true, output: `[DRY RUN] ${summary}` };
        }

        switch (target) {
            case 'vercel': return this.deployVercel(options, onLine);
            case 'firebase': return this.deployFirebase(options, onLine);
            case 'fly': return this.deployFly(onLine);
            case 'docker': return this.deployDocker(options, onLine);
        }
    }

    private async deployVercel(options: DeployOptions, onLine: (line: string) => void): Promise<DeployResult> {
        const args = options.production ? ['--prod'] : [];
        const result = await this.runStreaming('vercel', args, onLine);
        const urlMatch = result.output.match(/https:\/\/[\w.-]+\.vercel\.app(?:\/[^\s]*)?/);
        return {
            success: result.exitCode === 0,
            output: result.output,
            url: urlMatch?.[0],
            error: result.exitCode !== 0 ? result.error || 'Vercel deployment failed' : undefined,
        };
    }

    private async deployFirebase(options: DeployOptions, onLine: (line: string) => void): Promise<DeployResult> {
        const args = ['deploy'];
        if (options.target) args.push('--only', options.target);
        const result = await this.runStreaming('firebase', args, onLine);
        return {
            success: result.exitCode === 0,
            output: result.output,
            error: result.exitCode !== 0 ? result.error || 'Firebase deployment failed' : undefined,
        };
    }

    private async deployFly(onLine: (line: string) => void): Promise<DeployResult> {
        const result = await this.runStreaming('flyctl', ['deploy'], onLine);
        return {
            success: result.exitCode === 0,
            output: result.output,
            error: result.exitCode !== 0 ? result.error || 'Fly.io deployment failed' : undefined,
        };
    }

    private async deployDocker(options: DeployOptions, onLine: (line: string) => void): Promise<DeployResult> {
        const tag = options.tag ?? 'latest';
        const build = await this.runStreaming('docker', ['build', '--pull', '-t', tag, '.'], onLine);
        if (build.exitCode !== 0) {
            return { success: false, output: build.output, error: build.error || 'Docker build failed' };
        }

        const push = await this.runStreaming('docker', ['push', tag], onLine);
        return {
            success: push.exitCode === 0,
            output: build.output + push.output,
            error: push.exitCode !== 0 ? push.error || 'Docker push failed' : undefined,
        };
    }

    private validateOptions(target: DeployTarget, options: DeployOptions): string | null {
        if (target === 'docker') {
            const tag = options.tag ?? 'latest';
            if (tag.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(tag) || tag.includes('..')) {
                return `Invalid Docker image tag: ${tag}`;
            }
        }
        if (target === 'firebase' && options.target) {
            if (options.target.length > 200 || !/^[A-Za-z0-9_,:.-]+$/.test(options.target)) {
                return `Invalid Firebase --only target: ${options.target}`;
            }
        }
        return null;
    }

    private describeDeployment(target: DeployTarget, options: DeployOptions): string {
        if (target === 'vercel') return `Would deploy to Vercel${options.production ? ' production' : ' preview'}`;
        if (target === 'firebase') return `Would run Firebase deploy${options.target ? ` for ${options.target}` : ''}`;
        if (target === 'docker') return `Would build and push Docker image ${options.tag ?? 'latest'}`;
        return 'Would deploy to Fly.io';
    }
}
