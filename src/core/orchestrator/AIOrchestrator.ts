import type { ModelRequest, ModelResponse, ProjectConfig, AIProviderKind } from '../../types/index.js';
import { ModelRouter } from './ModelRouter.js';
import { ProviderRouter } from './ProviderRouter.js';
import { ResponseCache } from '../context/ResponseCache.js';
import { ContextBuilder } from '../context/ContextBuilder.js';
import { ProviderRegistry } from '../ai/ProviderRegistry.js';
import { withTimeout } from '../../utils/TimeoutWrapper.js';
import { PayloadOptimizer } from './PayloadOptimizer.js';
import { TrafficController, type AIRequest } from './TrafficController.js';
import crypto from 'crypto';

export class AIOrchestrator {
    private modelRouter: ModelRouter;
    private providerRouter: ProviderRouter;
    private cache: ResponseCache;
    private contextBuilder: ContextBuilder;
    private registry: ProviderRegistry;
    private trafficController: TrafficController;

    constructor(
        private config: ProjectConfig,
        dependencies: {
            router: ModelRouter;
            cache: ResponseCache;
            contextBuilder: ContextBuilder;
        },
    ) {
        this.modelRouter = dependencies.router;
        this.providerRouter = new ProviderRouter(config);
        this.cache = dependencies.cache;
        this.contextBuilder = dependencies.contextBuilder;
        this.registry = ProviderRegistry.getInstance();
        this.trafficController = TrafficController.getInstance();

        this.trafficController.setNetworkExecutor(async (req: AIRequest, providerKind: AIProviderKind) => {
            const modelChain = this.modelRouter.selectProvider(req.requestDetails)
                .filter(selection => selection.provider === providerKind);
            if (modelChain.length === 0) {
                throw new Error(`No active models available for provider: ${providerKind}`);
            }

            const selection = modelChain[0]!;
            const provider = this.registry.getProvider(providerKind, undefined, selection.model);
            return await withTimeout(
                signal => provider.execute({ ...req.requestDetails, signal } as any),
                45_000,
                `AI:${providerKind}:${selection.model}`,
            );
        });
    }

    async execute(request: ModelRequest): Promise<ModelResponse> {
        // Retrieval is deliberately performed before cache lookup. The enriched
        // repository evidence is part of cache identity, so a changed graph/code
        // snapshot cannot accidentally reuse a generation produced for older code.
        const enrichedContext = await this.contextBuilder.enrich(request.context, request.filePath);
        const optimizedRequest = PayloadOptimizer.optimize({
            ...request,
            context: enrichedContext,
        });

        const providerSequence = this.providerRouter.getProviderSequence();
        const cacheKey = this.generateCacheKey(optimizedRequest, providerSequence);
        const cached = await this.cache.get(cacheKey);
        if (cached) {
            const parsed = JSON.parse(cached) as ModelResponse;
            return { ...parsed, cached: true };
        }

        const result = await this.trafficController.schedule(optimizedRequest, providerSequence);
        this.cache.set(cacheKey, optimizedRequest.taskType, JSON.stringify({ ...result, cached: false }));
        return result;
    }

    private generateCacheKey(request: ModelRequest, providerSequence: AIProviderKind[]): string {
        const payload = JSON.stringify({
            version: 3,
            taskType: request.taskType,
            priority: request.priority,
            context: request.context,
            systemPrompt: request.systemPrompt ?? '',
            filePath: request.filePath ?? '',
            maxTokens: request.maxTokens,
            temperature: request.temperature ?? null,
            modelOverride: request.modelOverride ?? null,
            configuredProvider: this.config.ai.provider,
            configuredModel: this.config.ai.model ?? null,
            providerSequence,
        });
        return `ai:v3:${request.taskType}:${crypto.createHash('sha256').update(payload).digest('hex')}`;
    }
}
