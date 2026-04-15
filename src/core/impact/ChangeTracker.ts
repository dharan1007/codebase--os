import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import type { FileChange, ProjectConfig } from '../../types/index.js';
import { computeHash } from '../../utils/diff.js';
import { logger } from '../../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';

export interface TrackedChange extends FileChange {
    detectedBy: 'watcher' | 'manual' | 'git';
}

export class ChangeTracker {
    private fileHashes = new Map<string, string>();
    private pendingChanges: TrackedChange[] = [];

    constructor(private config: ProjectConfig) { }

    preloadHashes(filePaths: string[]): void {
        for (const fp of filePaths) {
            try {
                const content = fs.readFileSync(fp, 'utf8');
                this.fileHashes.set(fp, computeHash(content));
            } catch { /* skip unreadable files */ }
        }
        logger.debug('File hashes preloaded', { count: this.fileHashes.size });
    }

    recordChange(
        filePath: string,
        oldContent: string | undefined,
        newContent: string | undefined,
        detectedBy: TrackedChange['detectedBy'] = 'watcher'
    ): TrackedChange {
        const oldHash = oldContent ? computeHash(oldContent) : undefined;
        const newHash = newContent ? computeHash(newContent) : undefined;

        let changeType: FileChange['changeType'] = 'modified';
        if (!oldContent && newContent) changeType = 'added';
        if (oldContent && !newContent) changeType = 'deleted';
        if (oldHash === newHash) changeType = 'modified';

        const change: TrackedChange = {
            id: uuidv4(),
            filePath,
            changeType,
            oldContent,
            newContent,
            timestamp: Date.now(),
            detectedBy,
        };

        if (newContent && newHash) {
            this.fileHashes.set(filePath, newHash);
        } else if (!newContent) {
            this.fileHashes.delete(filePath);
        }

        this.pendingChanges.push(change);
        return change;
    }

    detectGitChanges(rootDir: string): TrackedChange[] {
        const { execSync } = require('child_process') as typeof import('child_process');
        const changes: TrackedChange[] = [];

        try {
            const output = execSync('git diff --name-status HEAD', { cwd: rootDir, encoding: 'utf8' });
            for (const line of output.trim().split('\n').filter(Boolean)) {
                const parts = line.split('\t');
                if (parts.length < 2) continue;
                const status = parts[0]!;
                const filePath = path.resolve(rootDir, parts[1]!);

                let changeType: FileChange['changeType'] = 'modified';
                if (status.startsWith('A')) changeType = 'added';
                if (status.startsWith('D')) changeType = 'deleted';
                if (status.startsWith('R')) changeType = 'renamed';
                if (status.startsWith('M')) changeType = 'modified';

                let newContent: string | undefined;
                if (changeType !== 'deleted' && fs.existsSync(filePath)) {
                    newContent = fs.readFileSync(filePath, 'utf8');
                }

                changes.push({
                    id: uuidv4(),
                    filePath,
                    changeType,
                    newContent,
                    timestamp: Date.now(),
                    detectedBy: 'git',
                });
            }
        } catch { /* not a git repo or git not available */ }

        return changes;
    }

    flushPending(): TrackedChange[] {
        const pending = [...this.pendingChanges];
        this.pendingChanges = [];
        return pending;
    }

    hasChanged(filePath: string): boolean {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const currentHash = computeHash(content);
            const storedHash = this.fileHashes.get(filePath);
            return storedHash !== currentHash;
        } catch {
            return false;
        }
    }
}