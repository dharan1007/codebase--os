import { logger } from '../../utils/logger.js';
import type { AIProviderKind } from '../../types/index.js';

export type ProviderStatus = 'HEALTHY' | 'DEGRADED' | 'CIRCUIT_BROKEN';

interface ProviderStats {
    status: ProviderStatus;
    consecutiveFailures: number;
    lastErrorAt?: number;
    cooldownUntil?: number;
    successCount: number;
    errorCount: number;
}

export class ProviderHealthTracker {
    private static instance: ProviderHealthTracker;
    private stats: Map<AIProviderKind, ProviderStats> = new Map();

    private constructor() {}

    static getInstance(): ProviderHealthTracker {
        if (!ProviderHealthTracker.instance) {
            ProviderHealthTracker.instance = new ProviderHealthTracker();
        }
        return ProviderHealthTracker.instance;
    }

    reportSuccess(provider: AIProviderKind): void {
        const stats = this.getOrCreate(provider);
        stats.successCount++;
        stats.consecutiveFailures = 0;
        stats.status = 'HEALTHY';
        stats.cooldownUntil = undefined;
    }

    reportFailure(provider: AIProviderKind, error: any): void {
        const stats = this.getOrCreate(provider);
        stats.errorCount++;
        stats.consecutiveFailures++;
        stats.lastErrorAt = Date.now();

        const message = String(error?.message || error).toLowerCase();
        const rateLimited = message.includes('rate limit') || message.includes('429') || message.includes('too many requests');

        if (rateLimited) {
            const delay = 15_000 * Math.pow(3, Math.min(stats.consecutiveFailures - 1, 2));
            stats.cooldownUntil = Date.now() + delay;
            stats.status = stats.consecutiveFailures >= 3 ? 'CIRCUIT_BROKEN' : 'DEGRADED';
            logger.error(
                `[ProviderHealth] ${provider} rate-limited. Blackout for ${Math.round(delay / 1000)}s. (Status: ${stats.status})`,
            );
            return;
        }

        if (stats.consecutiveFailures >= 2) {
            stats.status = 'DEGRADED';
            stats.cooldownUntil = Date.now() + 30_000;
            logger.warn(`[ProviderHealth] ${provider} unstable. Cooldown for 30s.`);
        }
    }

    isHealthy(provider: AIProviderKind): boolean {
        const stats = this.stats.get(provider);
        if (!stats) return true;

        this.refreshCooldown(stats);
        if (stats.cooldownUntil && Date.now() < stats.cooldownUntil) return false;
        return stats.status !== 'CIRCUIT_BROKEN';
    }

    getWeight(provider: AIProviderKind): number {
        const stats = this.stats.get(provider);
        if (!stats) return 1.0;
        if (!this.isHealthy(provider)) return 0.0;

        const total = stats.successCount + stats.errorCount;
        const successRate = total > 0 ? stats.successCount / total : 1.0;
        const penalty = stats.consecutiveFailures * 0.2;
        return Math.max(0.1, successRate - penalty);
    }

    getSummary() {
        return Array.from(this.stats.entries()).map(([provider, stats]) => {
            this.refreshCooldown(stats);
            return {
                provider,
                status: stats.status,
                successRate: (stats.successCount / (stats.successCount + stats.errorCount || 1)).toFixed(2),
                cooldownRemaining: stats.cooldownUntil ? Math.max(0, stats.cooldownUntil - Date.now()) : 0,
            };
        });
    }

    private refreshCooldown(stats: ProviderStats): void {
        if (!stats.cooldownUntil || Date.now() < stats.cooldownUntil) return;
        stats.cooldownUntil = undefined;
        if (stats.status === 'CIRCUIT_BROKEN') stats.status = 'DEGRADED';
    }

    private getOrCreate(provider: AIProviderKind): ProviderStats {
        if (!this.stats.has(provider)) {
            this.stats.set(provider, {
                status: 'HEALTHY',
                consecutiveFailures: 0,
                successCount: 0,
                errorCount: 0,
            });
        }
        return this.stats.get(provider)!;
    }
}
