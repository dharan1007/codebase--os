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
import { TrafficController, AIRequest } from './TrafficController.js';
import crypto from 'crypto';

export class AIOrchestrator {
    private modelRouter: ModelRouter;
    private providerRouter: ProviderRouter;
    private cache: ResponseCache;
    private contextBuilder: ContextBuilder;
    private registry: ProviderRegistry;
    private trafficController: TrafficController;

    constructor(private config: ProjectConfig, dependencies: {
        router: ModelRouter,
        cache: ResponseCache,
        contextBuilder: ContextBuilder
    }) {
        this.modelRouter = dependencies.router;
        this.providerRouter = new ProviderRouter(config);
        this.cache = dependencies.cache;
        this.contextBuilder = dependencies.contextBuilder;
        this.registry = ProviderRegistry.getInstance();
        
        this.trafficController = TrafficController.getInstance();
        
        // Wire up the generic network executor
        this.trafficController.setNetworkExecutor(async (req: AIRequest, providerKind: AIProviderKind) => {
            const modelChain = this.modelRouter.selectProvider(req.requestDetails)
                .filter(sel => sel.provider === providerKind);
                
            if (modelChain.length === 0) {
                throw new Error(`No active models available for provider: ${providerKind}`);
            }
            
            const selection = modelChain[0];
            const provider = this.registry.getProvider(providerKind, undefined, selection.model);
            
            return await withTimeout(
                (signal) => provider.execute({ ...req.requestDetails, signal } as any),
                45000,
                `AI:${providerKind}:${selection.model}`
            );
        });
    }

    async execute(request: ModelRequest): Promise<ModelResponse> {
        const cacheKey = this.generateCacheKey(request);
        const cached = await this.cache.get(cacheKey);
        if (cached) return JSON.parse(cached);

        const enrichedContext = await this.contextBuilder.enrich(request.context, request.filePath);
        request.context = enrichedContext;
        
        const optimizedRequest = PayloadOptimizer.optimize(request);
        
        const providerSequence = this.providerRouter.getProviderSequence();

        // Enqueue perfectly structured request directly into Traffic Controller
        // It handles retries, throttling, cascading payload logic natively.
        const result = await this.trafficController.schedule(optimizedRequest, providerSequence);

        this.cache.set(cacheKey, request.taskType, JSON.stringify(result));
        return result;
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
}
