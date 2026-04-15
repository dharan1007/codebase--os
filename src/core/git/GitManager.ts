import { execSync, spawnSync } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger.js';

export interface GitStatus {
    branch: string;
    staged: string[];
    unstaged: string[];
    untracked: string[];
    ahead: number;
    behind: number;
}

export interface GitCommit {
    hash: string;
    author: string;
    date: string;
    message: string;
}

export interface GitDiffResult {
    raw: string;
    additions: number;
    deletions: number;
    files: string[];
}

export class GitManager {
    constructor(private rootDir: string) {}

    private exec(cmd: string, silent = false): string {
        try {
            return execSync(cmd, {
                cwd: this.rootDir,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
        } catch (err: any) {
            if (!silent) {
                logger.debug('git command failed', { cmd, error: String(err) });
            }
            return '';
        }
    }

    isGitRepo(): boolean {
        const result = this.exec('git rev-parse --is-inside-work-tree', true);
        return result === 'true';
    }

    status(): GitStatus {
        const branch = this.exec('git rev-parse --abbrev-ref HEAD') || 'unknown';

        const porcelain = this.exec('git status --porcelain');
        const staged: string[] = [];
        const unstaged: string[] = [];
        const untracked: string[] = [];

        for (const line of porcelain.split('\n').filter(Boolean)) {
            const x = line[0] ?? ' ';
            const y = line[1] ?? ' ';
            const file = line.slice(3).trim();

            if (x !== ' ' && x !== '?') staged.push(file);
            if (y === 'M' || y === 'D') unstaged.push(file);
            if (x === '?' && y === '?') untracked.push(file);
        }

        let ahead = 0;
        let behind = 0;
        const aheadBehind = this.exec('git rev-list --left-right --count HEAD...@{upstream}', true);
        if (aheadBehind) {
            const parts = aheadBehind.split('\t');
            ahead = parseInt(parts[0] ?? '0', 10) || 0;
            behind = parseInt(parts[1] ?? '0', 10) || 0;
        }

        return { branch, staged, unstaged, untracked, ahead, behind };
    }

    diff(staged = false, filePath?: string): GitDiffResult {
        const flags = staged ? '--staged' : '';
        const target = filePath ? `-- "${filePath}"` : '';
        const raw = this.exec(`git diff ${flags} ${target}`);

        let additions = 0;
        let deletions = 0;
        const files = new Set<string>();

        for (const line of raw.split('\n')) {
            if (line.startsWith('+') && !line.startsWith('+++')) additions++;
            if (line.startsWith('-') && !line.startsWith('---')) deletions++;
            if (line.startsWith('+++ b/') || line.startsWith('--- a/')) {
                files.add(line.slice(6));
            }
        }

        return { raw, additions, deletions, files: Array.from(files) };
    }

    add(files: string[]): boolean {
        if (files.length === 0) {
            this.exec('git add -A');
        } else {
            const escaped = files.map(f => `"${f}"`).join(' ');
            this.exec(`git add ${escaped}`);
        }
        return true;
    }

    commit(message: string): boolean {
        const result = spawnSync('git', ['commit', '-m', message], {
            cwd: this.rootDir,
            encoding: 'utf8',
        });
        if (result.status !== 0) {
            logger.error('git commit failed', { stderr: result.stderr });
            return false;
        }
        return true;
    }

    push(remote = 'origin', branch?: string): boolean {
        const currentBranch = branch ?? this.exec('git rev-parse --abbrev-ref HEAD');
        const result = spawnSync('git', ['push', remote, currentBranch], {
            cwd: this.rootDir,
            encoding: 'utf8',
        });
        if (result.status !== 0) {
            logger.error('git push failed', { stderr: result.stderr });
            return false;
        }
        return true;
    }

    log(n = 10): GitCommit[] {
        const raw = this.exec(`git log -${n} --pretty=format:"%H|%an|%ai|%s"`);
        return raw
            .split('\n')
            .filter(Boolean)
            .map(line => {
                const [hash, author, date, ...msgParts] = line.replace(/"/g, '').split('|');
                return {
                    hash: (hash ?? '').slice(0, 8),
                    author: author ?? 'unknown',
                    date: (date ?? '').slice(0, 10),
                    message: msgParts.join('|'),
                };
            });
    }

    branch(): string {
        return this.exec('git rev-parse --abbrev-ref HEAD') || 'unknown';
    }

    createPR(title: string, body: string): boolean {
        const result = spawnSync('gh', ['pr', 'create', '--title', title, '--body', body], {
            cwd: this.rootDir,
            encoding: 'utf8',
        });
        if (result.status !== 0) {
            logger.error('gh pr create failed', { stderr: result.stderr });
            return false;
        }
        logger.info('PR created', { stdout: result.stdout });
        return true;
    }

    stash(message?: string): boolean {
        const args = message ? ['stash', 'push', '-m', message] : ['stash'];
        const result = spawnSync('git', args, { cwd: this.rootDir, encoding: 'utf8' });
        return result.status === 0;
    }

    hasUncommittedChanges(): boolean {
        const output = this.exec('git status --porcelain');
        return output.trim().length > 0;
    }
}
