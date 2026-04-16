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
        // OpenRouter acts as a proxy, so we enforce a generous pooled limit
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

        const body = {
            model,
            messages: [
                { role: 'system', content: request.systemPrompt },
                { role: 'user', content: request.userPrompt },
            ],
            temperature: request.temperature ?? 0.2,
            max_tokens: request.maxTokens ?? 4096,
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
                            } catch {
                                // Skip malformed chunks
                            }
                        }
                    }
                }

                return {
                    content: fullContent,
                    model,
                    usage: { inputTokens: 0, outputTokens: 0 }, // Usage often not sent in stream until end
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
        } catch {
            return false;
        }
    }
}