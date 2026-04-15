import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import which from 'which';
import type { ProjectConfig } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

export class DependencyManager {
    private packageManager: PackageManager | null = null;

    constructor(private rootDir: string) { }

    async detectPackageManager(): Promise<PackageManager> {
        if (this.packageManager) return this.packageManager;

        if (fs.existsSync(path.join(this.rootDir, 'bun.lockb'))) {
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

    async install(missingPackages?: string[]): Promise<{ success: boolean; output: string; error?: string }> {
        const pm = await this.detectPackageManager();
        const available = await this.isPackageManagerAvailable(pm);

        if (!available) {
            return { success: false, output: '', error: `Package manager '${pm}' not found in PATH` };
        }

        let command: string;
        if (missingPackages && missingPackages.length > 0) {
            const pkgList = missingPackages.join(' ');
            switch (pm) {
                case 'npm': command = `npm install ${pkgList}`; break;
                case 'yarn': command = `yarn add ${pkgList}`; break;
                case 'pnpm': command = `pnpm add ${pkgList}`; break;
                case 'bun': command = `bun add ${pkgList}`; break;
            }
        } else {
            switch (pm) {
                case 'npm': command = 'npm install'; break;
                case 'yarn': command = 'yarn install'; break;
                case 'pnpm': command = 'pnpm install'; break;
                case 'bun': command = 'bun install'; break;
            }
        }

        return new Promise(resolve => {
            logger.info(`Running: ${command}`);
            const proc = spawn(command, { shell: true, cwd: this.rootDir });
            const output: string[] = [];
            const errOutput: string[] = [];

            proc.stdout?.on('data', (d: Buffer) => output.push(d.toString()));
            proc.stderr?.on('data', (d: Buffer) => errOutput.push(d.toString()));

            proc.on('close', code => {
                if (code === 0) {
                    resolve({ success: true, output: output.join('') });
                } else {
                    resolve({ success: false, output: output.join(''), error: errOutput.join('') });
                }
            });
        });
    }

    async installPythonDeps(): Promise<{ success: boolean; output: string; error?: string }> {
        const reqPath = path.join(this.rootDir, 'requirements.txt');
        if (!fs.existsSync(reqPath)) {
            return { success: true, output: 'No requirements.txt found' };
        }

        try {
            const { stdout, stderr } = await execAsync('pip install -r requirements.txt', {
                cwd: this.rootDir,
                timeout: 120000,
            });
            return { success: true, output: stdout };
        } catch (err) {
            return { success: false, output: '', error: String(err) };
        }
    }

    async getOutdatedPackages(): Promise<Array<{ name: string; current: string; latest: string }>> {
        const pm = await this.detectPackageManager();
        try {
            const { stdout } = await execAsync(
                pm === 'npm' ? 'npm outdated --json' : `${pm} outdated --json`,
                { cwd: this.rootDir, timeout: 30000 }
            );
            const parsed = JSON.parse(stdout) as Record<string, { current: string; latest: string }>;
            return Object.entries(parsed).map(([name, info]) => ({
                name,
                current: info.current,
                latest: info.latest,
            }));
        } catch {
            return [];
        }
    }
}