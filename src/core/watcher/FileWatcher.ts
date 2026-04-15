import chokidar, { FSWatcher } from 'chokidar';
import fs from 'fs';
import path from 'path';
import type { ProjectConfig, FileChange } from '../../types/index.js';
import { ChangeQueue } from './ChangeQueue.js';
import { logger } from '../../utils/logger.js';

export type WatcherEventHandler = (change: FileChange) => Promise<void>;

export class FileWatcher {
    private watcher: FSWatcher | null = null;
    private queue: ChangeQueue;
    private fileContents = new Map<string, string>();

    constructor(private config: ProjectConfig) {
        this.queue = new ChangeQueue(config.watch.debounceMs);
    }

    start(handler: WatcherEventHandler): void {
        if (this.watcher) {
            logger.warn('Watcher already running');
            return;
        }

        this.queue.setHandler(handler);

        const ignored = this.config.exclude.map(e => `**/${e}/**`);
        const patterns = ['**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,java,kt,kts,swift,dart,rb,php,c,h,cpp,cc,cxx,hpp,html,htm,css,scss,sass,rs,cs,sql,graphql,gql,json,yaml,yml}'];

        this.watcher = chokidar.watch(patterns, {
            cwd: this.config.rootDir,
            ignored: [/node_modules/, /\.git/, /dist/, /\.cos/, ...ignored],
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 200,
                pollInterval: 100,
            },
            usePolling: false,
        });

        this.watcher
            .on('add', (relativePath: string) => {
                const filePath = path.resolve(this.config.rootDir, relativePath);
                const newContent = this.safeReadFile(filePath);
                if (newContent !== null) {
                    this.fileContents.set(filePath, newContent);
                    this.queue.enqueue(filePath, 'added', undefined, newContent);
                }
            })
            .on('change', (relativePath: string) => {
                const filePath = path.resolve(this.config.rootDir, relativePath);
                const oldContent = this.fileContents.get(filePath) ?? '';
                const newContent = this.safeReadFile(filePath);
                if (newContent !== null && newContent !== oldContent) {
                    this.fileContents.set(filePath, newContent);
                    this.queue.enqueue(filePath, 'modified', oldContent, newContent);
                }
            })
            .on('unlink', (relativePath: string) => {
                const filePath = path.resolve(this.config.rootDir, relativePath);
                const oldContent = this.fileContents.get(filePath);
                this.fileContents.delete(filePath);
                this.queue.enqueue(filePath, 'deleted', oldContent, undefined);
            })
            .on('ready', () => {
                logger.info('File watcher ready', { rootDir: this.config.rootDir });
            })
            .on('error', (err: Error) => {
                logger.error('File watcher error', { error: String(err) });
            });

        logger.info('File watcher started');
    }

    stop(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        this.queue.clear();
        this.fileContents.clear();
        logger.info('File watcher stopped');
    }

    preloadContents(files: string[]): void {
        for (const file of files) {
            const content = this.safeReadFile(file);
            if (content !== null) this.fileContents.set(file, content);
        }
    }

    private safeReadFile(filePath: string): string | null {
        try {
            return fs.readFileSync(filePath, 'utf8');
        } catch {
            return null;
        }
    }
}