import type { AIProvider, AICompletionRequest, AICompletionResponse, AIProviderKind } from '../../../types/index.js';
import { logger } from '../../../utils/logger.js';

export class OpenRouterProvider implements AIProvider {
    readonly kind: AIProviderKind = 'openrouter';
    private baseURL = 'https://openrouter.ai/api/v1';
    private defaultModel: string;

    constructor(private apiKey: string, model = 'anthropic/claude-3.5-sonnet') {
        this.defaultModel = model;
    }

    async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
        const model = request.model ?? this.defaultModel;

        const body = {
            model,
            messages: [
                { role: 'system', content: request.systemPrompt },
                { role: 'user', content: request.userPrompt },
            ],
            temperature: request.temperature ?? 0.2,
            max_tokens: request.maxTokens ?? 4096,
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

            const data = await response.json() as {
                choices: Array<{ message: { content: string } }>;
                model: string;
                usage?: { prompt_tokens: number; completion_tokens: number };
            };

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
            throw new Error(`OpenRouter completion failed: ${String(err)}`);
        }
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