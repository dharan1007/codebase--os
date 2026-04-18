import type { AIProvider, AICompletionRequest, AICompletionResponse, AIProviderKind } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

export class AIModelOutageError extends Error {
    constructor(message: string, public readonly lastAttemptModel: string) {
        super(message);
        this.name = 'AIModelOutageError';
    }
}

export class AIQuotaReachedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AIQuotaReachedError';
    }
}

/**
 * AIOrchestrator implements a resilient, adaptive multi-model failover system.
 * Updated for the SOVEREIGN OVERHAUL to prevent 'Dumbing Down' of logic.
 */
export class AIOrchestrator implements AIProvider {
    readonly kind: AIProviderKind;

    private failureCount = 0;
    private lastFailureTime = 0;
    private readonly circuitThreshold = 4;
    private readonly circuitResetMs = 60000;

    private static modelPenalties: Map<string, number> = new Map();
    private static lastSuccessModel: string | null = null;
    private static globalQuotaLock = false;
    private readonly PENALTY_DURATION_MS = 600000; 

    // [SOVEREIGN CONFIG]
    public survivalMode = false; // If false, we FAIL instead of demoting to low-intel models

    private readonly FREE_FALLBACK_POOL = [
        'meta-llama/llama-3.3-70b-instruct:free',
        'google/gemma-2-9b-it:free',
        'mistralai/mistral-7b-instruct:free',
        'qwen/qwen-2.5-72b-instruct:free',
        'google/gemma-3-27b-it:free'
    ];

    constructor(private readonly provider: AIProvider) {
        this.kind = provider.kind;
    }

    private isCircuitOpen(): boolean {
        if (this.failureCount >= this.circuitThreshold) {
            const elapsed = Date.now() - this.lastFailureTime;
            if (elapsed < this.circuitResetMs) return true;
            this.failureCount = 0;
        }
        return false;
    }

    async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
        return this.internalComplete(request, (req) => this.provider.complete(req));
    }

    async completeStream(request: AICompletionRequest, onToken: (token: string) => void): Promise<AICompletionResponse> {
        if (!this.provider.completeStream) return this.complete(request);
        return this.internalComplete(request, (req) => this.provider.completeStream!(req, onToken));
    }

    private async internalComplete(
        request: AICompletionRequest,
        fn: (req: AICompletionRequest) => Promise<AICompletionResponse>
    ): Promise<AICompletionResponse> {
        if (AIOrchestrator.globalQuotaLock) {
            throw new AIQuotaReachedError('Daily quota reached (50 requests/day). Switch to a paid tier to unlock 1000/day.');
        }

        if (this.isCircuitOpen()) throw new Error(`AI Circuit Breaker is OPEN for ${this.kind}.`);

        let attempts = 0;
        const maxAttempts = this.survivalMode ? 12 : 3; // Drastically reduce spamming if not in survival mode

        while (attempts < maxAttempts) {
            if (attempts === 0 && AIOrchestrator.lastSuccessModel && this.isOutageModel(request.model || 'default')) {
                // Only use success-memory if it's the same tier
                if (!request.model?.endsWith(':free') || AIOrchestrator.lastSuccessModel.endsWith(':free')) {
                    request.model = AIOrchestrator.lastSuccessModel;
                }
            }

            const now = Date.now();
            for (const [m, expiry] of AIOrchestrator.modelPenalties.entries()) {
                if (now > expiry) AIOrchestrator.modelPenalties.delete(m);
            }

            if (attempts > 0) {
                const waitTime = Math.min(Math.pow(2, attempts) * 2000, 15000);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }

            // [SOVEREIGN BUDGETING]: Principal requests get more tokens
            const isPrincipal = request.systemPrompt.includes('Principal') || request.systemPrompt.includes('Senior');
            if (isPrincipal && !request.maxTokens) {
                request.maxTokens = 4000; // Hard allowance for deep code edits
            } else if (!request.maxTokens) {
                request.maxTokens = 800;
            }

            try {
                const result = await fn(request);
                this.failureCount = 0;
                AIOrchestrator.lastSuccessModel = result.model || request.model || null;
                return result;
            } catch (err: any) {
                attempts++;
                const error = err instanceof Error ? err : new Error(String(err));
                const errorMsg = error.message.toLowerCase();

                // Check for hard daily lock
                if (errorMsg.includes('free-models-per-day')) {
                    AIOrchestrator.globalQuotaLock = true;
                    throw new AIQuotaReachedError(error.message);
                }

                this.failureCount++;
                this.lastFailureTime = Date.now();

                const isRateLimit = errorMsg.includes('429') || errorMsg.includes('rate limit');
                const isCreditError = errorMsg.includes('402') || errorMsg.includes('credit') || errorMsg.includes('balance');

                // [SOVEREIGN OVERHAUL]: No silent fallbacks for principal tasks
                if (isCreditError && !this.survivalMode) {
                    logger.error(`\n❌ CREDIT ERROR: Your configured model '${request.model || 'default'}' reports no balance.`);
                    logger.info(`If you have unlimited tokens, please verify your OpenRouter API key and Project settings.`);
                    throw error; // Stop immediately, don't fallback to 'free' toys
                }

                if (isRateLimit && attempts < maxAttempts) {
                    const currentModel = request.model || 'default';
                    AIOrchestrator.modelPenalties.set(currentModel, Date.now() + this.PENALTY_DURATION_MS);

                    if (this.survivalMode) {
                        let nextModel = this.FREE_FALLBACK_POOL.find(m => !AIOrchestrator.modelPenalties.has(m) && m !== currentModel);
                        if (!nextModel) nextModel = this.FREE_FALLBACK_POOL[(attempts - 1) % this.FREE_FALLBACK_POOL.length];
                        
                        logger.warn(`\n⚠️ [SURVIVAL] Attempt ${attempts}/${maxAttempts}: '${currentModel}' rate-limited. Trying '${nextModel}'...`);
                        request.model = nextModel;
                        continue;
                    }
                }
                
                if (attempts >= maxAttempts) {
                    throw new AIModelOutageError(`Request failed after ${maxAttempts} attempts.`, request.model || 'unknown');
                }

                throw error;
            }
        }
        throw new AIModelOutageError('AI task failed.', request.model || 'unknown');
    }

    private isOutageModel(model: string): boolean {
        return AIOrchestrator.modelPenalties.has(model);
    }

    async isAvailable(): Promise<boolean> { return this.provider.isAvailable(); }
    async listModels(): Promise<string[]> { return typeof this.provider.listModels === 'function' ? await this.provider.listModels() : []; }
    async embed(text: string): Promise<number[]> { if (!this.provider.embed) return []; try { return await this.provider.embed(text); } catch { return []; } }
    async batchEmbed(texts: string[]): Promise<number[][]> { if (!this.provider.batchEmbed) return texts.map(() => []); try { return await this.provider.batchEmbed(texts); } catch { return texts.map(() => []); } }
}