import { exec } from 'child_process';
import { promisify } from 'util';
import semver from 'semver';
import path from 'path';
import fs from 'fs';
import type { RuntimeVersion } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

const execAsync = promisify(exec);

export class RuntimeVersionManager {
    async detectRequired(rootDir: string): Promise<Record<string, string>> {
        const versions: Record<string, string> = {};

        const packageJsonPath = path.join(rootDir, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
                    engines?: Record<string, string>;
                };
                if (pkg.engines?.node) versions['node'] = pkg.engines.node;
                if (pkg.engines?.npm) versions['npm'] = pkg.engines.npm;
            } catch { /* skip */ }
        }

        const nvmrcPath = path.join(rootDir, '.nvmrc');
        if (fs.existsSync(nvmrcPath)) {
            const ver = fs.readFileSync(nvmrcPath, 'utf8').trim();
            if (ver) versions['node'] = `>=${ver}`;
        }

        const nodeVersionPath = path.join(rootDir, '.node-version');
        if (fs.existsSync(nodeVersionPath)) {
            const ver = fs.readFileSync(nodeVersionPath, 'utf8').trim();
            if (ver) versions['node'] = `>=${ver}`;
        }

        const requirementsTxtPath = path.join(rootDir, 'requirements.txt');
        if (fs.existsSync(requirementsTxtPath)) {
            versions['python'] = '>=3.8';
        }

        const goModPath = path.join(rootDir, 'go.mod');
        if (fs.existsSync(goModPath)) {
            const content = fs.readFileSync(goModPath, 'utf8');
            const match = content.match(/^go\s+(\d+\.\d+)/m);
            if (match?.[1]) versions['go'] = `>=${match[1]}`;
        }

        return versions;
    }

    async checkRuntime(runtime: string, required: string): Promise<RuntimeVersion> {
        const installed = await this.getInstalledVersion(runtime);

        if (!installed) {
            return { runtime, required, installed: undefined, compatible: false, resolution: `Install ${runtime} ${required}` };
        }

        const cleanInstalled = semver.clean(installed) ?? semver.coerce(installed)?.version;
        if (!cleanInstalled) {
            return { runtime, required, installed, compatible: true };
        }

        let compatible = false;
        try {
            compatible = semver.satisfies(cleanInstalled, required);
        } catch {
            compatible = true;
        }

        const resolution = compatible
            ? undefined
            : `Switch to ${runtime} ${required}. Currently installed: ${installed}`;

        return { runtime, required, installed, compatible, resolution };
    }

    private async getInstalledVersion(runtime: string): Promise<string | null> {
        const commands: Record<string, string> = {
            node: 'node --version',
            npm: 'npm --version',
            yarn: 'yarn --version',
            python: 'python3 --version || python --version',
            python3: 'python3 --version',
            go: 'go version',
            java: 'java -version',
            ruby: 'ruby --version',
            rust: 'rustc --version',
        };

        const cmd = commands[runtime];
        if (!cmd) return null;

        try {
            const { stdout, stderr } = await execAsync(cmd);
            const output = (stdout || stderr).trim();
            const match = output.match(/(\d+\.\d+[\.\d]*)/);
            return match?.[1] ?? null;
        } catch {
            return null;
        }
    }

    async checkAll(rootDir: string): Promise<RuntimeVersion[]> {
        const required = await this.detectRequired(rootDir);
        const results: RuntimeVersion[] = [];

        for (const [runtime, version] of Object.entries(required)) {
            const result = await this.checkRuntime(runtime, version);
            results.push(result);
        }

        return results;
    }
}