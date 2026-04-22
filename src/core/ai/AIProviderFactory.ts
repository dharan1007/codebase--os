import type { AIProvider, AIProviderKind, ProjectConfig } from '../../types/index.js';
import { AIOrchestrator } from '../orchestrator/AIOrchestrator.js';
import { ModelRouter } from '../orchestrator/ModelRouter.js';
import { ResponseCache } from '../context/ResponseCache.js';
import { ContextBuilder } from '../context/ContextBuilder.js';
import { RelationshipGraph } from '../graph/RelationshipGraph.js';
import { Database } from '../../storage/Database.js';
import { EmbeddingIndex } from '../context/EmbeddingIndex.js';
import { GraphStore } from '../../storage/GraphStore.js';
import { ResourceMonitor } from '../orchestrator/ResourceMonitor.js';
import { ProviderRegistry } from './ProviderRegistry.js';
import { ModelRegistry } from './ModelRegistry.js';

export class AIProviderFactory {
    static create(config: ProjectConfig): AIProvider {
        const providerKind = config.ai.provider;
        const model = config.ai.model;

        // Use the Singleton Registry to ensure shared state (Limits/Queue)
        const registry = ProviderRegistry.getInstance();
        const provider = registry.getProvider(
            providerKind as AIProviderKind, 
            this.getApiKey(providerKind),
            model
        );

        return AIProviderFactory.wrapWithOrchestrator(provider, config);
    }

    static createRaw(kind: AIProviderKind, model: string): AIProvider {
        const apiKey = this.getApiKey(kind);
        return ProviderRegistry.getInstance().getProvider(kind, apiKey, model);
    }

    private static getApiKey(kind: string): string | undefined {
        const keyMap: Record<string, string | undefined> = {
            openai: process.env['OPENAI_API_KEY'],
            anthropic: process.env['ANTHROPIC_API_KEY'],
            gemini: process.env['GEMINI_API_KEY'],
            openrouter: process.env['OPENROUTER_API_KEY'],
        };
        return keyMap[kind];
    }

    private static wrapWithOrchestrator(provider: AIProvider, config: ProjectConfig): AIProvider {
        const db = new Database(config.rootDir);
        const resourceMonitor = new ResourceMonitor(db);
        const router = new ModelRouter(config, db, resourceMonitor);
        
        const orchestrator = new AIOrchestrator(config, {
            router,
            cache: new ResponseCache(db),
            contextBuilder: new ContextBuilder(new EmbeddingIndex(db, provider), new RelationshipGraph(new GraphStore(db)))
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
        const kinds: AIProviderKind[] = ['openai', 'anthropic', 'gemini', 'openrouter', 'ollama'];
        const available: AIProviderKind[] = [];

        await Promise.all(kinds.map(async (kind) => {
            try {
                const key = this.getApiKey(kind);
                if (kind === 'ollama' || (key && key.length > 0)) {
                    const provider = ProviderRegistry.getInstance().getProvider(kind, key);
                    if (await provider.isAvailable()) available.push(kind);
                }
            } catch { /* skip */ }
        }));

        return available;
    }
}