import { logger } from '../../utils/logger.js';
import type { ModelRequest } from '../../types/index.js';

/**
 * TokenEstimator — Heuristic-based token counting for payload budgeting.
 */
export class TokenEstimator {
    /**
     * Estimates tokens using the standard 4-chars-per-token heuristic.
     */
    static estimate(text: string): number {
        if (!text) return 0;
        return Math.ceil(text.length / 4);
    }

    /**
     * Estimates total request weight.
     */
    static estimateRequest(request: ModelRequest): number {
        const sys = this.estimate(request.systemPrompt || '');
        const ctx = this.estimate(request.context || '');
        return sys + ctx;
    }
}

/**
 * PayloadOptimizer — Preemptive traffic shaping by trimming context.
 */
export class PayloadOptimizer {
    private static readonly MAX_SAFE_TOKENS = 6000; // Hard cap for 'worker' models
    private static readonly IDEAL_TOKENS = 3500;    // Target size for cost efficiency

    /**
     * Trims the request context if it exceeds the safe budget.
     * Strategy: Keep the first 1000 chars (seed) and the last N chars (latest logic).
     */
    static optimize(request: ModelRequest): ModelRequest {
        const currentTokens = TokenEstimator.estimateRequest(request);
        
        if (currentTokens <= this.IDEAL_TOKENS) {
            return request;
        }

        logger.debug(`[Optimizer] Payload too hot: ${currentTokens} tokens. Trimming to ${this.IDEAL_TOKENS}...`);

        const context = request.context;
        const targetChars = this.IDEAL_TOKENS * 4;
        
        // Keep header (1500 chars) + trailing tail (rest of budget)
        const header = context.slice(0, 1500);
        const tail = context.slice(-(targetChars - 1500));
        
        const optimizedContext = `${header}\n\n[... OMITTED FOR CONTEXT EFFICIENCY ...]\n\n${tail}`;
        
        return {
            ...request,
            context: optimizedContext
        };
    }
}
