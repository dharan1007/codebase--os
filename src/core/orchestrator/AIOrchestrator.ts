import type { AIProvider, ModelRequest, ModelResponse, ProjectConfig } from '../../types/index.js';
import { ModelRouter } from './ModelRouter.js';
import { ResponseCache } from '../context/ResponseCache.js';
import { ContextBuilder } from '../context/ContextBuilder.js';
import { logger } from '../../utils/logger.js';
import { AIProviderFactory } from '../ai/AIProviderFactory.js';

export class AIOrchestrator {
    private router: ModelRouter;
    private cache: ResponseCache;
    private contextBuilder: ContextBuilder;

    constructor(private config: ProjectConfig, dependencies: {
        router: ModelRouter,
        cache: ResponseCache,
        contextBuilder: ContextBuilder
    }) {
        this.router = dependencies.router;
        this.cache = dependencies.cache;
        this.contextBuilder = dependencies.contextBuilder;
    }

    /**
     * Standardized execution method - The Brain of Codebase OS.
     */
    async execute(request: ModelRequest): Promise<ModelResponse> {
        // 1. Response Caching
        const cacheKey = this.generateCacheKey(request);
        const cached = await this.cache.get(cacheKey);
        if (cached) {
            logger.info('Orchestrator: Cache hit', { taskType: request.taskType });
            return JSON.parse(cached);
        }

        // 2. Context Intelligence (RAG + Compression)
        const enrichedContext = await this.contextBuilder.enrich(request.context, request.filePath);
        const compressedContext = this.compress(enrichedContext);
        request.context = compressedContext;

        // 3. Dynamic Selection
        const providerConfigs = this.router.selectProvider(request);
        
        // 4. Fallback Chain Execution
        let lastError: Error | null = null;
        for (const providerConfig of providerConfigs) {
            try {
                logger.info(`Orchestrator: Executing via ${providerConfig.provider} (${providerConfig.model})`);
                
                const provider = AIProviderFactory.createRaw(providerConfig.provider as any, providerConfig.model);
                
                // Finalize request for this specific model
                const finalizedRequest = { ...request, modelOverride: providerConfig.model };
                
                const result = await provider.execute(finalizedRequest);
                
                // Store in cache
                this.cache.set(cacheKey, request.taskType, JSON.stringify(result));
                
                return result;
            } catch (err: any) {
                lastError = err;
                logger.warn(`Orchestrator: Provider ${providerConfig.provider} failed.`, { error: err.message });
                // Fallthrough to next in chain
            }
        }

        throw new Error(`Orchestrator: All providers in chain failed. Last error: ${lastError?.message}`);
    }

    private generateCacheKey(request: ModelRequest): string {
        return `ai:${request.taskType}:${Buffer.from(request.context).toString('base64').slice(0, 32)}`;
    }

    private compress(context: string): string {
        // Remove excessive whitespace and repetitive noise (logs normally have timestamps, etc.)
        return context
            .replace(/\s+/g, ' ')
            .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, '[TS]') // Normalize timestamps
            .slice(0, 30000); // Guard rails
    }
}
