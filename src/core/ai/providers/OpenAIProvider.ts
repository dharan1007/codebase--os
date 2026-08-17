import OpenAI from 'openai';
import type { AIProvider, ModelRequest, ModelResponse, AIProviderKind } from '../../../types/index.js';
import { logger } from '../../../utils/logger.js';
import { RateLimiter } from '../../../utils/RateLimiter.js';
import { classifyProviderError } from './ProviderError.js';

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1000;

interface ResponsesApiPayload {
    output?: Array<{
        type?: string;
        content?: Array<{ type?: string; text?: string }>;
    }>;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
    };
    model?: string;
    error?: { message?: string } | null;
    status?: string;
}

export class OpenAIProvider implements AIProvider {
    readonly kind: AIProviderKind = 'openai';
    private client: OpenAI;
    private defaultModel: string;
    private limiter: RateLimiter;

    constructor(private apiKey: string, model = 'gpt-5.6') {
        this.client = new OpenAI({
            apiKey,
            timeout: 300_000,
        });
        this.defaultModel = model;

        const rpm = this.positiveInt(process.env['OPENAI_RPM'], 50);
        this.limiter = new RateLimiter({
            maxConcurrency: Math.min(5, this.positiveInt(process.env['OPENAI_MAX_CONCURRENCY'], 5)),
            requestsPerMinute: rpm,
            delayBetweenRequestsMs: Math.ceil(60_000 / rpm),
            circuitBreakerThreshold: 5,
            circuitBreakerCooldownMs: 60_000,
            maxQueueSize: 200,
            label: 'openai',
        });
    }

    async execute(request: ModelRequest): Promise<ModelResponse> {
        return this.limiter.execute(async () =>
            RateLimiter.withRetry(
                () => this.callResponsesAPI(request),
                MAX_RETRIES,
                BASE_DELAY_MS,
                'openai.execute',
            ),
        );
    }

    /**
     * Uses the provider's current Responses endpoint directly. This keeps the
     * runtime compatible with current OpenAI reasoning models without forcing a
     * package-lock migration solely to expose a newer SDK convenience method.
     */
    private async callResponsesAPI(request: ModelRequest): Promise<ModelResponse> {
        const model = request.modelOverride ?? this.defaultModel;
        try {
            const body: Record<string, unknown> = {
                model,
                input: request.context,
                instructions: request.systemPrompt ?? 'You are a precise software engineering assistant.',
                max_output_tokens: request.maxTokens ?? 4096,
                store: false,
            };

            const signal = (request as any).signal as AbortSignal | undefined;
            const response = await fetch('https://api.openai.com/v1/responses', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                signal,
            });

            const payload = await response.json() as ResponsesApiPayload;
            if (!response.ok) {
                const error = new Error(
                    payload.error?.message || `OpenAI Responses API returned HTTP ${response.status}`,
                ) as Error & { status?: number };
                error.status = response.status;
                throw error;
            }

            const content = (payload.output ?? [])
                .filter(item => item.type === 'message' || Array.isArray(item.content))
                .flatMap(item => item.content ?? [])
                .filter(part => part.type === 'output_text' && typeof part.text === 'string')
                .map(part => part.text!)
                .join('');

            if (!content.trim()) {
                throw new Error(
                    `OpenAI response completed without output text (status=${payload.status ?? 'unknown'}).`,
                );
            }

            return {
                content,
                usage: {
                    promptTokens: payload.usage?.input_tokens ?? 0,
                    outputTokens: payload.usage?.output_tokens ?? 0,
                    totalTokens:
                        payload.usage?.total_tokens ??
                        (payload.usage?.input_tokens ?? 0) + (payload.usage?.output_tokens ?? 0),
                },
                provider: this.kind,
                model: payload.model ?? model,
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
            const ids = response?.data?.map(model => model.id).filter(Boolean) ?? [];
            if (ids.length > 0) return ids.sort();
        } catch (err) {
            logger.debug('OpenAI: model discovery failed', { error: String(err) });
        }
        return [this.defaultModel];
    }

    async isAvailable(): Promise<boolean> {
        if (!this.apiKey.trim()) return false;
        try {
            const models = await this.listModels();
            return models.length > 0;
        } catch (err) {
            const classified = classifyProviderError(err, 'openai');
            if (classified.code === 'AUTH_ERROR') logger.warn('OpenAI: invalid API key');
            return false;
        }
    }

    async embed(text: string): Promise<number[]> {
        return this.limiter.execute(async () => {
            try {
                const response = await this.client.embeddings.create({
                    model: process.env['OPENAI_EMBEDDING_MODEL'] || 'text-embedding-3-small',
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
                    model: process.env['OPENAI_EMBEDDING_MODEL'] || 'text-embedding-3-small',
                    input: texts,
                });
                return response.data.map(item => item.embedding);
            } catch (err) {
                throw classifyProviderError(err, 'openai-batch-embed');
            }
        });
    }

    private positiveInt(value: string | undefined, fallback: number): number {
        const parsed = Number.parseInt(value ?? '', 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }
}
