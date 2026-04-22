import { logger } from '../../utils/logger.js';

export type ModelStatus = 'HEALTHY' | 'DEGRADED' | 'FAILED' | 'COOLDOWN';

export interface ModelHealth {
    provider: string;
    model: string;
    status: ModelStatus;
    consecutiveFailures: number;
    lastError?: string;
    lastErrorAt?: number;
    cooldownUntil?: number;
    latencyAvg: number;
}

/**
 * HotHealthTracker — In-memory singleton for real-time model health monitoring.
 * 
 * This module enables "Self-Healing" by allowing the orchestrator to track
 * which models are currently overloaded (429) or unstable (500) and put
 * them on temporary cooldown.
 */
export class HotHealthTracker {
    private static instance: HotHealthTracker;
    private stats: Map<string, ModelHealth> = new Map(); // Key: provider:model
    private providerFailures: Map<string, number> = new Map(); // provider -> consecutive diff model fails
    private providerCooldowns: Map<string, number> = new Map(); // provider -> timestamp

    private constructor() {}

    static getInstance(): HotHealthTracker {
        if (!HotHealthTracker.instance) {
            HotHealthTracker.instance = new HotHealthTracker();
        }
        return HotHealthTracker.instance;
    }

    /**
     * Reports a success for a model.
     */
    reportSuccess(provider: string, model: string, latency: number): void {
        const health = this.getOrCreate(provider, model);
        health.consecutiveFailures = 0;
        health.status = 'HEALTHY';
        health.cooldownUntil = undefined;
        
        this.providerFailures.set(provider, 0); // Reset provider-level tracking
        
        // Simple moving average for latency
        health.latencyAvg = (health.latencyAvg * 0.7) + (latency * 0.3);
    }

    /**
     * Reports a failure and determines the appropriate cooldown/status.
     */
    reportFailure(provider: string, model: string, error: any): void {
        const health = this.getOrCreate(provider, model);
        health.consecutiveFailures++;
        health.lastError = error.message || String(error);
        health.lastErrorAt = Date.now();

        const msg = (health.lastError || '').toLowerCase();
        
        // Update Provider-Level Failure Context
        const pFails = (this.providerFailures.get(provider) || 0) + 1;
        this.providerFailures.set(provider, pFails);

        // Escalation: If 3 DIFFERENT models on the same provider fail rapidly, 
        // trip the provider-level circuit breaker.
        if (pFails >= 3) {
            const delay = 60000; // 1 minute blackout for the provider
            this.providerCooldowns.set(provider, Date.now() + delay);
            logger.error(`[HealthTracker] Provider ${provider} CIRCUIT BROKEN. 60s blackout applied.`);
        }

        if (msg.includes('rate limit') || msg.includes('429')) {
            const delay = 45000 * Math.pow(1.5, Math.min(health.consecutiveFailures - 1, 3));
            health.cooldownUntil = Date.now() + delay;
            health.status = 'COOLDOWN';
            logger.warn(`[HealthTracker] ${provider}:${model} rate-limited. Cooldown for ${Math.round(delay/1000)}s.`);
        } else if (msg.includes('model not found') || msg.includes('404')) {
            health.status = 'FAILED';
            logger.error(`[HealthTracker] ${provider}:${model} NOT FOUND. Blacklisting.`);
        } else {
            health.status = 'DEGRADED';
            health.cooldownUntil = Date.now() + 15000;
        }
    }

    /**
     * Returns true if the model is available for selection.
     */
    isAvailable(provider: string, model: string): boolean {
        // 1. Check Provider-Level Circuit Breaker
        const pCooldown = this.providerCooldowns.get(provider);
        if (pCooldown && Date.now() < pCooldown) {
            return false;
        }

        // 2. Check Model-Level Cooldown
        const health = this.stats.get(`${provider}:${model}`);
        if (!health) return true;
        
        if (health.status === 'FAILED') return false;
        
        if (health.cooldownUntil && Date.now() < health.cooldownUntil) {
            return false;
        }

        return true;
    }

    /**
     * Returns a score for ranking models (higher is better).
     */
    getScore(provider: string, model: string): number {
        const health = this.stats.get(`${provider}:${model}`);
        if (!health) return 100; // Baseline
        
        if (!this.isAvailable(provider, model)) return 0;
        
        let score = 100;
        score -= (health.consecutiveFailures * 10);
        if (health.status === 'DEGRADED') score -= 30;
        
        return Math.max(0, score);
    }

    private getOrCreate(provider: string, model: string): ModelHealth {
        const key = `${provider}:${model}`;
        if (!this.stats.has(key)) {
            this.stats.set(key, {
                provider,
                model,
                status: 'HEALTHY',
                consecutiveFailures: 0,
                latencyAvg: 2000
            });
        }
        return this.stats.get(key)!;
    }

    getStatusSummary() {
        return Array.from(this.stats.values()).map(h => ({
            key: `${h.provider}:${h.model}`,
            status: h.status,
            failures: h.consecutiveFailures,
            cooldownLeft: h.cooldownUntil ? Math.max(0, h.cooldownUntil - Date.now()) : 0
        }));
    }
}
