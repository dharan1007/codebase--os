import type { ModelRequest, ProjectConfig, AIProviderKind, AIProvider } from '../../types/index.js';
import { Database } from '../../storage/Database.js';
import { ResourceMonitor } from './ResourceMonitor.js';
import { AIProviderFactory } from '../ai/AIProviderFactory.js';
import { SemanticModelSlug, ModelRegistry } from '../ai/ModelRegistry.js';
import { HotHealthTracker } from './HotHealthTracker.js';
import { logger } from '../../utils/logger.js';

export interface ProviderSelection {
    provider: AIProviderKind;
    model: string;
    tier: 1 | 2 | 3;
}

export class ModelRouter {
    private health: HotHealthTracker;

    constructor(
        private config: ProjectConfig, 
        private db: Database,
        private monitor: ResourceMonitor
    ) {
        this.health = HotHealthTracker.getInstance();
    }

    /**
     * Compatibility bridge for single-provider consumers.
     */
    getProviderForTask(taskType: string): AIProvider {
        const chain = this.selectProvider({
            taskType: taskType as any,
            priority: 'medium',
            context: 'compatibility-check',
            maxTokens: 2000
        });
        const best = chain[0] || { provider: 'openai', model: 'gpt-4o' };
        
        return AIProviderFactory.createRaw(best.provider, best.model);
    }

    /**
     * Selects an optimally ranked chain of providers/models.
     * Guarantees 'Provider Diversity' in the top 2 slots to prevent
     * getting stuck on a single rate-limited provider.
     */
    selectProvider(request: ModelRequest): ProviderSelection[] {
        const candidates = this.getCandidatePool(request.taskType);
        
        // 1. Filter by Health and Key Availability
        const available = candidates.filter(sel => {
            if (!this.checkKeyAvailability(sel.provider)) return false;
            
            // Check real-time health (Instant Cooldowns & Provider Circuit Breaking)
            if (!this.health.isAvailable(sel.provider, sel.model)) {
                return false;
            }

            // Check resource budget (RPM/Cost)
            const status = this.monitor.canExecute(sel.provider);
            return status.allowed;
        });

        // 2. Rank by Tier and Health Score
        const sorted = available.sort((a, b) => {
            const scoreA = this.health.getScore(a.provider, a.model) - (a.tier * 20);
            const scoreB = this.health.getScore(b.provider, b.model) - (b.tier * 20);
            return scoreB - scoreA;
        });

        // 3. ENFORCE DIVERSITY: Ensure top 2 are different providers if available
        if (sorted.length >= 2 && sorted[0].provider === sorted[1].provider) {
            const diffProviderIdx = sorted.findIndex(s => s.provider !== sorted[0].provider);
            if (diffProviderIdx !== -1) {
                // Swap the second slot with the first different provider found
                const surrogate = sorted[diffProviderIdx];
                sorted.splice(diffProviderIdx, 1);
                sorted.splice(1, 0, surrogate);
            }
        }

        return sorted;
    }

    private getCandidatePool(taskType: string): ProviderSelection[] {
        const pool: ProviderSelection[] = [];

        // TIER 1: THE PRINCIPALS (High Accuracy, High Cost)
        pool.push({ provider: 'anthropic', model: 'claude-3-5-sonnet-latest', tier: 1 });
        pool.push({ provider: 'openai', model: 'gpt-4o', tier: 1 });
        pool.push({ provider: 'openrouter', model: 'anthropic/claude-3.5-sonnet', tier: 1 });

        // TIER 2: THE RELIABLES (Solid Performance, Good Limits)
        pool.push({ provider: 'gemini', model: 'gemini-1.5-pro', tier: 2 });
        pool.push({ provider: 'openrouter', model: 'google/gemini-pro-1.5', tier: 2 });
        pool.push({ provider: 'openrouter', model: 'meta-llama/llama-3.1-405b', tier: 2 });

        // TIER 3: THE WORKERS (Free, Unstable, or Fast)
        pool.push({ provider: 'gemini', model: 'gemini-1.5-flash', tier: 3 });
        pool.push({ provider: 'openrouter', model: 'google/gemini-flash-1.5', tier: 3 });
        pool.push({ provider: 'openrouter', model: 'google/gemma-2-9b-it:free', tier: 3 });
        pool.push({ provider: 'openai', model: 'gpt-4o-mini', tier: 3 });

        // If user specified a specific provider/model in config, promote it to Tier 1
        const userKind = this.config.ai.provider as AIProviderKind;
        const userModel = this.config.ai.model;
        if (userModel) {
            pool.unshift({ provider: userKind, model: userModel, tier: 1 });
        }

        return pool;
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
}
