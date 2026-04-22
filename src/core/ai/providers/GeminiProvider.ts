import { GoogleGenerativeAI } from '@google/generative-ai';
import type { AIProvider, ModelRequest, ModelResponse, AIProviderKind } from '../../../types/index.js';
import { logger } from '../../../utils/logger.js';
import { RateLimiter } from '../../../utils/RateLimiter.js';
import { classifyProviderError } from './ProviderError.js';

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1500;

export class GeminiProvider implements AIProvider {
    readonly kind: AIProviderKind = 'gemini';
    private genAI: GoogleGenerativeAI;
    private modelName: string;
    private limiter: RateLimiter;

    constructor(apiKey: string, model = 'gemini-1.5-pro') {
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.modelName = model;

        // RPM is configurable. Free tier = 15 RPM. Paid tier can be 1000+.
        // Default to 50 (Gemini API standard tier). Override via GEMINI_RPM env.
        const rpm = parseInt(process.env['GEMINI_RPM'] ?? '50', 10);
        this.limiter = new RateLimiter({
            maxConcurrency: 3,
            requestsPerMinute: rpm,
            delayBetweenRequestsMs: Math.ceil(60_000 / rpm),
            circuitBreakerThreshold: 5,
            circuitBreakerCooldownMs: 60_000,
            maxQueueSize: 100,
            label: 'gemini',
        });
    }

    async execute(request: ModelRequest): Promise<ModelResponse> {
        return this.limiter.execute(async () => {
            return RateLimiter.withRetry(
                () => this.callAPI(request),
                MAX_RETRIES,
                BASE_DELAY_MS,
                'gemini.execute'
            );
        });
    }

    private async callAPI(request: ModelRequest): Promise<ModelResponse> {
        const modelName = request.modelOverride ?? this.modelName;
        const currentModel = this.genAI.getGenerativeModel({ model: modelName });

        try {
            const promptParts: Array<{ text: string }> = [];
            if (request.systemPrompt) {
                promptParts.push({ text: `System: ${request.systemPrompt}\n\n` });
            }
            promptParts.push({ text: request.context });

            const result = await currentModel.generateContent({
                contents: [{ role: 'user', parts: promptParts }],
                generationConfig: {
                    temperature: request.temperature ?? 0.2,
                    maxOutputTokens: request.maxTokens ?? 4096,
                },
            });

            const response = await result.response;
            const content = response.text();

            return {
                content,
                usage: {
                    promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
                    outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
                    totalTokens: response.usageMetadata?.totalTokenCount ?? 0,
                },
                provider: this.kind,
                model: modelName,
            };
        } catch (err) {
            const classified = classifyProviderError(err, 'gemini');
            logger.error('Gemini call failed', {
                code: classified.code,
                model: modelName,
                retryable: classified.isRetryable,
                error: classified.message,
            });
            throw classified;
        }
    }

    async embed(text: string): Promise<number[]> {
        return this.limiter.execute(async () => {
            try {
                const embedModel = this.genAI.getGenerativeModel({ model: 'text-embedding-004' });
                const result = await embedModel.embedContent(text);
                return result.embedding.values;
            } catch (err) {
                const classified = classifyProviderError(err, 'gemini-embed');
                logger.error('Gemini embedding failed', { error: classified.message });
                throw classified;
            }
        });
    }

    async batchEmbed(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];

        const embedModel = this.genAI.getGenerativeModel({ model: 'text-embedding-004' });
        const results: number[][] = [];
        const chunkSize = 100;

        for (let i = 0; i < texts.length; i += chunkSize) {
            const chunk = texts.slice(i, i + chunkSize);
            try {
                const batchResult = await this.limiter.execute(() =>
                    embedModel.batchEmbedContents({
                        requests: chunk.map(text => ({
                            content: { role: 'user', parts: [{ text }] },
                            taskType: 'RETRIEVAL_DOCUMENT' as any,
                        })),
                    })
                );
                results.push(...batchResult.embeddings.map(e => e.values));
            } catch (err) {
                const classified = classifyProviderError(err, 'gemini-batch-embed');
                logger.warn(`Gemini batch embed failed for chunk starting at ${i}`, {
                    code: classified.code,
                    error: classified.message,
                });
                // Fill missing embeddings with empty arrays to preserve index alignment
                for (let j = 0; j < chunk.length; j++) results.push([]);
            }

            // Steady drip between chunks to respect rate limits
            if (i + chunkSize < texts.length) {
                await new Promise(r => setTimeout(r, Math.ceil(60_000 / (parseInt(process.env['GEMINI_RPM'] ?? '50', 10)))));
            }
        }

        return results;
    }

    async isAvailable(): Promise<boolean> {
        try {
            const model = this.genAI.getGenerativeModel({ model: this.modelName });
            const result = await model.generateContent({
                contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
                generationConfig: { maxOutputTokens: 5 },
            });
            const response = await result.response;
            return !!response.text();
        } catch (err) {
            const classified = classifyProviderError(err, 'gemini');
            if (classified.code === 'AUTH_ERROR') {
                logger.warn('Gemini: Invalid API key');
            }
            return false;
        }
    }

    async listModels(): Promise<string[]> {
        return [
            'gemini-1.5-pro',
            'gemini-1.5-flash',
            'gemini-2.0-flash',
            'gemini-2.5-pro',
            'gemini-1.0-pro',
        ];
    }
}