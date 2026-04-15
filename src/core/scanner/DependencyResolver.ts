import path from 'path';
import fs from 'fs';
import { logger } from '../../utils/logger.js';

export interface PackageDependency {
    name: string;
    version: string;
    resolvedVersion?: string;
    isDev: boolean;
    isPeer: boolean;
}

export interface DependencyTree {
    root: string;
    dependencies: PackageDependency[];
    devDependencies: PackageDependency[];
    peerDependencies: PackageDependency[];
    missing: string[];
    conflicts: Array<{ name: string; required: string; installed: string }>;
}

export class DependencyResolver {
    constructor(private rootDir: string) { }

    resolveDependencyTree(): DependencyTree {
        const packageJsonPath = path.join(this.rootDir, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            return { root: this.rootDir, dependencies: [], devDependencies: [], peerDependencies: [], missing: [], conflicts: [] };
        }

        let packageJson: Record<string, unknown>;
        try {
            packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
        } catch {
            return { root: this.rootDir, dependencies: [], devDependencies: [], peerDependencies: [], missing: [], conflicts: [] };
        }

        const deps = (packageJson['dependencies'] as Record<string, string> | undefined) ?? {};
        const devDeps = (packageJson['devDependencies'] as Record<string, string> | undefined) ?? {};
        const peerDeps = (packageJson['peerDependencies'] as Record<string, string> | undefined) ?? {};

        const missing: string[] = [];
        const conflicts: DependencyTree['conflicts'] = [];

        const resolveDep = (name: string, versionRange: string, isDev: boolean, isPeer: boolean): PackageDependency => {
            const installedVersion = this.getInstalledVersion(name);
            if (!installedVersion) {
                missing.push(name);
            }
            return { name, version: versionRange, resolvedVersion: installedVersion ?? undefined, isDev, isPeer };
        };

        const dependencies = Object.entries(deps).map(([n, v]) => resolveDep(n, v, false, false));
        const devDependencies = Object.entries(devDeps).map(([n, v]) => resolveDep(n, v, true, false));
        const peerDependencies = Object.entries(peerDeps).map(([n, v]) => resolveDep(n, v, false, true));

        return { root: this.rootDir, dependencies, devDependencies, peerDependencies, missing, conflicts };
    }

    private getInstalledVersion(packageName: string): string | null {
        const candidates = [
            path.join(this.rootDir, 'node_modules', packageName, 'package.json'),
        ];

        // Handle scoped packages like @org/pkg
        if (packageName.startsWith('@')) {
            const [scope, name] = packageName.slice(1).split('/');
            if (scope && name) {
                candidates.push(path.join(this.rootDir, 'node_modules', `@${scope}`, name, 'package.json'));
            }
        }

        for (const pkgPath of candidates) {
            if (!fs.existsSync(pkgPath)) continue;
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
                return pkg.version ?? null;
            } catch {
                continue;
            }
        }
        return null;
    }

    getPythonDependencies(): Array<{ name: string; version: string }> {
        const candidates = [
            path.join(this.rootDir, 'requirements.txt'),
            path.join(this.rootDir, 'requirements-prod.txt'),
            path.join(this.rootDir, 'Pipfile'),
        ];

        for (const candidate of candidates) {
            if (!fs.existsSync(candidate)) continue;
            const content = fs.readFileSync(candidate, 'utf8');
            return content
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'))
                .map(line => {
                    const match = line.match(/^([a-zA-Z0-9_-]+)([>=<~!]+.+)?$/);
                    return match ? { name: match[1]!, version: match[2]?.trim() ?? '*' } : null;
                })
                .filter(Boolean) as Array<{ name: string; version: string }>;
        }

        return [];
    }

    getGoDependencies(): Array<{ name: string; version: string }> {
        const goModPath = path.join(this.rootDir, 'go.mod');
        if (!fs.existsSync(goModPath)) return [];

        const content = fs.readFileSync(goModPath, 'utf8');
        const requireBlock = content.match(/require\s*\(([\s\S]*?)\)/)?.[1] ?? '';

        return requireBlock
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('//'))
            .map(line => {
                const parts = line.split(/\s+/);
                return parts.length >= 2 ? { name: parts[0]!, version: parts[1]! } : null;
            })
            .filter(Boolean) as Array<{ name: string; version: string }>;
    }
}