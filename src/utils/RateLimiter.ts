/**
 * LeakyBucketRateLimiter — Production-grade rate limiting.
 *
 * The previous implementation was a simple counter that reset every 60 seconds.
 * This meant 45 requests could burst in the first second, then silence.
 * Providers detect burst patterns and 429-throttle the entire session.
 *
 * This implementation uses a Leaky Bucket algorithm:
 *   - Requests drip out at a constant, configurable rate (RPM / 60 = RPS)
 *   - A finite queue holds pending requests — rejects when full
 *   - Built-in exponential backoff on 429 responses
 *   - Circuit Breaker: if a provider hits N consecutive failures it is marked
 *     OPEN for a cooldown period. The orchestrator uses this to skip dead providers.
 *
 * Old interface is preserved exactly for drop-in compatibility.
 */

import { logger } from './logger.js';

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
    private state: CircuitState = 'CLOSED';
    private failureCount = 0;
    private lastFailureTime = 0;
    private successCount = 0;

    constructor(
        private readonly failureThreshold: number = 5,
        private readonly cooldownMs: number = 60_000,
        private readonly halfOpenSuccessThreshold: number = 2,
        private readonly label: string = 'provider'
    ) {}

    /** Returns true if the circuit allows a request to proceed. */
    isAllowed(): boolean {
        if (this.state === 'CLOSED') return true;

        if (this.state === 'OPEN') {
            const elapsed = Date.now() - this.lastFailureTime;
            if (elapsed >= this.cooldownMs) {
                this.state = 'HALF_OPEN';
                this.successCount = 0;
                logger.info(`CircuitBreaker [${this.label}]: HALF_OPEN — probing recovery`);
                return true;
            }
            return false;
        }

        // HALF_OPEN: allow one request through
        return true;
    }

    /** Record a successful call. */
    recordSuccess(): void {
        if (this.state === 'HALF_OPEN') {
            this.successCount++;
            if (this.successCount >= this.halfOpenSuccessThreshold) {
                this.state = 'CLOSED';
                this.failureCount = 0;
                logger.info(`CircuitBreaker [${this.label}]: CLOSED — provider recovered`);
            }
        } else {
            // Reset failure count on any success in CLOSED state
            this.failureCount = 0;
        }
    }

    /** Record a failed call. */
    recordFailure(): void {
        this.failureCount++;
        this.lastFailureTime = Date.now();

        if (this.state === 'HALF_OPEN' || this.failureCount >= this.failureThreshold) {
            this.state = 'OPEN';
            logger.warn(
                `CircuitBreaker [${this.label}]: OPEN — ${this.failureCount} consecutive failures. ` +
                `Cooling down for ${this.cooldownMs / 1000}s.`
            );
        }
    }

    getState(): CircuitState { return this.state; }
    getFailureCount(): number { return this.failureCount; }
}

// ─── Rate Limiter Options (backwards-compatible interface) ───────────────────

export interface RateLimiterOptions {
    maxConcurrency: number;
    requestsPerMinute: number;
    requestsPerDay?: number;
    delayBetweenRequestsMs?: number;
    /** Circuit breaker: consecutive failures before OPEN. Default: 5 */
    circuitBreakerThreshold?: number;
    /** Circuit breaker: cooldown in ms before HALF_OPEN. Default: 60000 */
    circuitBreakerCooldownMs?: number;
    /** Max requests waiting in queue. Rejects beyond this. Default: 200 */
    maxQueueSize?: number;
    /** Label for logging. Default: 'unnamed' */
    label?: string;
}

// Internal queue entry
interface QueueEntry {
    fn: () => Promise<void>;
    resolve: () => void;
    reject: (err: Error) => void;
    enqueuedAt: number;
}

// ─── Main RateLimiter Class ───────────────────────────────────────────────────

export class RateLimiter {
    private queue: QueueEntry[] = [];
    private running = 0;

    // Leaky bucket state
    private readonly intervalMs: number;  // ms between allowed requests
    private lastDrip = 0;                 // timestamp of last dripped request
    private drainTimer: ReturnType<typeof setTimeout> | null = null;

    // Circuit breaker
    private circuit: CircuitBreaker;

    private readonly maxConcurrency: number;
    private readonly maxQueueSize: number;
    private readonly label: string;

    constructor(private options: RateLimiterOptions) {
        this.maxConcurrency = options.maxConcurrency;
        this.maxQueueSize = options.maxQueueSize ?? 200;
        this.label = options.label ?? 'unnamed';

        // Leaky bucket interval: distribute requests evenly over a minute
        this.intervalMs = Math.ceil(60_000 / options.requestsPerMinute);

        this.circuit = new CircuitBreaker(
            options.circuitBreakerThreshold ?? 5,
            options.circuitBreakerCooldownMs ?? 60_000,
            2,
            this.label
        );
    }

