import { spawnSync } from 'child_process';
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

interface CommandResult {
    ok: boolean;
    stdout: string;
    stderr: string;
    status: number;
}

export class GitManager {
    constructor(private rootDir: string) {}

    private run(args: string[], silent = false): CommandResult {
        const result = spawnSync('git', args, {
            cwd: this.rootDir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
            windowsHide: true,
        });
        const status = result.status ?? -1;
        const stdout = typeof result.stdout === 'string' ? result.stdout : '';
        const stderr = typeof result.stderr === 'string' ? result.stderr : String(result.error ?? '');
        if (status !== 0 && !silent) logger.debug('git command failed', { args, status, stderr: stderr.slice(0, 1000) });
        return { ok: status === 0, stdout: stdout.trim(), stderr: stderr.trim(), status };
    }

    isGitRepo(): boolean {
        return this.run(['rev-parse', '--is-inside-work-tree'], true).stdout === 'true';
    }

    status(): GitStatus {
        const branch = this.run(['rev-parse', '--abbrev-ref', 'HEAD'], true).stdout || 'unknown';
        const porcelain = this.run(['status', '--porcelain=v1', '-z'], true).stdout;
        const staged: string[] = [];
        const unstaged: string[] = [];
        const untracked: string[] = [];

        const records = porcelain.split('\0').filter(Boolean);
        for (let i = 0; i < records.length; i++) {
            const line = records[i]!;
            const x = line[0] ?? ' ';
            const y = line[1] ?? ' ';
            let file = line.slice(3);
            if ((x === 'R' || x === 'C') && records[i + 1]) {
                file = `${file} -> ${records[++i]}`;
            }
            if (x !== ' ' && x !== '?') staged.push(file);
            if (y !== ' ' && y !== '?') unstaged.push(file);
            if (x === '?' && y === '?') untracked.push(file);
        }

        let ahead = 0;
        let behind = 0;
        const counts = this.run(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], true).stdout;
        if (counts) {
            const parts = counts.split(/\s+/);
            ahead = Number.parseInt(parts[0] ?? '0', 10) || 0;
            behind = Number.parseInt(parts[1] ?? '0', 10) || 0;
        }
        return { branch, staged, unstaged, untracked, ahead, behind };
    }

    diff(staged = false, filePath?: string): GitDiffResult {
        const args = ['diff'];
        if (staged) args.push('--staged');
        args.push('--no-ext-diff', '--');
        if (filePath) args.push(filePath);
        const raw = this.run(args, true).stdout;

        let additions = 0;
        let deletions = 0;
        const files = new Set<string>();
        for (const line of raw.split('\n')) {
            if (line.startsWith('+') && !line.startsWith('+++')) additions++;
            if (line.startsWith('-') && !line.startsWith('---')) deletions++;
            if (line.startsWith('+++ b/') || line.startsWith('--- a/')) files.add(line.slice(6));
        }
        return { raw, additions, deletions, files: [...files] };
    }

    add(files: string[]): boolean {
        const args = files.length === 0 ? ['add', '-A'] : ['add', '--', ...files];
        return this.run(args).ok;
    }

    commit(message: string): boolean {
        if (!message.trim()) return false;
        return this.run(['commit', '-m', message]).ok;
    }

    push(remote = 'origin', branch?: string): boolean {
        const currentBranch = branch ?? this.branch();
        if (!remote.trim() || !currentBranch.trim()) return false;
        return this.run(['push', '--', remote, currentBranch]).ok;
    }

    log(n = 10): GitCommit[] {
        const count = Math.min(1000, Math.max(1, Number.isFinite(n) ? Math.floor(n) : 10));
        const raw = this.run(['log', `-${count}`, '--pretty=format:%H%x1f%an%x1f%ai%x1f%s'], true).stdout;
        return raw.split('\n').filter(Boolean).map(line => {
            const [hash, author, date, ...message] = line.split('\x1f');
            return {
                hash: (hash ?? '').slice(0, 8),
                author: author ?? 'unknown',
                date: (date ?? '').slice(0, 10),
                message: message.join('\x1f'),
            };
        });
    }

    branch(): string {
        return this.run(['rev-parse', '--abbrev-ref', 'HEAD'], true).stdout || 'unknown';
    }

    createPR(title: string, body: string): boolean {
        if (!title.trim()) return false;
        const result = spawnSync('gh', ['pr', 'create', '--title', title, '--body', body], {
            cwd: this.rootDir,
            encoding: 'utf8',
            shell: false,
            windowsHide: true,
        });
        if (result.status !== 0) {
            logger.error('gh pr create failed', { stderr: result.stderr });
            return false;
        }
        logger.info('PR created', { stdout: result.stdout });
        return true;
    }

    stash(message?: string): boolean {
        const args = message ? ['stash', 'push', '-m', message] : ['stash', 'push'];
        return this.run(args).ok;
    }

    hasUncommittedChanges(): boolean {
        return this.run(['status', '--porcelain=v1'], true).stdout.length > 0;
    }
}
