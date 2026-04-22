import type { AIProvider, ModelRequest, ModelResponse, AIProviderKind } from '../../../types/index.js';
import { logger } from '../../../utils/logger.js';
import { RateLimiter } from '../../../utils/RateLimiter.js';
import { classifyProviderError, ProviderError } from './ProviderError.js';

const MAX_RETRIES = 1;
const BASE_DELAY_MS = 1000;

export class OpenRouterProvider implements AIProvider {
    readonly kind: AIProviderKind = 'openrouter';
    private readonly baseURL = 'https://openrouter.ai/api/v1';
    private defaultModel: string;
    private limiter: RateLimiter;

    constructor(private apiKey: string, model = 'anthropic/claude-3-5-sonnet') {
        this.defaultModel = model;
        const rpm = parseInt(process.env['OPENROUTER_RPM'] ?? '60', 10);
        this.limiter = new RateLimiter({
            maxConcurrency: 5,
            requestsPerMinute: rpm,
            delayBetweenRequestsMs: Math.ceil(60_000 / rpm),
            circuitBreakerThreshold: 5,
            circuitBreakerCooldownMs: 60_000,
            maxQueueSize: 200,
            label: 'openrouter',
        });
    }

    async execute(request: ModelRequest): Promise<ModelResponse> {
        return this.limiter.execute(async () => {
            return RateLimiter.withRetry(
                () => this.callAPI(request),
                MAX_RETRIES,
                BASE_DELAY_MS,
                'openrouter.execute'
            );
        });
    }

    private async callAPI(request: ModelRequest): Promise<ModelResponse> {
        const model = request.modelOverride ?? this.defaultModel;
        const messages = this.normalizeMessages(request.systemPrompt ?? '', request.context, model);

        let response: Response;
        try {
            response = await fetch(`${this.baseURL}/chat/completions`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://github.com/codebase-os/cos',
                    'X-Title': 'Codebase OS',
                },
                body: JSON.stringify({
                    model,
                    messages,
                    temperature: request.temperature ?? 0.2,
                    max_tokens: request.maxTokens ?? 4096,
                }),
            });
        } catch (err) {
            throw classifyProviderError(err, 'openrouter');
        }

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            // Synthesize an error object with status for the classifier
            const syntheticErr = Object.assign(new Error(`OpenRouter HTTP ${response.status}: ${text}`), {
                status: response.status,
            });
            const classified = classifyProviderError(syntheticErr, 'openrouter');
            logger.error('OpenRouter call failed', {
                code: classified.code,
                status: response.status,
                model,
                retryable: classified.isRetryable,
            });
            throw classified;
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
    }

    private normalizeMessages(system: string, user: string, model: string): Array<{ role: string; content: string }> {
        // Some free/open-source models on OpenRouter don't support system role
        const isFree = model.endsWith(':free');
        const isGemma = model.includes('gemma');

        if (isFree || isGemma) {
            return [{ role: 'user', content: `[DEVELOPER INSTRUCTIONS]\n${system}\n\n[USER REQUEST]\n${user}` }];
        }
        return [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ];
    }

    async isAvailable(): Promise<boolean> {
        try {
            const resp = await fetch(`${this.baseURL}/models`, {
                headers: { Authorization: `Bearer ${this.apiKey}` },
            });
            return resp.ok;
        } catch {
            return false;
        }
    }

    async embed(text: string): Promise<number[]> {
        return this.limiter.execute(async () => {
            try {
                const response = await fetch(`${this.baseURL}/embeddings`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ model: 'openai/text-embedding-3-small', input: text }),
                });
                if (!response.ok) return [];
                const data = await response.json() as any;
                return data.data[0].embedding;
            } catch {
                return [];
            }
        });
    }

    async batchEmbed(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];
        return this.limiter.execute(async () => {
            try {
                const response = await fetch(`${this.baseURL}/embeddings`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ model: 'openai/text-embedding-3-small', input: texts }),
                });
                if (!response.ok) return texts.map(() => []);
                const data = await response.json() as any;
                return data.data.map((d: any) => d.embedding);
            } catch {
                return texts.map(() => []);
            }
        });
    }

    async listModels(): Promise<string[]> {
        try {
            const resp = await fetch(`${this.baseURL}/models`, {
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'HTTP-Referer': 'https://github.com/codebase-os/cos',
                    'X-Title': 'Codebase OS',
                },
            });
            if (resp.ok) {
                const data = await resp.json() as any;
                if (data.data?.length > 0) return data.data.map((m: any) => m.id);
            }
        } catch (err) {
            logger.debug('OpenRouter: Failed to fetch model list', { error: String(err) });
        }
        return [
            'anthropic/claude-3-5-sonnet',
            'openai/gpt-4o',
            'google/gemini-pro-1.5',
            'meta-llama/llama-3.1-405b',
            'mistralai/mistral-large-2',
        ];
    }
}