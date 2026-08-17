import path from 'path';
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

export class AIProviderFactory {
    static create(config: ProjectConfig): AIProvider {
        const providerKind = config.ai.provider as AIProviderKind;
        const provider = ProviderRegistry.getInstance().getProvider(
            providerKind,
            this.getApiKey(providerKind),
            config.ai.model,
        );

        return this.wrapWithOrchestrator(provider, config);
    }

    static createRaw(kind: AIProviderKind, model: string): AIProvider {
        return ProviderRegistry.getInstance().getProvider(kind, this.getApiKey(kind), model);
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
        // AppContext persists project state in <root>/.cos/cos.db. The previous
        // implementation opened <root>/cos.db here, splitting embeddings/cache
        // and graph context from the CLI's authoritative state database.
        const dataDir = path.join(config.rootDir, '.cos');
        const db = new Database(dataDir);
        const store = new GraphStore(db);
        const graph = new RelationshipGraph(store);
        graph.load();

        const resourceMonitor = new ResourceMonitor(db);
        const router = new ModelRouter(config, db, resourceMonitor);
        const index = new EmbeddingIndex(db, provider);

        const orchestrator = new AIOrchestrator(config, {
            router,
            cache: new ResponseCache(db),
            contextBuilder: new ContextBuilder(index, graph),
        });

        return {
            kind: provider.kind,
            execute: req => orchestrator.execute(req),
            isAvailable: () => provider.isAvailable(),
            embed: provider.embed ? text => provider.embed!(text) : undefined,
            batchEmbed: provider.batchEmbed ? texts => provider.batchEmbed!(texts) : undefined,
            listModels: provider.listModels ? () => provider.listModels!() : undefined,
        };
    }

    static async detectAvailableProviders(): Promise<AIProviderKind[]> {
        const kinds: AIProviderKind[] = ['openai', 'anthropic', 'gemini', 'openrouter', 'ollama'];
        const available: AIProviderKind[] = [];

        await Promise.all(kinds.map(async kind => {
            try {
                const key = this.getApiKey(kind);
                if (kind === 'ollama' || (key && key.length > 0)) {
                    const provider = ProviderRegistry.getInstance().getProvider(kind, key);
                    if (await provider.isAvailable()) available.push(kind);
                }
            } catch {
                // Provider discovery is best effort; individual failures should
                // not prevent other configured providers from being discovered.
            }
        }));

        return available;
    }
}
