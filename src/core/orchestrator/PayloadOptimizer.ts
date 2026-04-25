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
     * Strategy: Structural pruning. Detect file/section blocks and preserve
     * their boundaries instead of naive string slicing.
     */
    static optimize(request: ModelRequest): ModelRequest {
        const currentTokens = TokenEstimator.estimateRequest(request);
        
        if (currentTokens <= this.IDEAL_TOKENS) {
            return request;
        }

        logger.debug(`[Optimizer] Payload too hot: ${currentTokens} tokens. Performing structural trimming...`);

        const context = request.context;
        
        // 1. Section-Aware Trimming
        // We look for '=== SECTION ===' headers which are standard in Codebase OS
        const sectionMarkers = [...context.matchAll(/=== [^=]+ ===/g)];
        
        if (sectionMarkers.length >= 3) {
            // Keep the first 1.5 sections (usually structure/seed) and the last section
            const firstMarker = sectionMarkers[0];
            const middleMarker = sectionMarkers[1];
            const lastMarker = sectionMarkers[sectionMarkers.length - 1];

            const head = context.slice(0, middleMarker.index! + 300); // include start of 2nd section
            const tail = context.slice(lastMarker.index! - 100);    // include end of previous + last section

            const optimizedContext = `${head}\n\n[... ${sectionMarkers.length - 2} INTERMEDIATE CONTEXT BLOCKS PRUNED FOR 429 COMPLIANCE ...]\n\n${tail}`;
            
            // Re-estimate to ensure we didn't accidentally keep too much
            if (TokenEstimator.estimate(optimizedContext) < this.MAX_SAFE_TOKENS) {
                return { ...request, context: optimizedContext };
            }
        }

        // 2. Line-Aware Fallback (Prevents breaking code/json logic mid-line)
        const lines = context.split('\n');
        if (lines.length > 400) {
            const head = lines.slice(0, 100).join('\n');
            const tail = lines.slice(-200).join('\n');
            
            return {
                ...request,
                context: `${head}\n\n// [... ${lines.length - 300} LINES PRUNED TO PREVENT TOKEN OVERFLOW ...]\n\n${tail}`
            };
        }
        
        // 3. Last Resort: Character slice but with boundary safety
        const targetChars = this.IDEAL_TOKENS * 4;
        const headPart = context.slice(0, 1500);
        const tailPart = context.slice(-(targetChars - 1500));
        
        return {
            ...request,
            context: `${headPart}\n\n[... CONTEXT OVERFLOW PROTECTION ...]\n\n${tailPart}`
        };
    }
}
