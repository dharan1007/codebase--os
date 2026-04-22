import OpenAI from 'openai';
import type { AIProvider, ModelRequest, ModelResponse, AIProviderKind } from '../../../types/index.js';
import { logger } from '../../../utils/logger.js';
import { RateLimiter } from '../../../utils/RateLimiter.js';
import { classifyProviderError } from './ProviderError.js';

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1000;

export class OpenAIProvider implements AIProvider {
    readonly kind: AIProviderKind = 'openai';
    private client: OpenAI;
    private defaultModel: string;
    private limiter: RateLimiter;

    constructor(apiKey: string, model = 'gpt-4o') {
        this.client = new OpenAI({
            apiKey,
            timeout: 300_000,
        });
        this.defaultModel = model;

        const rpm = parseInt(process.env['OPENAI_RPM'] ?? '500', 10);
        this.limiter = new RateLimiter({
            maxConcurrency: 5,
            requestsPerMinute: rpm,
            delayBetweenRequestsMs: Math.ceil(60_000 / rpm),
            circuitBreakerThreshold: 5,
            circuitBreakerCooldownMs: 60_000,
            maxQueueSize: 200,
            label: 'openai',
        });
    }

    async execute(request: ModelRequest): Promise<ModelResponse> {
        return this.limiter.execute(async () => {
            return RateLimiter.withRetry(
                () => this.callAPI(request),
                MAX_RETRIES,
                BASE_DELAY_MS,
                'openai.execute'
            );
        });
    }

    private async callAPI(request: ModelRequest): Promise<ModelResponse> {
        const model = request.modelOverride ?? this.defaultModel;
        try {
            const response = await this.client.chat.completions.create({
                model,
                messages: [
                    { role: 'system', content: request.systemPrompt ?? 'You are a helpful assistant.' },
                    { role: 'user', content: request.context },
                ],
                temperature: request.temperature ?? 0.2,
                max_tokens: request.maxTokens ?? 4096,
            });

            const content = response.choices[0]?.message?.content ?? '';
            return {
                content,
                usage: {
                    promptTokens: response.usage?.prompt_tokens ?? 0,
                    outputTokens: response.usage?.completion_tokens ?? 0,
                    totalTokens: response.usage?.total_tokens ?? 0,
                },
                provider: this.kind,
                model,
            };
        } catch (err) {
            const classified = classifyProviderError(err, 'openai');
            logger.error('OpenAI call failed', {
                code: classified.code,
                model,
                retryable: classified.isRetryable,
                error: classified.message,
            });
            throw classified;
        }
    }

    async listModels(): Promise<string[]> {
        try {
            const response = await this.client.models.list();
            if (response?.data?.length > 0) {
                return response.data.map(m => m.id);
            }
        } catch (err) {
            logger.debug('OpenAI: Failed to fetch model list', { error: String(err) });
        }
        return ['gpt-4o', 'gpt-4o-mini', 'o1-preview', 'o1-mini', 'o3-mini'];
    }

    async isAvailable(): Promise<boolean> {
        try {
            await this.client.models.list();
            return true;
        } catch (err) {
            const classified = classifyProviderError(err, 'openai');
            if (classified.code === 'AUTH_ERROR') {
                logger.warn('OpenAI: Invalid API key');
            }
            return false;
        }
    }

    async embed(text: string): Promise<number[]> {
        return this.limiter.execute(async () => {
            try {
                const response = await this.client.embeddings.create({
                    model: 'text-embedding-3-small',
                    input: text,
                });
                return response.data[0]!.embedding;
            } catch (err) {
                throw classifyProviderError(err, 'openai-embed');
            }
        });
    }

    async batchEmbed(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];
        return this.limiter.execute(async () => {
            try {
                const response = await this.client.embeddings.create({
                    model: 'text-embedding-3-small',
                    input: texts,
                });
                return response.data.map(d => d.embedding);
            } catch (err) {
                throw classifyProviderError(err, 'openai-batch-embed');
            }
        });
    }
}