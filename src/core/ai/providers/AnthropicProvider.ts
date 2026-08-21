import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, ModelRequest, ModelResponse, AIProviderKind } from '../../../types/index.js';
import { logger } from '../../../utils/logger.js';
import { RateLimiter } from '../../../utils/RateLimiter.js';
import { classifyProviderError } from './ProviderError.js';

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1000;

export class AnthropicProvider implements AIProvider {
    readonly kind: AIProviderKind = 'anthropic';
    private client: Anthropic;
    private defaultModel: string;
    private limiter: RateLimiter;

    constructor(private apiKey: string, model = 'claude-opus-4-1-20250805') {
        this.client = new Anthropic({
            apiKey,
            timeout: 300_000,
        });
        this.defaultModel = model;

        const rpm = this.positiveInt(process.env['ANTHROPIC_RPM'], 40);
        this.limiter = new RateLimiter({
            maxConcurrency: Math.min(3, this.positiveInt(process.env['ANTHROPIC_MAX_CONCURRENCY'], 3)),
            requestsPerMinute: rpm,
            delayBetweenRequestsMs: Math.ceil(60_000 / rpm),
            circuitBreakerThreshold: 5,
            circuitBreakerCooldownMs: 60_000,
            maxQueueSize: 100,
            label: 'anthropic',
        });
    }

    async execute(request: ModelRequest): Promise<ModelResponse> {
        return this.limiter.execute(async () =>
            RateLimiter.withRetry(
                () => this.callAPI(request),
                MAX_RETRIES,
                BASE_DELAY_MS,
                'anthropic.execute',
            ),
        );
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
                .map((block: any) => String(block.text ?? ''))
                .join('');
            if (!content.trim()) {
                throw new Error('Anthropic returned an empty text response.');
            }

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
        if (!this.apiKey.trim()) return false;
        try {
            await this.client.messages.create({
                model: this.defaultModel,
                max_tokens: 1,
                messages: [{ role: 'user', content: 'Reply with one character.' }],
            });
            return true;
        } catch (err) {
            const classified = classifyProviderError(err, 'anthropic');
            if (classified.code === 'AUTH_ERROR') logger.warn('Anthropic: invalid API key');
            if (classified.code === 'MODEL_NOT_FOUND') {
                logger.warn('Anthropic: configured model is unavailable', { model: this.defaultModel });
            }
            return false;
        }
    }

    async listModels(): Promise<string[]> {
        // The installed SDK version predates Anthropic's model-discovery helper.
        // Return only configured production defaults rather than advertising stale
        // or deprecated models. Operators can override them through ModelRegistry.
        const models = new Set<string>([
            this.defaultModel,
            process.env['COS_ANTHROPIC_REASONING_HIGH_MODEL'] || '',
            process.env['COS_ANTHROPIC_REASONING_FAST_MODEL'] || 'claude-sonnet-4-20250514',
        ]);
        return [...models].filter(Boolean);
    }

    private positiveInt(value: string | undefined, fallback: number): number {
        const parsed = Number.parseInt(value ?? '', 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }
}
