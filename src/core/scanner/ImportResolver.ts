/**
 * ImportResolver — Production-grade module resolution engine.
 *
 * Replaces the broken resolveImportPath() in FileAnalyzer which only handled
 * relative paths. This engine handles the full Node.js + TypeScript resolution
 * algorithm that any real enterprise codebase actually uses:
 *
 *   1. Relative paths  (./foo, ../bar)
 *   2. tsconfig paths  (@/components → src/components)
 *   3. package.json exports map (workspace packages)
 *   4. Barrel index files  (import from 'src/utils' → src/utils/index.ts)
 *   5. Extension probing   (.js → .ts, .jsx → .tsx, etc.)
 *
 * The resolver is constructed ONCE per scan and caches all tsconfig/package
 * lookups. O(1) alias resolution after initial parse.
 */

import fs from 'fs';
import path from 'path';
import { normalizePath } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';

/** A single path alias mapping: prefix → one or more base directories */
interface PathAlias {
    prefix: string;       // e.g. "@/"
    stripWildcard: string; // e.g. "@"  (prefix without the trailing *)
    targets: string[];    // absolute base dirs e.g. "/project/src"
}

/** Candidate file extensions probed in order */
const PROBE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

/** Index file names probed when a directory is imported */
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mts', 'index.mjs'];

export class ImportResolver {
    private aliases: PathAlias[] = [];
    /** Map: package name → absolute entry file (for workspace packages) */
    private workspacePackages: Map<string, string> = new Map();

    constructor(private rootDir: string) {
        this.parseTsConfig();
        this.parseWorkspacePackages();
    }

    // ─── Public API ────────────────────────────────────────────────────────────

    /**
     * Resolve an import source string to an absolute file path.
     * Returns null for unresolvable imports (external node_modules).
     */
    resolve(importSource: string, fromFile: string): string | null {
        // Skip pure node built-ins and obviously external packages that have
        // no workspace or alias mapping.
        if (this.isBuiltin(importSource)) return null;

        // 1. Relative import  →  straightforward probe
        if (importSource.startsWith('.')) {
            return this.probeFromDir(path.dirname(fromFile), importSource);
        }

        // 2. Alias import (e.g. @/components/Button)
        const aliasResolved = this.resolveAlias(importSource);
        if (aliasResolved) return aliasResolved;

        // 3. Workspace package import (monorepo sibling)
        const workspaceResolved = this.workspacePackages.get(importSource);
        if (workspaceResolved) return workspaceResolved;

        // 4. Could not resolve → external node_modules (ignore for graph purposes)
        return null;
    }

    // ─── tsconfig.json parsing ─────────────────────────────────────────────────

