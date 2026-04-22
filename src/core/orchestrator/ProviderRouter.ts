import type { AIProviderKind, ProjectConfig } from '../../types/index.js';
import { ProviderHealthTracker } from './ProviderHealthTracker.js';
import { logger } from '../../utils/logger.js';

export interface ProviderPriority {
    provider: AIProviderKind;
    tier: 1 | 2; // 1 = Direct (OpenAI, Gemini, Anthropic), 2 = Aggregator (OpenRouter)
}

/**
 * ProviderRouter — True Multi-Provider Selection Layer.
 * 
 * Instead of selecting a model first, this selects the healthiest INFRASTRUCTURE 
 * PROVIDER. This ensures that if the 'Aggregator' (OpenRouter) is down, the 
 * system immediately pivots to direct alternatives.
 */
export class ProviderRouter {
    private health: ProviderHealthTracker;
    private config: ProjectConfig;

    constructor(config: ProjectConfig) {
        this.config = config;
        this.health = ProviderHealthTracker.getInstance();
    }

    /**
     * Resolves the optimally ordered infrastructure sequence for a request.
     */
    getProviderSequence(): AIProviderKind[] {
        const pool: ProviderPriority[] = [
            { provider: 'anthropic', tier: 1 },
            { provider: 'openai', tier: 1 },
            { provider: 'gemini', tier: 1 },
            { provider: 'openrouter', tier: 2 },
            { provider: 'ollama', tier: 2 }
        ];

        // 1. Filter by API Key availability
        const available = pool.filter(p => this.hasKeys(p.provider));
        logger.debug(`[ProviderRouter] Key availability: ${available.map(p => p.provider).join(', ')}`);

        // 2. Filter by Healthy state
        const healthy = available.filter(p => this.health.isHealthy(p.provider));
        if (healthy.length < available.length) {
            const unhealthy = available.filter(p => !this.health.isHealthy(p.provider));
            logger.debug(`[ProviderRouter] Skipping unhealthy providers: ${unhealthy.map(p => p.provider).join(', ')}`);
        }

        // 3. Sort by Tier and Weight (Historical success)
        const sequence = healthy.sort((a, b) => {
            if (a.tier !== b.tier) return a.tier - b.tier; // Direct first
            
            const weightA = this.health.getWeight(a.provider);
            const weightB = this.health.getWeight(b.provider);
            return weightB - weightA; // Higher reliability first
        });

        // 4. In-flight Promotion: If user explicitly configured a primary provider, 
        // move it to the front of Tier 1 if healthy.
        const userKind = this.config.ai.provider as AIProviderKind;
        const userIdx = sequence.findIndex(p => p.provider === userKind);
        if (userIdx > 0) {
            const [userP] = sequence.splice(userIdx, 1);
            sequence.unshift(userP);
        }

        const result = sequence.map(s => s.provider);
        logger.info(`[ProviderRouter] Active sequence: ${result.join(' -> ')}`);
        
        if (result.length === 0) {
            logger.warn('[ProviderRouter] All providers are currently unhealthy or missing keys. Forcing wait state.');
        }

        return result;
    }

    private hasKeys(provider: AIProviderKind): boolean {
        const check = (keyName: string) => {
            const val = process.env[keyName];
            return !!(val && val.trim().length > 0);
        };

        switch (provider) {
            case 'openai': return check('OPENAI_API_KEY');
            case 'anthropic': return check('ANTHROPIC_API_KEY');
            case 'gemini': return check('GEMINI_API_KEY');
            case 'openrouter': return check('OPENROUTER_API_KEY');
            case 'ollama': return true;
            default: return false;
        }
    }
}
