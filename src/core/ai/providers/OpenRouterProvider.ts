import type { AIProvider, ModelRequest, ModelResponse, AIProviderKind } from '../../../types/index.js';
import { logger } from '../../../utils/logger.js';
import { RateLimiter } from '../../../utils/RateLimiter.js';

export class OpenRouterProvider implements AIProvider {
    readonly kind: AIProviderKind = 'openrouter';
    private baseURL = 'https://openrouter.ai/api/v1';
    private defaultModel: string;
    private limiter: RateLimiter;

    constructor(private apiKey: string, model = 'anthropic/claude-3-5-sonnet') {
        this.defaultModel = model;
        this.limiter = new RateLimiter({
            maxConcurrency: 5,
            requestsPerMinute: 60,
            delayBetweenRequestsMs: 100
        });
    }

    async execute(request: ModelRequest): Promise<ModelResponse> {
        return this.limiter.execute(async () => {
            const model = request.modelOverride ?? this.defaultModel;
            const messages = this.normalizeMessages(request.systemPrompt ?? '', request.context, model);

            const body = {
                model,
                messages,
                temperature: request.temperature ?? 0.2,
                max_tokens: request.maxTokens,
            };

            try {
                const response = await fetch(`${this.baseURL}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': 'https://github.com/codebase-os/cos',
                        'X-Title': 'Codebase OS',
                    },
                    body: JSON.stringify(body),
                });

                if (!response.ok) {
                    const text = await response.text();
                    throw new Error(`OpenRouter API error ${response.status}: ${text}`);
                }

                const data = await response.json() as any;
                return {
                    content: data.choices[0]?.message?.content ?? '',
                    usage: {
                        promptTokens: data.usage?.prompt_tokens ?? 0,
                        outputTokens: data.usage?.completion_tokens ?? 0,
                        totalTokens: data.usage?.total_tokens ?? 0,
                    },
                    provider: this.kind,
                    model: data.model ?? model,
                };
            } catch (err) {
                logger.error('OpenRouter execution failed', { error: String(err) });
                throw err;
            }
        });
    }

    private normalizeMessages(system: string, user: string, model: string): Array<{ role: string, content: string }> {
        const isFree = model.endsWith(':free');
        const isGemma = model.includes('gemma');
        
        if (isFree || isGemma) {
            return [
                { 
                    role: 'user', 
                    content: `[DEVELOPER INSTRUCTIONS]\n${system}\n\n[USER REQUEST]\n${user}` 
                }
            ];
        }

        return [
            { role: 'system', content: system },
            { role: 'user', content: user }
        ];
    }

    async isAvailable(): Promise<boolean> {
        try {
            const resp = await fetch(`${this.baseURL}/models`, {
                headers: { Authorization: `Bearer ${this.apiKey}` },
            });
            return resp.ok;
        } catch { return false; }
    }

    async embed(text: string): Promise<number[]> {
        return this.limiter.execute(async () => {
            const response = await fetch(`${this.baseURL}/embeddings`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'openai/text-embedding-3-small',
                    input: text,
                }),
            });
            if (!response.ok) return [];
            const data = await response.json() as any;
            return data.data[0].embedding;
        });
    }

    async batchEmbed(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];
        return this.limiter.execute(async () => {
            const response = await fetch(`${this.baseURL}/embeddings`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'openai/text-embedding-3-small',
                    input: texts,
                }),
            });
            if (!response.ok) return texts.map(() => []);
            const data = await response.json() as any;
            return data.data.map((d: any) => d.embedding);
        });
    }

    async listModels(): Promise<string[]> {
        try {
            const resp = await fetch(`${this.baseURL}/models`, {
                headers: { 
                    Authorization: `Bearer ${this.apiKey}`,
                    'HTTP-Referer': 'https://github.com/codebase-os/cos',
                    'X-Title': 'Codebase OS'
                },
            });
            if (resp.ok) {
                const data = await resp.json() as any;
                if (data.data?.length > 0) {
                    return data.data.map((m: any) => m.id);
                }
            }
        } catch (err) {
            logger.error('Failed to fetch OpenRouter models', { error: String(err) });
        }
        
        return [
            'anthropic/claude-3-5-sonnet',
            'openai/gpt-4o',
            'google/gemini-pro-1.5',
            'meta-llama/llama-3.1-405b',
            'mistralai/mistral-large-2'
        ];
    }
}