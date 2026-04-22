import { logger } from '../../utils/logger.js';

/**
 * AdaptiveDelayManager — Global singleton for tracking 'Request Heat'.
 * 
 * It ensures we don't burst requests too fast, and slows down
 * automatically when the system detects 429 rate limits.
 */
export class AdaptiveDelayManager {
    private static instance: AdaptiveDelayManager;
    private currentDelay = 1500; // Start with 1.5s delay
    private readonly MIN_DELAY = 1200;
    private readonly MAX_DELAY = 10000;
    private lastRequestTime = 0;

    private constructor() {}

    static getInstance(): AdaptiveDelayManager {
        if (!AdaptiveDelayManager.instance) {
            AdaptiveDelayManager.instance = new AdaptiveDelayManager();
        }
        return AdaptiveDelayManager.instance;
    }

    /**
     * Records a successful request. Slowly recovers (decreases delay).
     */
    reportSuccess(): void {
        this.currentDelay = Math.max(this.MIN_DELAY, this.currentDelay - 100);
        logger.debug(`[AdaptiveDelay] Success. New target delay: ${this.currentDelay}ms`);
    }

    /**
     * Records a rate-limit event. Aggressively increases delay.
     */
    reportRateLimit(): void {
        this.currentDelay = Math.min(this.MAX_DELAY, this.currentDelay + 1500);
        logger.warn(`[AdaptiveDelay] 429 Detected. Aggressive slowing to: ${this.currentDelay}ms`);
    }

    /**
     * Returns the required wait time before the next request can be sent.
     */
    getRequiredWaitMs(): number {
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        return Math.max(0, this.currentDelay - elapsed);
    }

    /**
     * Updates the timestamp of the last sent request.
     */
    markRequestSent(): void {
        this.lastRequestTime = Date.now();
    }

    getDelay(): number {
        return this.currentDelay;
    }
}
