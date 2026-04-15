import type { FileChange } from '../../types/index.js';
import { v4 as uuidv4 } from 'uuid';
import { computeDiff, computeHash } from '../../utils/diff.js';
import { logger } from '../../utils/logger.js';

export type QueuedChangeHandler = (change: FileChange) => Promise<void>;

export class ChangeQueue {
    private queue: FileChange[] = [];
    private processing = false;
    private handler: QueuedChangeHandler | null = null;
    private debounceTimers = new Map<string, NodeJS.Timeout>();
    private debounceMs: number;

    constructor(debounceMs = 500) {
        this.debounceMs = debounceMs;
    }

    setHandler(handler: QueuedChangeHandler): void {
        this.handler = handler;
    }

    enqueue(filePath: string, changeType: FileChange['changeType'], oldContent?: string, newContent?: string): void {
        const existing = this.debounceTimers.get(filePath);
        if (existing) {
            clearTimeout(existing);
        }

        const timer = setTimeout(() => {
            this.debounceTimers.delete(filePath);
            const diff = oldContent && newContent
                ? computeDiff(oldContent, newContent, filePath).raw
                : undefined;

            const change: FileChange = {
                id: uuidv4(),
                filePath,
                changeType,
                oldContent,
                newContent,
                timestamp: Date.now(),
                diff,
            };

            this.queue.push(change);
            logger.debug('Change enqueued', { file: filePath, type: changeType });
            this.process();
        }, this.debounceMs);

        this.debounceTimers.set(filePath, timer);
    }

    private async process(): Promise<void> {
        if (this.processing || !this.handler || this.queue.length === 0) return;
        this.processing = true;

        while (this.queue.length > 0) {
            const change = this.queue.shift()!;
            try {
                await this.handler(change);
            } catch (err) {
                logger.error('Change handler error', { file: change.filePath, error: String(err) });
            }
        }

        this.processing = false;
    }

    get pendingCount(): number {
        return this.queue.length;
    }

    clear(): void {
        this.queue.length = 0;
        for (const timer of this.debounceTimers.values()) clearTimeout(timer);
        this.debounceTimers.clear();
    }
}