import type { AIProvider, AICompletionRequest, AICompletionResponse, AIProviderKind } from '../../../types/index.js';
import { logger } from '../../../utils/logger.js';
import { RateLimiter } from '../../../utils/RateLimiter.js';

export class OpenRouterProvider implements AIProvider {
    readonly kind: AIProviderKind = 'openrouter';
    private baseURL = 'https://openrouter.ai/api/v1';
    private defaultModel: string;
    private limiter: RateLimiter;

    constructor(private apiKey: string, model = 'anthropic/claude-3.5-sonnet') {
        this.defaultModel = model;
        this.limiter = new RateLimiter({
            maxConcurrency: 5,
            requestsPerMinute: 60,
            delayBetweenRequestsMs: 100
        });
    }

    async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
        return this.internalComplete(request, false);
    }

    async completeStream(request: AICompletionRequest, onToken: (token: string) => void): Promise<AICompletionResponse> {
        return this.internalComplete(request, true, onToken);
    }

    private async internalComplete(
        request: AICompletionRequest, 
        stream: boolean, 
        onToken?: (token: string) => void
    ): Promise<AICompletionResponse> {
        return this.limiter.execute(async () => {
        const model = request.model ?? this.defaultModel;

        // [ARCHITECTURAL HARDENING]: Role Normalization (Fix for error 400)
        // Many free models (especially Google AI Studio proxied through OpenRouter) 
        // DO NOT support the 'system' role. We normalize by merging it into the first user message.
        const messages = this.normalizeMessages(request.systemPrompt, request.userPrompt, model);

        const body = {
            model,
            messages,
            temperature: request.temperature ?? 0.2,
            max_tokens: request.maxTokens ?? 3000,
            stream
        };

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 300000);

            const response = await fetch(`${this.baseURL}/chat/completions`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://github.com/codebase-os/cos',
                    'X-Title': 'Codebase OS',
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const text = await response.text();
                if (response.status === 402) {
                    throw new Error(`OpenRouter Credit Error: Your balance is too low for this request (requested ${body.max_tokens} tokens).`);
                }
                throw new Error(`OpenRouter API error ${response.status}: ${text}`);
            }

            if (stream && response.body) {
                let fullContent = '';
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\n');
                    
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.slice(6).trim();
                            if (dataStr === '[DONE]') break;
                            try {
                                const data = JSON.parse(dataStr);
                                const token = data.choices[0]?.delta?.content ?? '';
                                if (token) {
                                    fullContent += token;
                                    onToken?.(token);
                                }
                            } catch { }
                        }
                    }
                }

                return {
                    content: fullContent,
                    model,
                    usage: { inputTokens: 0, outputTokens: 0 },
                    provider: this.kind,
                };
            }

            const data = await response.json() as any;
            return {
                content: data.choices[0]?.message?.content ?? '',
                model: data.model ?? model,
                usage: {
                    inputTokens: data.usage?.prompt_tokens ?? 0,
                    outputTokens: data.usage?.completion_tokens ?? 0,
                },
                provider: this.kind,
            };
        } catch (err) {
            logger.error('OpenRouter completion failed', { error: String(err) });
            throw err;
        }
        });
    }

    /**
     * Normalizes system/user prompts into a format acceptable by the specific model.
     * Prevents "Developer instruction not enabled" (400) errors.
     */
    private normalizeMessages(system: string, user: string, model: string): Array<{ role: string, content: string }> {
        // [HEURISTIC]: Most free tier models and Gemma variants prefer combined prompts.
        // To ensure 100% compatibility across the diverse OpenRouter pool, 
        // we use a combined "Developer Instruction" preamble in the user role.
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

        // Standard role support for high-end models (Claude/GPT)
        return [
            { role: 'system', content: system },
            { role: 'user', content: user }
        ];
    }

    async listModels(): Promise<string[]> {
        try {
            const response = await fetch(`${this.baseURL}/models`, {
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'HTTP-Referer': 'https://github.com/codebase-os/cos',
                    'X-Title': 'Codebase OS',
                },
            });
            if (!response.ok) return [];
            const data = await response.json() as { data: Array<{ id: string }> };
            return data.data.map(m => m.id);
        } catch (err) {
            logger.error('Failed to fetch OpenRouter models', { error: String(err) });
            return [];
        }
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
}