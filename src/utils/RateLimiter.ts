import { logger } from './logger.js';

export interface RateLimiterOptions {
    maxConcurrency: number;
    requestsPerMinute: number;
    requestsPerDay?: number;
    delayBetweenRequestsMs?: number;
}

/**
 * RateLimiter ensures that AI provider calls respect API quotas and 
 * avoid hitting rate limits (429 errors).
 */
export class RateLimiter {
    private queue: Array<() => Promise<void>> = [];
    private running = 0;
    private lastRequestTime = 0;
    private rpmCount = 0;
    private rpmStartTime = Date.now();

    constructor(private options: RateLimiterOptions) {}

    async execute<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                try {
                    const result = await fn();
                    resolve(result);
                } catch (err) {
                    reject(err);
                }
            });
            this.processQueue();
        });
    }

    private async processQueue() {
        if (this.running >= this.options.maxConcurrency || this.queue.length === 0) {
            return;
        }

        // Respect RPM
        this.checkRPM();
        if (this.rpmCount >= this.options.requestsPerMinute) {
            const waitTime = 60000 - (Date.now() - this.rpmStartTime);
            setTimeout(() => this.processQueue(), Math.max(0, waitTime));
            return;
        }

        // Respect delay between requests
        const now = Date.now();
        const timeSinceLast = now - this.lastRequestTime;
        const requiredDelay = this.options.delayBetweenRequestsMs || 0;

        if (timeSinceLast < requiredDelay) {
            setTimeout(() => this.processQueue(), requiredDelay - timeSinceLast);
            return;
        }

        const task = this.queue.shift();
        if (task) {
            this.running++;
            this.rpmCount++;
            this.lastRequestTime = Date.now();
            
            try {
                await task();
            } finally {
                this.running--;
                this.processQueue();
            }
        }
    }

    private checkRPM() {
        const now = Date.now();
        if (now - this.rpmStartTime > 60000) {
            this.rpmStartTime = now;
            this.rpmCount = 0;
        }
    }

    /**
     * Executes a task with exponential backoff if it fails with a 429 error.
     */
    static async withRetry<T>(
        fn: () => Promise<T>, 
        maxRetries = 5, 
        baseDelayMs = 1000
    ): Promise<T> {
        let lastError: any;
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await fn();
            } catch (err: any) {
                lastError = err;
                const msg = String(err).toLowerCase();
                if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
                    const delay = baseDelayMs * Math.pow(2, i);
                    logger.warn(`Rate limit hit. Retrying in ${delay}ms... (Attempt ${i + 1}/${maxRetries})`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                throw err;
            }
        }
        throw lastError;
    }
}
