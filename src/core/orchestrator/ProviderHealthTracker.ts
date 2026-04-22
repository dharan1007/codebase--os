import { logger } from '../../utils/logger.js';
import type { AIProviderKind } from '../../types/index.js';

export type ProviderStatus = 'HEALTHY' | 'DEGRADED' | 'CIRCUIT_BROKEN';

/**
 * ProviderHealthTracker — True Multi-Provider Awareness systems.
 * 
 * Tracks historical and real-time success rates at the PROVIDER level. 
 * This prevents the system from getting stuck in an 'OpenRouter loop'
 * by marking the entire infrastructure as compromised when it returns 429s.
 */
export class ProviderHealthTracker {
    private static instance: ProviderHealthTracker;
    private stats: Map<AIProviderKind, {
        status: ProviderStatus;
        consecutiveFailures: number;
        lastErrorAt?: number;
        cooldownUntil?: number;
        successCount: number;
        errorCount: number;
    }> = new Map();

    private constructor() {}

    static getInstance(): ProviderHealthTracker {
        if (!ProviderHealthTracker.instance) {
            ProviderHealthTracker.instance = new ProviderHealthTracker();
        }
        return ProviderHealthTracker.instance;
    }

    /**
     * Records a successful request for a provider.
     */
    reportSuccess(provider: AIProviderKind): void {
        const s = this.getOrCreate(provider);
        s.successCount++;
        s.consecutiveFailures = 0;
        s.status = 'HEALTHY';
        s.cooldownUntil = undefined;
    }

    /**
     * Records a failure and determines if a circuit break is required.
     */
    reportFailure(provider: AIProviderKind, error: any): void {
        const s = this.getOrCreate(provider);
        s.errorCount++;
        s.consecutiveFailures++;
        s.lastErrorAt = Date.now();

        const msg = String(error?.message || error).toLowerCase();
        const isRateLimit = msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests');

        if (isRateLimit) {
            // Rate Limit Escalation: 
            // 1 fail = 15s cooldown
            // 2 fails = 45s cooldown
            // 3+ fails = 90s circuit break
            const delay = 15000 * Math.pow(3, Math.min(s.consecutiveFailures - 1, 2));
            s.cooldownUntil = Date.now() + delay;
            s.status = s.consecutiveFailures >= 3 ? 'CIRCUIT_BROKEN' : 'DEGRADED';
            
            logger.error(`[ProviderHealth] ${provider} rate-limited. Blackout for ${Math.round(delay/1000)}s. (Status: ${s.status})`);
        } else {
            // Generic failure (e.g. 500)
            if (s.consecutiveFailures >= 2) {
                s.status = 'DEGRADED';
                s.cooldownUntil = Date.now() + 30000;
                logger.warn(`[ProviderHealth] ${provider} unstable. Cooldown for 30s.`);
            }
        }
    }

    /**
     * Returns true if the provider is currently considered healthy enough for use.
     */
    isHealthy(provider: AIProviderKind): boolean {
        const s = this.stats.get(provider);
        if (!s) return true;

        if (s.status === 'CIRCUIT_BROKEN') return false;
        if (s.cooldownUntil && Date.now() < s.cooldownUntil) return false;

        return true;
    }

    /**
     * Returns a weight for provider selection (higher is preferred).
     */
    getWeight(provider: AIProviderKind): number {
        const s = this.stats.get(provider);
        if (!s) return 1.0;
        
        if (!this.isHealthy(provider)) return 0.0;
        
        // Reliability factor
        const total = s.successCount + s.errorCount;
        const successRate = total > 0 ? s.successCount / total : 1.0;
        
        // Penalize recent hiccups
        const penalty = (s.consecutiveFailures * 0.2);
        
        return Math.max(0.1, successRate - penalty);
    }

    private getOrCreate(provider: AIProviderKind) {
        if (!this.stats.has(provider)) {
            this.stats.set(provider, {
                status: 'HEALTHY',
                consecutiveFailures: 0,
                successCount: 0,
                errorCount: 0
            });
        }
        return this.stats.get(provider)!;
    }

    getSummary() {
        return Array.from(this.stats.entries()).map(([p, s]) => ({
            provider: p,
            status: s.status,
            successRate: (s.successCount / (s.successCount + s.errorCount || 1)).toFixed(2),
            cooldownRemaining: s.cooldownUntil ? Math.max(0, s.cooldownUntil - Date.now()) : 0
        }));
    }
}
