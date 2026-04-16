import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import type { AIProvider, AICompletionRequest, AICompletionResponse, AIProviderKind } from '../../../types/index.js';
import { logger } from '../../../utils/logger.js';
import { RateLimiter } from '../../../utils/RateLimiter.js';

export class GeminiProvider implements AIProvider {
    readonly kind: AIProviderKind = 'gemini';
    private genAI: GoogleGenerativeAI;
    private model: GenerativeModel;
    private modelName: string;
    private limiter: RateLimiter;

    constructor(apiKey: string, model = 'gemini-1.5-pro') {
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.modelName = model;
        this.model = this.genAI.getGenerativeModel({ model });
        
        // Gemini Free Tier Limits (Approx ~15 RPM natively, we throttle below to be safe)
        this.limiter = new RateLimiter({
            maxConcurrency: 2,
            requestsPerMinute: 14,
            delayBetweenRequestsMs: 1000
        });
    }

    async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
        return this.limiter.execute(async () => {
            const modelName = request.model ?? this.modelName;
            let currentModel = this.model;
            if (modelName !== this.modelName) {
                currentModel = this.genAI.getGenerativeModel({ model: modelName });
            }

            try {
                const prompt = `${request.systemPrompt}\n\n${request.userPrompt}`;
                const result = await currentModel.generateContent({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: request.temperature ?? 0.2,
                        maxOutputTokens: request.maxTokens ?? 4096,
                    },
                });

                const response: any = await result.response;
                const content = response.text();

                return {
                    content,
                    model: modelName,
                    usage: {
                        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
                        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
                    },
                    provider: this.kind,
                };
            } catch (err) {
                logger.error('Gemini completion failed', { error: String(err) });
                throw err; // Orchestrator handles top-level user reporting
            }
        });
    }

    async listModels(): Promise<string[]> {
        try {
            const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${this.genAI.apiKey}`);
            if (!resp.ok) return [];
            const data = await resp.json() as any;
            if (data && data.models) {
                // Filter only models that support generateContent
                const valid = data.models
                    .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
                    .map((m: any) => m.name.replace('models/', ''));
                return valid.length > 0 ? valid : ['gemini-2.5-pro', 'gemini-2.5-flash'];
            }
            return [];
        } catch {
            return [];
        }
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
            
            // Gemini batch limit is 100 per call
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
                    // Provide empty arrays to gracefully skip missing chunks instead of crashing the scan
                    for (let j = 0; j < chunk.length; j++) {
                        results.push([]);
                    }
                }
                // Slight delay to be safe with rate limits during bulk scan
                if (i + chunkSize < texts.length) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }
            return results;
        } catch (err) {
            logger.error('Gemini batch embedding failed', { error: String(err) });
            throw new Error(`Gemini batch embedding failed: ${String(err)}`);
        }
    }

    async isAvailable(): Promise<boolean> {
        try {
            // Short, cheap probe to verify key and connection
            const result = await this.model.generateContent({
                contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
                generationConfig: { maxOutputTokens: 5 }
            });
            const response = await result.response;
            return !!response.text();
        } catch (err: any) {
            const msg = err.message || String(err);
            if (msg.toLowerCase().includes('expired') || msg.toLowerCase().includes('key')) {
                logger.warn(`Gemini API Key validation failed: ${msg}`);
            }
            return false;
        }
    }
}