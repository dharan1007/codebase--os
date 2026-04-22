import { logger } from './logger.js';

export interface RetryOptions {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    label: string;
}

/**
 * RetryManager — High-fidelity request resilience.
 *
 * Replaces naive loops with:
 *  - Exponential Backoff (2^n)
 *  - Full Jitter (to prevent thundering herds)
 *  - Error Sensitivity (only retries transient codes like 429, 503)
 */
export class RetryManager {
    static async withRetry<T>(
        fn: () => Promise<T>,
        options: Partial<RetryOptions> = {}
    ): Promise<T> {
        const config: RetryOptions = {
            maxRetries: options.maxRetries ?? 5,
            baseDelayMs: options.baseDelayMs ?? 1000,
            maxDelayMs: options.maxDelayMs ?? 30000,
            label: options.label ?? 'unnamed-task',
        };

        let lastError: any;

        for (let attempt = 0; attempt < config.maxRetries; attempt++) {
            try {
                return await fn();
            } catch (err: any) {
                lastError = err;
                
                // Only retry on transient failures
                if (!this.isRetryable(err)) {
                    throw err;
                }

                if (attempt === config.maxRetries - 1) break;

                // Calculate backoff: base * 2^attempt + jitter
                const backoff = Math.min(
                    config.maxDelayMs,
                    config.baseDelayMs * Math.pow(2, attempt)
                );
                const jitter = Math.random() * 0.3 * backoff; // 30% jitter
                const finalDelay = backoff + jitter;

                logger.warn(`[RetryManager] Transient failure on ${config.label}. Retry ${attempt + 1}/${config.maxRetries} in ${Math.round(finalDelay)}ms`, {
                    error: err.message,
                    code: err.code
                });

                await new Promise(r => setTimeout(r, finalDelay));
            }
        }

        throw lastError;
    }

    private static isRetryable(err: any): boolean {
        const msg = String(err?.message ?? '').toLowerCase();
        const code = String(err?.code ?? '');

        // Standard HTTP retryable statuses
        if (code === 'RATE_LIMIT' || code === 'SERVER_ERROR' || code === 'NETWORK_ERROR') return true;
        
        // Message-based checks
        const retryableKeywords = [
            'rate limit', '429', '503', '502', '504',
            'too many requests', 'service unavailable', 'overloaded',
            'timeout', 'deadline exceeded', 'connection refused'
        ];

        return retryableKeywords.some(kw => msg.includes(kw));
    }
}