    private parseTsConfig(): void {
        // Support both standard tsconfig.json and project-level tsconfig.app.json
        const candidates = [
            path.join(this.rootDir, 'tsconfig.json'),
            path.join(this.rootDir, 'tsconfig.app.json'),
            path.join(this.rootDir, 'tsconfig.base.json'),
        ];

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                try {
                    const raw = fs.readFileSync(candidate, 'utf8');
                    // Strip JSON comments (tsconfig allows them)
                    const clean = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
                    const tsConfig = JSON.parse(clean);
                    this.extractAliasesFromConfig(tsConfig, path.dirname(candidate));

                    // Follow "extends" chain up to 3 levels deep
                    if (tsConfig.extends) {
                        this.followExtends(tsConfig.extends, path.dirname(candidate), 3);
                    }
                    break; // Use first found
                } catch (err) {
                    logger.debug('ImportResolver: Failed to parse tsconfig', {
                        path: candidate,
                        error: String(err),
                    });
                }
            }
        }
    }

    private followExtends(extendsPath: string, fromDir: string, depth: number): void {
        if (depth <= 0) return;
        try {
            const resolved = extendsPath.startsWith('.')
                ? path.resolve(fromDir, extendsPath)
                : require.resolve(extendsPath, { paths: [fromDir] });

            const finalPath = resolved.endsWith('.json') ? resolved : `${resolved}.json`;
            if (!fs.existsSync(finalPath)) return;

            const raw = fs.readFileSync(finalPath, 'utf8');
            const clean = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
            const extended = JSON.parse(clean);
            this.extractAliasesFromConfig(extended, path.dirname(finalPath));

            if (extended.extends) {
                this.followExtends(extended.extends, path.dirname(finalPath), depth - 1);
            }
        } catch {
            // Silently ignore unresolvable extends — common with @tsconfig/node18 etc.
        }
    }

    private extractAliasesFromConfig(tsConfig: any, configDir: string): void {
        const co = tsConfig?.compilerOptions;
        if (!co) return;

        // baseUrl determines the resolution root for non-relative imports
        const baseUrl = co.baseUrl ? path.resolve(configDir, co.baseUrl) : null;

        // Parse "paths" mappings
        if (co.paths && typeof co.paths === 'object') {
            for (const [key, rawTargets] of Object.entries(co.paths)) {
                const targets = rawTargets as string[];
                const baseForTargets = baseUrl ?? configDir;
                const resolvedTargets = targets.map((t: string) => {
                    // Remove trailing /* from target
                    const clean = t.endsWith('/*') ? t.slice(0, -2) : t;
                    return path.resolve(baseForTargets, clean);
                });

                // Build prefix: if key is "@/*" → stripWildcard is "@"
                const stripWildcard = key.endsWith('/*') ? key.slice(0, -2) : key;
                // Avoid duplicate aliases
                if (!this.aliases.some(a => a.prefix === key)) {
                    this.aliases.push({ prefix: key, stripWildcard, targets: resolvedTargets });
                }
            }
        }

        // If baseUrl is set without paths, any non-relative import resolves from baseUrl
        if (baseUrl && !co.paths) {
            // We represent this as an alias with empty prefix that matches everything
            if (!this.aliases.some(a => a.prefix === '')) {
                this.aliases.push({ prefix: '', stripWildcard: '', targets: [baseUrl] });
            }
        }
    }

    // ─── Workspace package discovery ──────────────────────────────────────────

    private parseWorkspacePackages(): void {
        const rootPkg = path.join(this.rootDir, 'package.json');
        if (!fs.existsSync(rootPkg)) return;

        try {
            const pkg = JSON.parse(fs.readFileSync(rootPkg, 'utf8'));

            // Yarn/npm workspaces
            const workspaceGlobs: string[] = pkg.workspaces
                ? Array.isArray(pkg.workspaces)
                    ? pkg.workspaces
                    : pkg.workspaces.packages ?? []
                : [];

            // pnpm workspaces
            const pnpmWorkspace = path.join(this.rootDir, 'pnpm-workspace.yaml');
            if (fs.existsSync(pnpmWorkspace)) {
                const content = fs.readFileSync(pnpmWorkspace, 'utf8');
                const matches = content.match(/^\s*-\s*['"]?(.+?)['"]?\s*$/gm) ?? [];
                for (const m of matches) {
                    const trimmed = m.replace(/^\s*-\s*['"]?/, '').replace(/['"]?\s*$/, '');
                    workspaceGlobs.push(trimmed);
                }
            }

            for (const glob of workspaceGlobs) {
                this.discoverPackagesFromGlob(glob);
            }
        } catch (err) {
            logger.debug('ImportResolver: Failed to parse workspace packages', { error: String(err) });
        }
    }

    private discoverPackagesFromGlob(globPattern: string): void {
        // Expand simple globs like "packages/*" or "apps/*"
        // We only support one level of wildcard — full glob expansion would add a dependency
        const parts = globPattern.split('/');
        const hasWildcard = parts.some(p => p === '*' || p === '**');

        if (!hasWildcard) {
            this.registerPackageDir(path.resolve(this.rootDir, globPattern));
            return;
        }

        const wildcardIndex = parts.indexOf('*') !== -1
            ? parts.indexOf('*')
            : parts.indexOf('**');

        const baseDir = path.resolve(this.rootDir, parts.slice(0, wildcardIndex).join('/'));
        if (!fs.existsSync(baseDir)) return;

        try {
            const entries = fs.readdirSync(baseDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    this.registerPackageDir(path.join(baseDir, entry.name));
                }
            }
        } catch {
            // Directory might not exist or be readable
        }
    }

    private registerPackageDir(dirPath: string): void {
        const pkgJson = path.join(dirPath, 'package.json');
        if (!fs.existsSync(pkgJson)) return;

        try {
            const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
            if (!pkg.name) return;

            // Resolve the entry point — respect "exports" field, then "main", then index
            let entryFile = this.resolvePackageEntry(pkg, dirPath);
            if (entryFile) {
                this.workspacePackages.set(pkg.name, normalizePath(entryFile));
                logger.debug('ImportResolver: Registered workspace package', {
                    name: pkg.name,
                    entry: entryFile,
                });
            }
        } catch {
            // Malformed package.json — skip
        }
    }

    private resolvePackageEntry(pkg: any, pkgDir: string): string | null {
        // Priority: exports > main > index probe
        if (pkg.exports) {
            const exportsEntry = this.resolveExportsField(pkg.exports, pkgDir);
            if (exportsEntry) return exportsEntry;
        }

        if (pkg.main) {
            const mainPath = path.resolve(pkgDir, pkg.main);
            const probed = this.probeExtensions(mainPath);
            if (probed) return probed;
        }

        // Fall back to index file probe
        for (const idx of INDEX_FILES) {
            const candidate = path.join(pkgDir, idx);
            if (fs.existsSync(candidate)) return candidate;
        }

        return null;
    }

    private resolveExportsField(exports: any, pkgDir: string): string | null {
        if (!exports) return null;

        // String shorthand: "exports": "./index.js"
        if (typeof exports === 'string') {
            const p = path.resolve(pkgDir, exports);
            return this.probeExtensions(p);
        }

        // Object: find the "." entry or "import"/"require" condition
        if (typeof exports === 'object' && !Array.isArray(exports)) {
            const dotEntry = exports['.'] ?? exports['import'] ?? exports['require'] ?? exports['default'];
            if (dotEntry) return this.resolveExportsField(dotEntry, pkgDir);
        }

        return null;
    }

    // ─── Alias resolution ─────────────────────────────────────────────────────

    private resolveAlias(importSource: string): string | null {
        // Sort by most specific match (longer prefix wins)
        const sorted = [...this.aliases].sort((a, b) => b.stripWildcard.length - a.stripWildcard.length);

        for (const alias of sorted) {
            if (alias.prefix === '') {
                // baseUrl only alias — importSource must look like a file path (no @, no :)
                if (importSource.includes(':') || importSource.startsWith('@')) continue;
                for (const target of alias.targets) {
                    const candidate = path.join(target, importSource);
                    const probed = this.probeAll(candidate);
                    if (probed) return probed;
                }
                continue;
            }

            if (importSource.startsWith(alias.stripWildcard)) {
                const suffix = importSource.slice(alias.stripWildcard.length);
                // Remove leading slash from suffix
                const cleanSuffix = suffix.startsWith('/') ? suffix.slice(1) : suffix;

                for (const target of alias.targets) {
                    const candidate = cleanSuffix ? path.join(target, cleanSuffix) : target;
                    const probed = this.probeAll(candidate);
                    if (probed) return probed;
                }
            }
        }

        return null;
    }

    // ─── File probing ─────────────────────────────────────────────────────────

    /** Resolves a path relative to a directory (for relative imports) */
    private probeFromDir(fromDir: string, importSource: string): string | null {
        // Handle ESM compatibility: .js in import source pointing to .ts file
        let cleanSource = importSource;
        const jsExtMatch = importSource.match(/\.(js|jsx|mjs|cjs)$/);
        if (jsExtMatch) {
            // Strip the .js extension — we'll probe for .ts
            cleanSource = importSource.slice(0, -jsExtMatch[0].length);
        }

        const candidate = path.resolve(fromDir, cleanSource);
        return this.probeAll(candidate);
    }

    /**
     * Given an absolute base path (no extension), probe all possible extensions
     * and then index files. Returns normalized path or null.
     */
    private probeAll(basePath: string): string | null {
        // 1. Exact match (file already has extension)
        if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
            return normalizePath(basePath);
        }

        // 2. Extension probing
        const withExt = this.probeExtensions(basePath);
        if (withExt) return withExt;

        // 3. Directory / barrel index
        if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
            for (const idx of INDEX_FILES) {
                const idxPath = path.join(basePath, idx);
                if (fs.existsSync(idxPath)) return normalizePath(idxPath);
            }
        }

        return null;
    }

    private probeExtensions(basePath: string): string | null {
        for (const ext of PROBE_EXTENSIONS) {
            const candidate = `${basePath}${ext}`;
            if (fs.existsSync(candidate)) return normalizePath(candidate);
        }
        return null;
    }

    // ─── Utility ──────────────────────────────────────────────────────────────

    private isBuiltin(source: string): boolean {
        // Node built-ins: 'fs', 'path', 'node:fs', etc.
        if (source.startsWith('node:')) return true;
        const builtins = new Set([
            'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'stream',
            'events', 'util', 'url', 'assert', 'buffer', 'child_process',
            'cluster', 'dgram', 'dns', 'domain', 'module', 'perf_hooks',
            'process', 'punycode', 'querystring', 'readline', 'repl',
            'string_decoder', 'timers', 'tls', 'trace_events', 'tty', 'v8',
            'vm', 'worker_threads', 'zlib', 'inspector',
        ]);
        return builtins.has(source.split('/')[0] ?? '');
    }
}
