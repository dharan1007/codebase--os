import type { ModelRequest, ProjectConfig, AIProviderKind, AIProvider } from '../../types/index.js';
import { Database } from '../../storage/Database.js';
import { ResourceMonitor } from './ResourceMonitor.js';
import { AIProviderFactory } from '../ai/AIProviderFactory.js';

export interface ProviderSelection {
    provider: AIProviderKind;
    model: string;
}

export class ModelRouter {
    constructor(
        private config: ProjectConfig, 
        private db: Database,
        private monitor: ResourceMonitor
    ) {}

    /**
     * Compatibility bridge for single-provider consumers.
     */
    getProviderForTask(taskType: string): AIProvider {
        const request: ModelRequest = {
            taskType: taskType as any,
            priority: 'medium',
            context: 'compatibility-check',
            maxTokens: 2000
        };
        const chain = this.selectProvider(request);
        const best = chain[0] || { provider: 'openai', model: 'gpt-4o' };
        
        return AIProviderFactory.create({
            ...this.config,
            ai: {
                ...this.config.ai,
                provider: best.provider,
                model: best.model
            }
        });
    }

    /**
     * Selects an ordered chain of providers for a request.
     */
    selectProvider(request: ModelRequest): ProviderSelection[] {
        let baseChain = this.getBaselineChain(request.taskType);

        // 1. Resource and Key filtering
        baseChain = baseChain.filter(sel => {
            // Check key availability
            const hasKey = this.checkKeyAvailability(sel.provider);
            if (!hasKey) return false;

            // Check budget/rate limits
            const status = this.monitor.canExecute(sel.provider);
            return status.allowed;
        });

        // 2. Dynamic refinement based on metrics
        return this.refineWithMetrics(request.taskType, baseChain);
    }

    private getBaselineChain(taskType: string): ProviderSelection[] {
        const userProvider = this.config.ai.provider as AIProviderKind;
        const userModel = this.config.ai.model || 'gpt-4o';

        const userSelection = { provider: userProvider, model: userModel };

        const chains: Record<string, ProviderSelection[]> = {
            simple: [
                { provider: 'ollama', model: 'llama-3.2:3b' },
                { provider: 'gemini', model: 'gemini-1.5-flash' }
            ],
            analysis: [
                { provider: 'gemini', model: 'gemini-1.5-flash' },
                { provider: 'openai', model: 'gpt-4o-mini' }
            ],
            reasoning: [
                { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' },
                { provider: 'gemini', model: 'gemini-1.5-pro' },
                { provider: 'openai', model: 'gpt-4o' }
            ],
            design: [
                { provider: 'openai', model: 'gpt-4o' },
                { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' }
            ]
        };

        const chain = chains[taskType] || [{ provider: 'openai', model: 'gpt-4o' }];

        // Prepend user selection if not already in chain
        if (!chain.some(s => s.provider === userProvider)) {
            return [userSelection, ...chain];
        }

        // If user provider is in chain, move it to the front
        return [
            userSelection,
            ...chain.filter(s => s.provider !== userProvider)
        ];
    }

    private checkKeyAvailability(provider: AIProviderKind): boolean {
        const keyMap: Record<string, string | undefined> = {
            openai: process.env['OPENAI_API_KEY'],
            anthropic: process.env['ANTHROPIC_API_KEY'],
            gemini: process.env['GEMINI_API_KEY'],
            openrouter: process.env['OPENROUTER_API_KEY'],
            ollama: 'local-available' 
        };
        const key = keyMap[provider];
        return !!(key && key.trim().length > 0);
    }

    private refineWithMetrics(taskType: string, chain: ProviderSelection[]): ProviderSelection[] {
        try {
            // Find if any provider in the chain has a high failure rate recently
            const stats = this.db.prepare(`
                SELECT provider, model, AVG(successRate) as avgSuccess
                FROM eval_metrics
                WHERE taskProfile = ? AND timestamp > ?
                GROUP BY provider, model
            `).all(taskType, Date.now() - 3600000); // Last 1 hour

            // If a provider has < 50% success, deprioritize it
            const unreliable = stats
                .filter((s: any) => s.avgSuccess < 0.5)
                .map((s: any) => `${s.provider}:${s.model}`);

            return chain.sort((a, b) => {
                const aKey = `${a.provider}:${a.model}`;
                const bKey = `${b.provider}:${b.model}`;
                if (unreliable.includes(aKey) && !unreliable.includes(bKey)) return 1;
                if (!unreliable.includes(aKey) && unreliable.includes(bKey)) return -1;
                return 0;
            });
        } catch {
            return chain;
        }
    }
}
