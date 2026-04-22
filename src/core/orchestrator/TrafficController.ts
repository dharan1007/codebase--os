import { AdaptiveDelayManager } from './AdaptiveDelayManager.js';
import { logger } from '../../utils/logger.js';

/**
 * TrafficController — Orchestrates global request pacing (Burst Paving).
 */
export class TrafficController {
    private static delayManager = AdaptiveDelayManager.getInstance();

    /**
     * Executes an async task after ensuring the required mandatory delay has passed.
     */
    static async executePaced<T>(fn: () => Promise<T>, label = 'request'): Promise<T> {
        const waitTime = this.delayManager.getRequiredWaitMs();
        
        if (waitTime > 0) {
            logger.debug(`[TrafficController] Pacing active: Waiting ${waitTime}ms for next slot...`);
            await new Promise(r => setTimeout(r, waitTime));
        }

        // Mandatory Cold Start / Gap protection
        // Even if getRequiredWaitMs is 0, we introduce a small jitter/gap
        await new Promise(r => setTimeout(r, 100));

        this.delayManager.markRequestSent();
        
        try {
            const result = await fn();
            this.delayManager.reportSuccess();
            return result;
        } catch (err: any) {
            const msg = String(err?.message || err).toLowerCase();
            if (msg.includes('429') || msg.includes('too many requests') || msg.includes('rate limit')) {
                this.delayManager.reportRateLimit();
            }
            throw err;
        }
    }
}
