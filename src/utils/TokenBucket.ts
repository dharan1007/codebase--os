/**
 * TokenBucket — Implements generic token-per-minute (TPM) rate limiting.
 *
 * Each provider has both an RPM (handled by RateLimiter) and a TPM (handled here).
 * A Request must satisfy BOTH conditions to drip out of the bucket.
 */
export class TokenBucket {
    private tokens: number;
    private lastRefill: number;
    private readonly maxTokens: number;
    private readonly refillRate: number; // tokens per ms

    constructor(tokensPerMinute: number) {
        this.maxTokens = tokensPerMinute;
        this.tokens = tokensPerMinute;
        this.lastRefill = Date.now();
        this.refillRate = tokensPerMinute / 60_000;
    }

    /**
     * Attempts to consume N tokens. Returns true if successful.
     */
    tryConsume(count: number): boolean {
        this.refill();
        if (this.tokens >= count) {
            this.tokens -= count;
            return true;
        }
        return false;
    }

    /**
     * Returns the milliseconds until N tokens will be available.
     */
    getTimeUntilAvailable(count: number): number {
        this.refill();
        if (this.tokens >= count) return 0;
        const missing = count - this.tokens;
        return Math.ceil(missing / this.refillRate);
    }

    private refill(): void {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        const drip = elapsed * this.refillRate;
        
        this.tokens = Math.min(this.maxTokens, this.tokens + drip);
        this.lastRefill = now;
    }

    getAvailableTokens(): number {
        this.refill();
        return Math.floor(this.tokens);
    }
}
