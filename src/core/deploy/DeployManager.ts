import { spawn, SpawnOptionsWithoutStdio } from 'child_process';
import path from 'path';
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

export class DeployManager {
    constructor(private rootDir: string) {}

    private async runStreaming(
        command: string,
        args: string[],
        onLine: (line: string) => void
    ): Promise<{ exitCode: number; output: string }> {
        return new Promise((resolve) => {
            const output: string[] = [];
            const opts: SpawnOptionsWithoutStdio = { cwd: this.rootDir, shell: true };
            const proc = spawn(command, args, opts);

            proc.stdout.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                output.push(text);
                for (const line of text.split('\n').filter(Boolean)) onLine(line);
            });

            proc.stderr.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                output.push(text);
                for (const line of text.split('\n').filter(Boolean)) onLine(line);
            });

            proc.on('close', (code) => {
                resolve({ exitCode: code ?? 1, output: output.join('') });
            });
        });
    }

    async deploy(target: DeployTarget, options: DeployOptions, onLine: (line: string) => void): Promise<DeployResult> {
        if (options.dryRun) {
            onLine(`[DRY RUN] Would deploy to ${target}`);
            return { success: true, output: '[DRY RUN] No changes made.' };
        }

        switch (target) {
            case 'vercel': return this.deployVercel(options, onLine);
            case 'firebase': return this.deployFirebase(options, onLine);
            case 'fly': return this.deployFly(onLine);
            case 'docker': return this.deployDocker(options, onLine);
            default: return { success: false, output: '', error: `Unknown deploy target: ${target}` };
        }
    }

    private async deployVercel(options: DeployOptions, onLine: (line: string) => void): Promise<DeployResult> {
        const args = options.production ? ['--prod'] : [];
        const { exitCode, output } = await this.runStreaming('vercel', args, onLine);

        // Try to extract the deployed URL from output
        const urlMatch = output.match(/https:\/\/[\w.-]+\.vercel\.app/);
        return {
            success: exitCode === 0,
            output,
            url: urlMatch?.[0],
            error: exitCode !== 0 ? 'Vercel deployment failed' : undefined,
        };
    }

    private async deployFirebase(options: DeployOptions, onLine: (line: string) => void): Promise<DeployResult> {
        const args: string[] = ['deploy'];
        if (options.target) args.push('--only', options.target);
        const { exitCode, output } = await this.runStreaming('firebase', args, onLine);
        return { success: exitCode === 0, output, error: exitCode !== 0 ? 'Firebase deployment failed' : undefined };
    }

    private async deployFly(onLine: (line: string) => void): Promise<DeployResult> {
        const { exitCode, output } = await this.runStreaming('flyctl', ['deploy'], onLine);
        return { success: exitCode === 0, output, error: exitCode !== 0 ? 'Fly.io deployment failed' : undefined };
    }

    private async deployDocker(options: DeployOptions, onLine: (line: string) => void): Promise<DeployResult> {
        const tag = options.tag ?? 'latest';
        const { exitCode: buildCode, output: buildOut } = await this.runStreaming('docker', ['build', '-t', tag, '.'], onLine);
        if (buildCode !== 0) return { success: false, output: buildOut, error: 'Docker build failed' };

        const { exitCode: pushCode, output: pushOut } = await this.runStreaming('docker', ['push', tag], onLine);
        return {
            success: pushCode === 0,
            output: buildOut + pushOut,
            error: pushCode !== 0 ? 'Docker push failed' : undefined,
        };
    }
}
