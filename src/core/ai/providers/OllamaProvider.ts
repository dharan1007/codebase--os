import type { AIProvider, AICompletionRequest, AICompletionResponse, AIProviderKind } from '../../../types/index.js';
import { logger } from '../../../utils/logger.js';

export class OllamaProvider implements AIProvider {
    readonly kind: AIProviderKind = 'ollama';
    private baseURL: string;
    private defaultModel: string;

    constructor(baseURL = 'http://localhost:11434', model = 'codellama:34b') {
        this.baseURL = baseURL.replace(/\/$/, '');
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
            stream: false,
            options: {
                temperature: request.temperature ?? 0.2,
                num_predict: request.maxTokens ?? 4096,
            },
        };

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 600000); // 10 minutes for local AI

            const response = await fetch(`${this.baseURL}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`Ollama API error ${response.status}: ${await response.text()}`);
            }

            const data = await response.json() as {
                message?: { content: string };
                prompt_eval_count?: number;
                eval_count?: number;
            };

            return {
                content: data.message?.content ?? '',
                model,
                usage: {
                    inputTokens: data.prompt_eval_count ?? 0,
                    outputTokens: data.eval_count ?? 0,
                },
                provider: this.kind,
            };
        } catch (err) {
            logger.error('Ollama completion failed', { error: String(err) });
            throw new Error(`Ollama completion failed: ${String(err)}`);
        }
    }

    async listModels(): Promise<string[]> {
        try {
            const response = await fetch(`${this.baseURL}/api/tags`);
            if (!response.ok) return [];
            const data = await response.json() as { models: Array<{ name: string }> };
            return data.models.map(m => m.name);
        } catch (err) {
            logger.error('Failed to fetch Ollama models', { error: String(err) });
            return ['codellama:34b', 'llama3', 'mistral', 'phi3']; // Fallback to common ones
        }
    }

    async isAvailable(): Promise<boolean> {
        try {
            const resp = await fetch(`${this.baseURL}/api/tags`);
            return resp.ok;
        } catch {
            return false;
        }
    }
}