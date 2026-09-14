import { logger } from '../../utils/logger.js';
import type { AIProviderKind } from '../../types/index.js';
import { ProviderError, classifyProviderError } from '../ai/providers/ProviderError.js';

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
    private stats = new Map<string, ProviderStats>();

    private constructor() {}

    static getInstance(): ProviderHealthTracker {
        if (!ProviderHealthTracker.instance) ProviderHealthTracker.instance = new ProviderHealthTracker();
        return ProviderHealthTracker.instance;
    }

    reportSuccess(provider: AIProviderKind, model?: string): void {
        const stats = this.getOrCreate(provider, model);
        stats.successCount++;
        stats.consecutiveFailures = 0;
        stats.status = 'HEALTHY';
        stats.cooldownUntil = undefined;
    }

    reportFailure(provider: AIProviderKind, error: unknown, model?: string): void {
        const stats = this.getOrCreate(provider, model);
        const classified = error instanceof ProviderError ? error : classifyProviderError(error, provider);
        stats.errorCount++;
        stats.consecutiveFailures++;
        stats.lastErrorAt = Date.now();

        if (classified.code === 'RATE_LIMIT') {
            const fallbackDelay = 15_000 * Math.pow(3, Math.min(stats.consecutiveFailures - 1, 2));
            const delay = Math.max(0, classified.retryAfterMs ?? fallbackDelay);
            stats.cooldownUntil = Date.now() + delay;
            stats.status = stats.consecutiveFailures >= 3 ? 'CIRCUIT_BROKEN' : 'DEGRADED';
            logger.warn('Provider rate limited', { provider, model, delay, status: stats.status });
            return;
        }

        if (classified.isFatal) {
            stats.status = 'CIRCUIT_BROKEN';
            stats.cooldownUntil = undefined;
            logger.warn('Provider/model unavailable after fatal failure', { provider, model, code: classified.code });
            return;
        }

        if (stats.consecutiveFailures >= 2) {
            stats.status = 'DEGRADED';
            stats.cooldownUntil = Date.now() + 30_000;
            logger.warn('Provider/model temporarily degraded', { provider, model, code: classified.code });
        }
    }

    isHealthy(provider: AIProviderKind, model?: string): boolean {
        const stats = this.stats.get(this.key(provider, model));
        if (!stats) return true;
        this.refreshCooldown(stats);
        if (stats.cooldownUntil && Date.now() < stats.cooldownUntil) return false;
        return stats.status !== 'CIRCUIT_BROKEN';
    }

    getWeight(provider: AIProviderKind, model?: string): number {
        const stats = this.stats.get(this.key(provider, model));
        if (!stats) return 1;
        if (!this.isHealthy(provider, model)) return 0;
        const total = stats.successCount + stats.errorCount;
        const successRate = total > 0 ? stats.successCount / total : 1;
        return Math.max(0.1, successRate - stats.consecutiveFailures * 0.2);
    }

    getSummary(): Array<{
        provider: AIProviderKind;
        model?: string;
        status: ProviderStatus;
        successRate: string;
        cooldownRemaining: number;
    }> {
        return [...this.stats.entries()].map(([key, stats]) => {
            this.refreshCooldown(stats);
            const [provider, encodedModel] = key.split('\u0000');
            return {
                provider: provider as AIProviderKind,
                model: encodedModel || undefined,
                status: stats.status,
                successRate: (stats.successCount / (stats.successCount + stats.errorCount || 1)).toFixed(2),
                cooldownRemaining: stats.cooldownUntil ? Math.max(0, stats.cooldownUntil - Date.now()) : 0,
            };
        });
    }

    private key(provider: AIProviderKind, model?: string): string {
        return `${provider}\u0000${model ?? ''}`;
    }

    private refreshCooldown(stats: ProviderStats): void {
        if (!stats.cooldownUntil || Date.now() < stats.cooldownUntil) return;
        stats.cooldownUntil = undefined;
        if (stats.status === 'CIRCUIT_BROKEN') stats.status = 'DEGRADED';
    }

    private getOrCreate(provider: AIProviderKind, model?: string): ProviderStats {
        const key = this.key(provider, model);
        let stats = this.stats.get(key);
        if (!stats) {
            stats = {
                status: 'HEALTHY',
                consecutiveFailures: 0,
                successCount: 0,
                errorCount: 0,
            };
            this.stats.set(key, stats);
        }
        return stats;
    }
}
