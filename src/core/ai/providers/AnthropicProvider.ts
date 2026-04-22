import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, ModelRequest, ModelResponse, AIProviderKind } from '../../../types/index.js';
import { logger } from '../../../utils/logger.js';
import { RateLimiter } from '../../../utils/RateLimiter.js';
import { classifyProviderError, ProviderError, RETRYABLE_CODES } from './ProviderError.js';

/** Max retry attempts for retryable errors (rate limits, server errors). */
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1000;

export class AnthropicProvider implements AIProvider {
    readonly kind: AIProviderKind = 'anthropic';
    private client: Anthropic;
    private defaultModel: string;
    private limiter: RateLimiter;

    constructor(apiKey: string, model = 'claude-3-5-sonnet-latest') {
        this.client = new Anthropic({
            apiKey,
            timeout: 300_000, // 5-minute timeout for large codegen tasks
        });
        this.defaultModel = model;

        // RPM is configurable via env var for paid tier users (default: 50 for Tier 1).
        // Free tier is 5 RPM — set ANTHROPIC_RPM=5 in .env if on free tier.
        const rpm = parseInt(process.env['ANTHROPIC_RPM'] ?? '50', 10);
        this.limiter = new RateLimiter({
            maxConcurrency: 3,
            requestsPerMinute: rpm,
            delayBetweenRequestsMs: Math.ceil(60_000 / rpm),
            circuitBreakerThreshold: 5,
            circuitBreakerCooldownMs: 60_000,
            maxQueueSize: 100,
            label: 'anthropic',
        });
    }

    async execute(request: ModelRequest): Promise<ModelResponse> {
        return this.limiter.execute(async () => {
            return RateLimiter.withRetry(
                () => this.callAPI(request),
                MAX_RETRIES,
                BASE_DELAY_MS,
                'anthropic.execute'
            );
        });
    }

    private async callAPI(request: ModelRequest): Promise<ModelResponse> {
        const model = request.modelOverride ?? this.defaultModel;
        try {
            const response = await this.client.messages.create({
                model,
                max_tokens: request.maxTokens ?? 4096,
                system: request.systemPrompt,
                messages: [{ role: 'user', content: request.context }],
                temperature: request.temperature ?? 0.2,
            });

            const content = response.content
                .filter((block: any) => block.type === 'text')
                .map((block: any) => (block as { type: 'text'; text: string }).text)
                .join('');

            return {
                content,
                usage: {
                    promptTokens: response.usage.input_tokens,
                    outputTokens: response.usage.output_tokens,
                    totalTokens: response.usage.input_tokens + response.usage.output_tokens,
                },
                provider: this.kind,
                model,
            };
        } catch (err) {
            const classified = classifyProviderError(err, 'anthropic');
            logger.error('Anthropic call failed', {
                code: classified.code,
                model,
                retryable: classified.isRetryable,
                error: classified.message,
            });
            throw classified;
        }
    }

    async isAvailable(): Promise<boolean> {
        // Real ping: attempt a minimal 1-token completion
        try {
            await this.client.messages.create({
                model: this.defaultModel,
                max_tokens: 5,
                messages: [{ role: 'user', content: 'ping' }],
            });
            return true;
        } catch (err) {
            const classified = classifyProviderError(err, 'anthropic');
            // AUTH_ERROR and MODEL_NOT_FOUND mean config is broken, not that the provider is down
            if (classified.code === 'AUTH_ERROR') {
                logger.warn('Anthropic: Invalid API key');
            }
            return false;
        }
    }

    async listModels(): Promise<string[]> {
        return [
            'claude-3-5-sonnet-latest',
            'claude-3-5-haiku-latest',
            'claude-3-opus-latest',
            'claude-3-opus-20240229',
            'claude-3-sonnet-20240229',
            'claude-3-haiku-20240307',
        ];
    }
}