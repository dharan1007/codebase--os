import type { AIProvider, AIProviderKind, ProjectConfig } from '../../types/index.js';
import { OpenAIProvider } from './providers/OpenAIProvider.js';
import { AnthropicProvider } from './providers/AnthropicProvider.js';
import { GeminiProvider } from './providers/GeminiProvider.js';
import { OpenRouterProvider } from './providers/OpenRouterProvider.js';
import { OllamaProvider } from './providers/OllamaProvider.js';
import { logger } from '../../utils/logger.js';
import { ModelRegistry } from './ModelRegistry.js';

/**
 * ProviderRegistry — Singleton registry for AI Provider instances.
 *
 * CRITICAL FIX: The previous architecture instantiated new Providers (and thus new RateLimiters)
 * per request. This destroyed the "Leaky Bucket" state, leading to 429 errors.
 *
 * This Registry ensures ONE instance per provider exists, preserving RPM/TPM state.
 */
export class ProviderRegistry {
    private static instance: ProviderRegistry;
    private providers: Map<string, AIProvider> = new Map();

    private constructor() {}

    static getInstance(): ProviderRegistry {
        if (!ProviderRegistry.instance) {
            ProviderRegistry.instance = new ProviderRegistry();
        }
        return ProviderRegistry.instance;
    }

    /**
     * Retrieves or creates a singleton provider instance.
     */
    getProvider(kind: AIProviderKind, apiKey?: string, model?: string): AIProvider {
        const key = `${kind}:${apiKey || 'default'}`;
        
        if (this.providers.has(key)) {
            return this.providers.get(key)!;
        }

        const resolvedModel = model || ModelRegistry.resolve('reasoning-high', kind);
        let provider: AIProvider;

        switch (kind) {
            case 'openai':
                provider = new OpenAIProvider(apiKey || process.env['OPENAI_API_KEY'] || '', resolvedModel);
                break;
            case 'anthropic':
                provider = new AnthropicProvider(apiKey || process.env['ANTHROPIC_API_KEY'] || '', resolvedModel);
                break;
            case 'gemini':
                provider = new GeminiProvider(apiKey || process.env['GEMINI_API_KEY'] || '', resolvedModel);
                break;
            case 'openrouter':
                provider = new OpenRouterProvider(apiKey || process.env['OPENROUTER_API_KEY'] || '', resolvedModel);
                break;
            case 'ollama':
                provider = new OllamaProvider(process.env['OLLAMA_BASE_URL'] || 'http://localhost:11434', resolvedModel);
                break;
            default:
                throw new Error(`Unsupported provider kind: ${kind}`);
        }

        this.providers.set(key, provider);
        logger.info(`ProviderRegistry: Initialized singleton for ${kind}`, { model: resolvedModel });
        return provider;
    }

    /**
     * Clears the registry (useful for testing or session reset).
     */
    reset(): void {
        this.providers.clear();
    }
}
