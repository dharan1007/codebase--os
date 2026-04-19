import { Database } from '../../storage/Database.js';
import { logger } from '../../utils/logger.js';

export interface ProviderBudget {
    maxCost: number;
    currentCost: number;
    tokensThisSession: number;
    requestCount: number;
    lastRequestTime: number;
    rateLimitPerMin: number;
}

export class ResourceMonitor {
    private budgets: Map<string, ProviderBudget> = new Map();
    private sessionStart = Date.now();

    constructor(private db: Database) {
        this.initBudget('openai', 5.0, 50);  // $5 budget, 50 req/min
        this.initBudget('anthropic', 5.0, 40);
        this.initBudget('gemini', 10.0, 100);
        this.initBudget('openrouter', 5.0, 60);
        this.initBudget('ollama', Infinity, Infinity); // Local is free
    }

    private initBudget(provider: string, maxCost: number, rateLimit: number) {
        this.budgets.set(provider, {
            maxCost,
            currentCost: 0,
            tokensThisSession: 0,
            requestCount: 0,
            lastRequestTime: 0,
            rateLimitPerMin: rateLimit
        });
    }

    canExecute(provider: string): { allowed: boolean; reason?: string } {
        const budget = this.budgets.get(provider);
        if (!budget) return { allowed: true };

        // 1. Check Budget
        if (budget.currentCost >= budget.maxCost) {
            return { allowed: false, reason: `Budget exceeded for ${provider} ($${budget.currentCost.toFixed(2)})` };
        }

        // 2. Check Rate Limit (Basic Leaky Bucket / Window approach)
        const now = Date.now();
        if (now - budget.lastRequestTime < (60000 / budget.rateLimitPerMin)) {
            return { allowed: false, reason: `Rate limiting active for ${provider}` };
        }

        return { allowed: true };
    }

    recordUsage(provider: string, tokens: number, cost: number) {
        const budget = this.budgets.get(provider);
        if (budget) {
            budget.currentCost += cost;
            budget.tokensThisSession += tokens;
            budget.requestCount += 1;
            budget.lastRequestTime = Date.now();
            
            this.db.prepare(`
                INSERT INTO eval_metrics (id, sessionId, taskProfile, durationMs, tokensUsed, successRate, regressionDetected, costEstimate, provider, model, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                crypto.randomUUID(),
                'monitor-session',
                'resource-tracking',
                0,
                tokens,
                1.0, 0,
                cost,
                provider,
                'usage-log',
                Date.now()
            );
        }
    }

    getReport() {
        return Array.from(this.budgets.entries()).map(([provider, b]) => ({
            provider,
            cost: b.currentCost.toFixed(4),
            tokens: b.tokensThisSession,
            requests: b.requestCount
        }));
    }
}
