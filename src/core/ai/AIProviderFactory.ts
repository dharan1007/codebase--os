import type { AIProvider, AIProviderKind, ProjectConfig } from '../../types/index.js';
import { OpenAIProvider } from './providers/OpenAIProvider.js';
import { AnthropicProvider } from './providers/AnthropicProvider.js';
import { GeminiProvider } from './providers/GeminiProvider.js';
import { OpenRouterProvider } from './providers/OpenRouterProvider.js';
import { OllamaProvider } from './providers/OllamaProvider.js';
import { AIOrchestrator } from '../orchestrator/AIOrchestrator.js';
import { ModelRouter } from '../orchestrator/ModelRouter.js';
import { ResponseCache } from '../context/ResponseCache.js';
import { ContextBuilder } from '../context/ContextBuilder.js';
import { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { Database } from '../../storage/Database.js';
import { EmbeddingIndex } from '../context/EmbeddingIndex.js';
import { GraphStore } from '../../storage/GraphStore.js';
import { ResourceMonitor } from '../orchestrator/ResourceMonitor.js';
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
                provider = new OpenAIProvider(key, model || 'gpt-4o');
                break;
            }
            case 'anthropic': {
                const key = process.env['ANTHROPIC_API_KEY'];
                if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
                provider = new AnthropicProvider(key, model || 'claude-3-5-sonnet-latest');
                break;
            }
            case 'gemini': {
                const key = process.env['GEMINI_API_KEY'];
                if (!key) throw new Error('GEMINI_API_KEY is not set');
                provider = new GeminiProvider(key, model || 'gemini-1.5-pro');
                break;
            }
            case 'openrouter': {
                const key = process.env['OPENROUTER_API_KEY'];
                if (!key) throw new Error('OPENROUTER_API_KEY is not set');
                provider = new OpenRouterProvider(key, model || 'anthropic/claude-3.5-sonnet');
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

        return AIProviderFactory.wrapWithOrchestrator(provider, config);
    }

    static createRaw(kind: AIProviderKind, model: string): AIProvider {
        const keyMap: Record<string, string | undefined> = {
            openai: process.env['OPENAI_API_KEY'],
            anthropic: process.env['ANTHROPIC_API_KEY'],
            gemini: process.env['GEMINI_API_KEY'],
            openrouter: process.env['OPENROUTER_API_KEY'],
        };

        const key = keyMap[kind];
        if (kind !== 'ollama' && (!key || key.trim().length === 0)) {
            throw new Error(`Configuration Error: API Key for ${kind} is missing or empty in .env`);
        }

        switch (kind) {
            case 'openai': return new OpenAIProvider(key!, model || 'gpt-4o');
            case 'anthropic': return new AnthropicProvider(key!, model || 'claude-3-5-sonnet-latest');
            case 'gemini': return new GeminiProvider(key!, model || 'gemini-1.5-pro');
            case 'openrouter': return new OpenRouterProvider(key!, model || 'anthropic/claude-3.5-sonnet');
            case 'ollama': return new OllamaProvider(process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434', model || 'codellama:7b');
            default: throw new Error(`Unsupported provider: ${kind}`);
        }
    }

    private static wrapWithOrchestrator(provider: AIProvider, config: ProjectConfig): AIProvider {
        const db = new Database(config.rootDir);
        const store = new GraphStore(db);
        const graph = new RelationshipGraph(store);
        
        const resourceMonitor = new ResourceMonitor(db);
        const router = new ModelRouter(config, db, resourceMonitor);
        const cache = new ResponseCache(db);
        cache.init();
        
        const index = new EmbeddingIndex(db, provider);
        index.init();
        const contextBuilder = new ContextBuilder(index, graph);

        const orchestrator = new AIOrchestrator(config, {
            router,
            cache,
            contextBuilder
        });

        return {
            kind: provider.kind,
            execute: (req) => orchestrator.execute(req),
            isAvailable: () => provider.isAvailable(),
            embed: provider.embed ? (text) => provider.embed!(text) : undefined,
            batchEmbed: provider.batchEmbed ? (texts) => provider.batchEmbed!(texts) : undefined,
            listModels: provider.listModels ? () => provider.listModels!() : undefined
        };
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