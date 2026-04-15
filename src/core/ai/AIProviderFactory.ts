import type { AIProvider, AIProviderKind, ProjectConfig } from '../../types/index.js';
import { OpenAIProvider } from './providers/OpenAIProvider.js';
import { AnthropicProvider } from './providers/AnthropicProvider.js';
import { GeminiProvider } from './providers/GeminiProvider.js';
import { OpenRouterProvider } from './providers/OpenRouterProvider.js';
import { OllamaProvider } from './providers/OllamaProvider.js';
import { AIOrchestrator } from './AIOrchestrator.js';
import { logger } from '../../utils/logger.js';

export class AIProviderFactory {
    static create(config: ProjectConfig): AIProvider {
        const providerKind = config.ai.provider;
        const model = config.ai.model;

        let provider: AIProvider;
        switch (providerKind) {
            case 'openai': {
                const key = process.env['OPENAI_API_KEY'];
                if (!key) throw new Error('OPENAI_API_KEY is not set');
                if (!model) throw new Error('No AI model configured for OpenAI. Run cos config.');
                provider = new OpenAIProvider(key, model);
                break;
            }
            case 'anthropic': {
                const key = process.env['ANTHROPIC_API_KEY'];
                if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
                if (!model) throw new Error('No AI model configured for Anthropic. Run cos config.');
                provider = new AnthropicProvider(key, model);
                break;
            }
            case 'gemini': {
                const key = process.env['GEMINI_API_KEY'];
                if (!key) throw new Error('GEMINI_API_KEY is not set');
                if (!model) throw new Error('No AI model configured for Gemini. Run cos config.');
                provider = new GeminiProvider(key, model);
                break;
            }
            case 'openrouter': {
                const key = process.env['OPENROUTER_API_KEY'];
                if (!key) throw new Error('OPENROUTER_API_KEY is not set');
                if (!model) throw new Error('No AI model configured for OpenRouter. Run cos config.');
                provider = new OpenRouterProvider(key, model);
                break;
            }
            case 'ollama': {
                const baseURL = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
                provider = new OllamaProvider(baseURL, model ?? process.env['OLLAMA_MODEL'] ?? 'codellama:7b');
                break;
            }
            default:
                throw new Error(`Unknown AI provider: ${providerKind}`);
        }

        return new AIOrchestrator(provider);
    }

    static async detectAvailableProviders(): Promise<AIProviderKind[]> {
        const candidates: Array<{ kind: AIProviderKind; provider: AIProvider }> = [];

        if (process.env['OPENAI_API_KEY']) {
            candidates.push({ kind: 'openai', provider: new OpenAIProvider(process.env['OPENAI_API_KEY']) });
        }
        if (process.env['ANTHROPIC_API_KEY']) {
            candidates.push({ kind: 'anthropic', provider: new AnthropicProvider(process.env['ANTHROPIC_API_KEY']) });
        }
        if (process.env['GEMINI_API_KEY']) {
            candidates.push({ kind: 'gemini', provider: new GeminiProvider(process.env['GEMINI_API_KEY']) });
        }
        if (process.env['OPENROUTER_API_KEY']) {
            candidates.push({ kind: 'openrouter', provider: new OpenRouterProvider(process.env['OPENROUTER_API_KEY']) });
        }

        const ollamaProvider = new OllamaProvider(process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434');
        candidates.push({ kind: 'ollama', provider: ollamaProvider });

        const available: AIProviderKind[] = [];
        await Promise.all(
            candidates.map(async ({ kind, provider }) => {
                try {
                    if (await provider.isAvailable()) available.push(kind);
                } catch {
                    logger.debug(`Provider ${kind} not available`);
                }
            })
        );

        return available;
    }
}