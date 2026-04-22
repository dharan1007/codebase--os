import type { AIProvider, ModelRequest, ModelResponse, ProjectConfig, AIProviderKind } from '../../types/index.js';
import { ModelRouter } from './ModelRouter.js';
import { ProviderRouter } from './ProviderRouter.js';
import { ResponseCache } from '../context/ResponseCache.js';
import { ContextBuilder } from '../context/ContextBuilder.js';
import { RequestQueue } from './RequestQueue.js';
import { logger } from '../../utils/logger.js';
import { ProviderRegistry } from '../ai/ProviderRegistry.js';
import { ProviderHealthTracker } from './ProviderHealthTracker.js';
import { withTimeout } from '../../utils/TimeoutWrapper.js';
import { PayloadOptimizer } from './PayloadOptimizer.js';
import crypto from 'crypto';

export class AIOrchestrator {
    private modelRouter: ModelRouter;
    private providerRouter: ProviderRouter;
    private cache: ResponseCache;
    private contextBuilder: ContextBuilder;
    private health: ProviderHealthTracker;
    private registry: ProviderRegistry;

    constructor(private config: ProjectConfig, dependencies: {
        router: ModelRouter,
        cache: ResponseCache,
        contextBuilder: ContextBuilder
    }) {
        this.modelRouter = dependencies.router;
        this.providerRouter = new ProviderRouter(config);
        this.cache = dependencies.cache;
        this.contextBuilder = dependencies.contextBuilder;
        this.health = ProviderHealthTracker.getInstance();
        this.registry = ProviderRegistry.getInstance();
    }

    /**
     * Executes an AI request with True Multi-Provider Resilience.
     * Pivot strategy: Provider-first, then Model-first.
     */
    async execute(request: ModelRequest): Promise<ModelResponse> {
        // 1. Check Cache
        const cacheKey = this.generateCacheKey(request);
        const cached = await this.cache.get(cacheKey);
        if (cached) return JSON.parse(cached);

        // 2. Prepare Context (with Traffic Shaping / Payload Optimization)
        const enrichedContext = await this.contextBuilder.enrich(request.context, request.filePath);
        request.context = enrichedContext;
        
        // Shape traffic: Trim context if it's too 'hot' (preemptive 429 protection)
        const optimizedRequest = PayloadOptimizer.optimize(request);
        request.context = this.compress(optimizedRequest.context);

        // 3. Execution via Priority Queue
        return RequestQueue.getInstance().enqueue(async () => {
            return this.executeWithMultiProviderFallback(request, cacheKey);
        }, request.priority === 'high' ? 10 : 5);
    }

    private async executeWithMultiProviderFallback(request: ModelRequest, cacheKey: string): Promise<ModelResponse> {
        const providerSequence = this.providerRouter.getProviderSequence();
        let lastError: Error | null = null;

        for (const providerKind of providerSequence) {
            // Get best models available for THIS specific provider
            const modelChain = this.modelRouter.selectProvider(request)
                .filter(sel => sel.provider === providerKind);
            
            if (modelChain.length === 0) {
                logger.debug(`[Orchestrator] Provider ${providerKind} skipped: No active models available (Cooldown/No Keys).`);
                continue;
            }

            const selection = modelChain[0];
            const start = Date.now();

            try {
                const provider = this.registry.getProvider(providerKind, undefined, selection.model);
                
                // Wrap execution with hard timeout to prevent indefinite hangs
                const result = await withTimeout(
                    (signal) => provider.execute({ ...request, signal } as any),
                    45000,
                    `AI:${providerKind}:${selection.model}`
                );
                
                // Track Provider Success
                this.health.reportSuccess(providerKind);
                
                // Track Model Success (Legacy/Granular tracking)
                // HotHealthTracker.getInstance().reportSuccess(providerKind, selection.model, Date.now() - start);
                
                this.cache.set(cacheKey, request.taskType, JSON.stringify(result));
                return result;
            } catch (err: any) {
                lastError = err;
                
                // CRITICAL: Report failure to ProviderHealthTracker to trigger Circuit Breaker
                this.health.reportFailure(providerKind, err);
                
                logger.warn(`[Orchestrator] Provider ${providerKind} failed. PIVOTING to next provider...`, {
                    error: err.message,
                    model: selection.model
                });

                // Immediately move to the NEXT provider in the sequence 
                // instead of retrying another model in the same failing provider.
                continue;
            }
        }

        throw new Error(`[Orchestrator] Global Outage: All ${providerSequence.length} providers exhausted. Last error: ${lastError?.message}`);
    }
    private generateCacheKey(request: ModelRequest): string {
        const payload = JSON.stringify({
            taskType: request.taskType,
            context: request.context,
            filePath: request.filePath,
            maxTokens: request.maxTokens
        });
        return `ai:v2:${request.taskType}:${crypto.createHash('sha256').update(payload).digest('hex')}`;
    }

    private compress(context: string): string {
        return context
            .replace(/\s+/g, ' ')
            .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, '[TS]')
            .slice(0, 30000);
    }
}
