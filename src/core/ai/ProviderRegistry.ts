import type { AIProvider, AIProviderKind } from '../../types/index.js';
import { OpenAIProvider } from './providers/OpenAIProvider.js';
import { AnthropicProvider } from './providers/AnthropicProvider.js';
import { GeminiProvider } from './providers/GeminiProvider.js';
import { OpenRouterProvider } from './providers/OpenRouterProvider.js';
import { OllamaProvider } from './providers/OllamaProvider.js';
import { logger } from '../../utils/logger.js';
import { ModelRegistry } from './ModelRegistry.js';

/**
 * Singleton provider registry.
 *
 * Instances are shared per provider + credential + model so rate-limit state is
 * preserved without accidentally reusing a provider object configured for a
 * different model.
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

    getProvider(kind: AIProviderKind, apiKey?: string, model?: string): AIProvider {
        const resolvedModel = model || ModelRegistry.resolve('reasoning-high', kind);
        // Do not include the raw credential in logs, but including it in this
        // in-process key keeps separately configured credentials isolated.
        const registryKey = `${kind}:${apiKey || 'default'}:${resolvedModel}`;

        const existing = this.providers.get(registryKey);
        if (existing) return existing;

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

        this.providers.set(registryKey, provider);
        logger.info(`ProviderRegistry: initialized ${kind}`, { model: resolvedModel });
        return provider;
    }

    reset(): void {
        this.providers.clear();
    }
}
