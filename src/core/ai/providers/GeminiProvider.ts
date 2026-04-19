import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import type { AIProvider, ModelRequest, ModelResponse, AIProviderKind } from '../../../types/index.js';
import { logger } from '../../../utils/logger.js';
import { RateLimiter } from '../../../utils/RateLimiter.js';

export class GeminiProvider implements AIProvider {
    readonly kind: AIProviderKind = 'gemini';
    private genAI: GoogleGenerativeAI;
    private modelName: string;
    private limiter: RateLimiter;

    constructor(apiKey: string, model = 'gemini-1.5-pro') {
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.modelName = model;
        
        this.limiter = new RateLimiter({
            maxConcurrency: 2,
            requestsPerMinute: 14,
            delayBetweenRequestsMs: 1000
        });
    }

    async execute(request: ModelRequest): Promise<ModelResponse> {
        return this.limiter.execute(async () => {
            const modelName = request.modelOverride ?? this.modelName;
            const currentModel = this.genAI.getGenerativeModel({ model: modelName });

            try {
                const promptParts = [];
                if (request.systemPrompt) {
                    promptParts.push({ text: `System: ${request.systemPrompt}\n\n` });
                }
                promptParts.push({ text: request.context });

                const result = await currentModel.generateContent({
                    contents: [{ role: 'user', parts: promptParts }],
                    generationConfig: {
                        temperature: request.temperature ?? 0.2,
                        maxOutputTokens: request.maxTokens,
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
                logger.error('Gemini execution failed', { error: String(err) });
                throw err;
            }
        });
    }

    async embed(text: string): Promise<number[]> {
        return this.limiter.execute(async () => {
            const embedModel = this.genAI.getGenerativeModel({ model: 'text-embedding-004' });
            const result = await embedModel.embedContent(text);
            return result.embedding.values;
        });
    }

    async batchEmbed(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];

        try {
            const embedModel = this.genAI.getGenerativeModel({ model: 'text-embedding-004' });
            const results: number[][] = [];
            const chunkSize = 100;

            for (let i = 0; i < texts.length; i += chunkSize) {
                const chunk = texts.slice(i, i + chunkSize);
                try {
                    const batchResult = await this.limiter.execute(() => embedModel.batchEmbedContents({
                        requests: chunk.map(text => ({ 
                            content: { role: 'user', parts: [{ text }] },
                            taskType: 'RETRIEVAL_DOCUMENT' as any
                        }))
                    }));
                    results.push(...batchResult.embeddings.map(e => e.values));
                } catch (innerErr) {
                    logger.warn(`Batch embedding failed for chunk ${i}`, { error: String(innerErr) });
                    for (let j = 0; j < chunk.length; j++) results.push([]);
                }
                if (i + chunkSize < texts.length) await new Promise(r => setTimeout(r, 500));
            }
            return results;
        } catch (err) {
            logger.error('Gemini batch embedding failed', { error: String(err) });
            throw new Error(`Gemini batch embedding failed: ${String(err)}`);
        }
    }

    async isAvailable(): Promise<boolean> {
        try {
            const model = this.genAI.getGenerativeModel({ model: this.modelName });
            const result = await model.generateContent({
                contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
                generationConfig: { maxOutputTokens: 5 }
            });
            const response = await result.response;
            return !!response.text();
        } catch {
            return false;
        }
    }

    async listModels(): Promise<string[]> {
        return [
            'gemini-1.5-pro',
            'gemini-1.5-flash',
            'gemini-1.0-pro'
        ];
    }
}