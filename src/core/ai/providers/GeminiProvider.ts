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

    constructor(private apiKey: string, model = 'gemini-3.5-flash') {
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.modelName = model;

        const rpm = this.positiveInt(process.env['GEMINI_RPM'], 50);
        this.limiter = new RateLimiter({
            maxConcurrency: Math.min(3, this.positiveInt(process.env['GEMINI_MAX_CONCURRENCY'], 3)),
            requestsPerMinute: rpm,
            delayBetweenRequestsMs: Math.ceil(60_000 / rpm),
            circuitBreakerThreshold: 5,
            circuitBreakerCooldownMs: 60_000,
            maxQueueSize: 100,
            label: 'gemini',
        });
    }

    async execute(request: ModelRequest): Promise<ModelResponse> {
        return this.limiter.execute(async () =>
            RateLimiter.withRetry(
                () => this.callAPI(request),
                MAX_RETRIES,
                BASE_DELAY_MS,
                'gemini.execute',
            ),
        );
    }

    private async callAPI(request: ModelRequest): Promise<ModelResponse> {
        const modelName = request.modelOverride ?? this.modelName;
        const currentModel = this.genAI.getGenerativeModel({ model: modelName });

        try {
            const promptParts: Array<{ text: string }> = [];
            if (request.systemPrompt) {
                promptParts.push({ text: `SYSTEM INSTRUCTIONS:\n${request.systemPrompt}\n\n` });
            }
            promptParts.push({ text: request.context });

            // Gemini 3.x stable models no longer require the legacy sampling
            // controls used by the older 1.x integration. Keep the request to
            // universally supported generation parameters.
            const result = await currentModel.generateContent({
                contents: [{ role: 'user', parts: promptParts }],
                generationConfig: {
                    maxOutputTokens: request.maxTokens ?? 4096,
                },
            });

            const response = await result.response;
            const content = response.text();
            if (!content.trim()) {
                throw new Error('Gemini returned an empty text response.');
            }

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
                const embedModel = this.genAI.getGenerativeModel({
                    model: process.env['GEMINI_EMBEDDING_MODEL'] || 'gemini-embedding-2',
                });
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

        const embeddingModel = process.env['GEMINI_EMBEDDING_MODEL'] || 'gemini-embedding-2';
        const embedModel = this.genAI.getGenerativeModel({ model: embeddingModel });
        const results: number[][] = [];
        const chunkSize = 100;

        for (let offset = 0; offset < texts.length; offset += chunkSize) {
            const chunk = texts.slice(offset, offset + chunkSize);
            try {
                const batchResult = await this.limiter.execute(() =>
                    embedModel.batchEmbedContents({
                        requests: chunk.map(text => ({
                            content: { role: 'user', parts: [{ text }] },
                            taskType: 'RETRIEVAL_DOCUMENT' as any,
                        })),
                    }),
                );
                results.push(...batchResult.embeddings.map(embedding => embedding.values));
            } catch (err) {
                const classified = classifyProviderError(err, 'gemini-batch-embed');
                logger.warn(`Gemini batch embed failed for chunk starting at ${offset}`, {
                    code: classified.code,
                    error: classified.message,
                });
                // Preserve input/output alignment; EmbeddingIndex rejects empty
                // vectors instead of silently persisting them.
                for (let index = 0; index < chunk.length; index++) results.push([]);
            }

            if (offset + chunkSize < texts.length) {
                const rpm = this.positiveInt(process.env['GEMINI_RPM'], 50);
                await new Promise(resolve => setTimeout(resolve, Math.ceil(60_000 / rpm)));
            }
        }

        return results;
    }

    async isAvailable(): Promise<boolean> {
        if (!this.apiKey.trim()) return false;
        try {
            const models = await this.listModels();
            return models.some(model => model === this.modelName || model.endsWith(`/${this.modelName}`));
        } catch (err) {
            const classified = classifyProviderError(err, 'gemini');
            if (classified.code === 'AUTH_ERROR') logger.warn('Gemini: invalid API key');
            return false;
        }
    }

    async listModels(): Promise<string[]> {
        if (!this.apiKey.trim()) return [];
        try {
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(this.apiKey)}`,
            );
            const payload = await response.json() as {
                models?: Array<{
                    name?: string;
                    baseModelId?: string;
                    supportedGenerationMethods?: string[];
                }>;
                error?: { message?: string };
            };
            if (!response.ok) {
                const error = new Error(payload.error?.message || `Gemini model list returned HTTP ${response.status}`) as Error & { status?: number };
                error.status = response.status;
                throw error;
            }

            return (payload.models ?? [])
                .filter(model => model.supportedGenerationMethods?.includes('generateContent'))
                .map(model => model.baseModelId || model.name?.replace(/^models\//, '') || '')
                .filter(Boolean)
                .sort();
        } catch (err) {
            logger.debug('Gemini: model discovery failed', { error: String(err) });
            return [this.modelName];
        }
    }

    private positiveInt(value: string | undefined, fallback: number): number {
        const parsed = Number.parseInt(value ?? '', 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }
}