    /**
     * Enqueue a task. Returns a promise that resolves with the task's return value.
     * Rejects immediately if the circuit is OPEN or the queue is full.
     */
    async execute<T>(fn: () => Promise<T>): Promise<T> {
        // Circuit breaker check
        if (!this.circuit.isAllowed()) {
            throw new Error(
                `[RateLimiter] Circuit OPEN for provider "${this.label}". ` +
                `Too many consecutive failures. Retry after cooldown.`
            );
        }

        // Queue capacity check
        if (this.queue.length >= this.maxQueueSize) {
            throw new Error(
                `[RateLimiter] Queue full for provider "${this.label}" ` +
                `(${this.maxQueueSize} pending). Backing off.`
            );
        }

        return new Promise<T>((resolve, reject) => {
            // We wrap fn to capture T and bridge to the void-typed queue
            const wrapped: () => Promise<void> = async () => {
                try {
                    const result = await fn();
                    this.circuit.recordSuccess();
                    resolve(result);
                } catch (err: any) {
                    // Classify: only count auth/server failures against circuit.
                    // Rate limit (429) errors are expected during backoff and should NOT trip the circuit.
                    const msg = String(err?.message ?? err).toLowerCase();
                    const isRateLimit = msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests');
                    if (!isRateLimit) {
                        this.circuit.recordFailure();
                    }
                    reject(err);
                }
            };

            this.queue.push({
                fn: wrapped,
                resolve: () => {},
                reject,
                enqueuedAt: Date.now(),
            });

            this.scheduleNextDrip();
        });
    }

    /** Schedule the next drip from the leaky bucket. */
    private scheduleNextDrip(): void {
        if (this.drainTimer !== null) return; // already scheduled

        const now = Date.now();
        const timeSinceLast = now - this.lastDrip;
        const delay = Math.max(0, this.intervalMs - timeSinceLast);

        this.drainTimer = setTimeout(() => {
            this.drainTimer = null;
            this.drip();
        }, delay);
    }

    /** Process one item from the queue (one drip). */
    private drip(): void {
        if (this.queue.length === 0) return;
        if (this.running >= this.maxConcurrency) {
            // All slots busy — reschedule check after current tasks might free up
            this.drainTimer = setTimeout(() => {
                this.drainTimer = null;
                this.drip();
            }, this.intervalMs);
            return;
        }

        const entry = this.queue.shift();
        if (!entry) return;

        this.running++;
        this.lastDrip = Date.now();

        entry.fn().finally(() => {
            this.running--;
            // Immediately schedule next drip after completion
            if (this.queue.length > 0) {
                this.scheduleNextDrip();
            }
        });

        // Schedule the NEXT drip at the constant interval (steady drip rate)
        if (this.queue.length > 0) {
            this.drainTimer = setTimeout(() => {
                this.drainTimer = null;
                this.drip();
            }, this.intervalMs);
        }
    }

    /** Expose circuit state for the ModelRouter to make skip decisions. */
    getCircuitState(): CircuitState { return this.circuit.getState(); }

    /**
     * Static utility: execute a task with exponential backoff on rate-limit errors.
     * This is now actually wired into the provider execute() calls, not a dead utility.
     */
    static async withRetry<T>(
        fn: () => Promise<T>,
        maxRetries = 5,
        baseDelayMs = 1000,
        label = 'request'
    ): Promise<T> {
        let lastError: any;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                return await fn();
            } catch (err: any) {
                lastError = err;
                const msg = String(err?.message ?? err).toLowerCase();

                // Only retry on rate limits and transient server errors
                const isRetryable =
                    msg.includes('429') ||
                    msg.includes('rate limit') ||
                    msg.includes('too many requests') ||
                    msg.includes('503') ||
                    msg.includes('502') ||
                    msg.includes('service unavailable') ||
                    msg.includes('overloaded');

                if (!isRetryable) {
                    logger.debug(`[RateLimiter.withRetry] Non-retryable error for "${label}": ${err.message}`);
                    throw err;
                }

                // Exponential backoff with jitter to avoid thundering herd
                const jitter = Math.random() * 500;
                const delay = baseDelayMs * Math.pow(2, attempt) + jitter;
                logger.warn(
                    `[RateLimiter] Rate-limited for "${label}". ` +
                    `Retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)}ms...`
                );
                await new Promise(r => setTimeout(r, delay));
            }
        }
        throw lastError;
    }
}
