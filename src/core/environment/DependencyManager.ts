import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import which from 'which';
import { logger } from '../../utils/logger.js';

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

export interface DependencyStatus {
    success: boolean;
    packageManager: PackageManager;
    packageManagerAvailable: boolean;
    manifestPresent: boolean;
    installPresent: boolean;
    missing: string[];
    error?: string;
}

interface ProcessResult {
    success: boolean;
    output: string;
    error?: string;
}

export class DependencyManager {
    private packageManager: PackageManager | null = null;

    constructor(private rootDir: string) {}

    async detectPackageManager(): Promise<PackageManager> {
        if (this.packageManager) return this.packageManager;
        if (fs.existsSync(path.join(this.rootDir, 'bun.lockb')) || fs.existsSync(path.join(this.rootDir, 'bun.lock'))) {
            this.packageManager = 'bun';
        } else if (fs.existsSync(path.join(this.rootDir, 'pnpm-lock.yaml'))) {
            this.packageManager = 'pnpm';
        } else if (fs.existsSync(path.join(this.rootDir, 'yarn.lock'))) {
            this.packageManager = 'yarn';
        } else {
            this.packageManager = 'npm';
        }
        logger.debug('Detected package manager', { pm: this.packageManager });
        return this.packageManager;
    }

    async isPackageManagerAvailable(pm: PackageManager): Promise<boolean> {
        try {
            await which(pm);
            return true;
        } catch {
            return false;
        }
    }

    /** Read-only dependency health check. Never installs or modifies a lockfile. */
    async check(): Promise<DependencyStatus> {
        const pm = await this.detectPackageManager();
        const packageManagerAvailable = await this.isPackageManagerAvailable(pm);
        const manifestPresent = fs.existsSync(path.join(this.rootDir, 'package.json'));
        const installPresent = fs.existsSync(path.join(this.rootDir, 'node_modules'));
        const missing: string[] = [];

        if (!manifestPresent) {
            return {
                success: true,
                packageManager: pm,
                packageManagerAvailable,
                manifestPresent: false,
                installPresent: false,
                missing,
            };
        }
        if (!packageManagerAvailable) missing.push(`package manager: ${pm}`);
        if (!installPresent) missing.push('node_modules');

        return {
            success: packageManagerAvailable && installPresent,
            packageManager: pm,
            packageManagerAvailable,
            manifestPresent,
            installPresent,
            missing,
            error: missing.length > 0 ? `Dependency environment incomplete: ${missing.join(', ')}` : undefined,
        };
    }

    /** Explicit dependency mutation. Callers must opt in to this method. */
    async install(missingPackages?: string[]): Promise<ProcessResult> {
        const pm = await this.detectPackageManager();
        if (!await this.isPackageManagerAvailable(pm)) {
            return { success: false, output: '', error: `Package manager '${pm}' not found in PATH` };
        }

        let args: string[];
        if (missingPackages?.length) {
            const packages = missingPackages.filter(value => value.trim().length > 0);
            if (packages.length !== missingPackages.length) {
                return { success: false, output: '', error: 'Invalid empty package specification.' };
            }
            args = pm === 'npm' ? ['install', '--', ...packages] : ['add', ...packages];
        } else {
            // Prefer lockfile-respecting commands when they are available.
            if (pm === 'npm' && fs.existsSync(path.join(this.rootDir, 'package-lock.json'))) args = ['ci'];
            else if (pm === 'pnpm' && fs.existsSync(path.join(this.rootDir, 'pnpm-lock.yaml'))) args = ['install', '--frozen-lockfile'];
            else if (pm === 'yarn' && fs.existsSync(path.join(this.rootDir, 'yarn.lock'))) args = ['install', '--immutable'];
            else if (pm === 'bun' && (fs.existsSync(path.join(this.rootDir, 'bun.lock')) || fs.existsSync(path.join(this.rootDir, 'bun.lockb')))) args = ['install', '--frozen-lockfile'];
            else args = ['install'];
        }
        return this.run(pm, args, 10 * 60_000);
    }

    async installPythonDeps(): Promise<ProcessResult> {
        const reqPath = path.join(this.rootDir, 'requirements.txt');
        if (!fs.existsSync(reqPath)) return { success: true, output: 'No requirements.txt found' };
        const python = process.env['PYTHON'] || (process.platform === 'win32' ? 'python.exe' : 'python3');
        return this.run(python, ['-m', 'pip', 'install', '-r', 'requirements.txt'], 10 * 60_000);
    }

    async getOutdatedPackages(): Promise<Array<{ name: string; current: string; latest: string }>> {
        const pm = await this.detectPackageManager();
        if (!await this.isPackageManagerAvailable(pm)) return [];
        const result = await this.run(pm, ['outdated', '--json'], 30_000, true);
        const raw = result.output.trim();
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw) as Record<string, { current?: string; latest?: string }>;
            return Object.entries(parsed)
                .filter(([, info]) => Boolean(info.current && info.latest))
                .map(([name, info]) => ({ name, current: info.current!, latest: info.latest! }));
        } catch {
            return [];
        }
    }

    private run(command: string, args: string[], timeoutMs: number, acceptNonZero = false): Promise<ProcessResult> {
        return new Promise(resolve => {
            logger.info('Running dependency command', { command, args });
            const proc = spawn(command, args, {
                cwd: this.rootDir,
                shell: false,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                env: process.env,
            });
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            let settled = false;
            proc.stdout.on('data', (data: Buffer) => stdout.push(data));
            proc.stderr.on('data', (data: Buffer) => stderr.push(data));

            const timer = setTimeout(() => {
                if (!settled) proc.kill('SIGTERM');
            }, timeoutMs);
            timer.unref();

            proc.once('error', err => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ success: false, output: Buffer.concat(stdout).toString('utf8'), error: err.message });
            });
            proc.once('close', code => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                const output = Buffer.concat(stdout).toString('utf8');
                const error = Buffer.concat(stderr).toString('utf8');
                const ok = code === 0 || acceptNonZero;
                resolve({ success: ok, output, error: ok ? undefined : error || `Process exited with ${code}` });
            });
        });
    }
}
