import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const FALLBACK_IGNORES = new Set(['.git', '.cos', 'node_modules', 'dist']);

export class WorkspaceFingerprint {
    static capture(rootDir: string): string {
        const root = path.resolve(rootDir);
        const hash = crypto.createHash('sha256');
        hash.update('codebase-os-workspace-v1\0');

        const git = this.gitSnapshot(root);
        if (git) {
            hash.update('git\0');
            hash.update(git.head);
            hash.update('\0');
            hash.update(git.status);
            hash.update('\0');
            for (const relativePath of git.paths) this.hashPath(hash, root, relativePath);
            return hash.digest('hex');
        }

        hash.update('filesystem\0');
        for (const relativePath of this.walk(root)) this.hashPath(hash, root, relativePath);
        return hash.digest('hex');
    }

    private static gitSnapshot(root: string): { head: string; status: string; paths: string[] } | null {
        try {
            const head = execFileSync('git', ['rev-parse', 'HEAD'], {
                cwd: root,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
            const statusBuffer = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
                cwd: root,
                encoding: 'buffer',
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            const status = statusBuffer.toString('utf8');
            const records = status.split('\0').filter(Boolean);
            const paths: string[] = [];
            for (const record of records) {
                const candidate = /^[ MADRCU?!]{2} /.test(record) ? record.slice(3) : record;
                if (candidate) paths.push(candidate);
            }
            return { head, status, paths: [...new Set(paths)].sort() };
        } catch {
            return null;
        }
    }

    private static walk(root: string): string[] {
        const files: string[] = [];
        const visit = (directory: string): void => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                if (FALLBACK_IGNORES.has(entry.name)) continue;
                const absolute = path.join(directory, entry.name);
                const relative = path.relative(root, absolute).replace(/\\/g, '/');
                if (entry.isSymbolicLink() || entry.isFile()) files.push(relative);
                else if (entry.isDirectory()) visit(absolute);
            }
        };
        visit(root);
        return files.sort();
    }

    private static hashPath(hash: crypto.Hash, root: string, relativePath: string): void {
        const normalized = relativePath.replace(/\\/g, '/');
        const absolute = path.resolve(root, normalized);
        const relative = path.relative(root, absolute);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            hash.update(`outside\0${normalized}\0`);
            return;
        }

        hash.update(`path\0${normalized}\0`);
        try {
            const stat = fs.lstatSync(absolute);
            if (stat.isSymbolicLink()) {
                hash.update('symlink\0');
                hash.update(fs.readlinkSync(absolute));
            } else if (stat.isFile()) {
                hash.update('file\0');
                hash.update(fs.readFileSync(absolute));
            } else {
                hash.update(`other:${stat.mode}\0`);
            }
        } catch (error: any) {
            if (error?.code === 'ENOENT') hash.update('missing\0');
            else throw error;
        }
        hash.update('\0');
    }
}
