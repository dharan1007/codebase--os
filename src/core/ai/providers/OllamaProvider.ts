import type { AIProvider, ModelRequest, ModelResponse, AIProviderKind } from '../../../types/index.js';
import { logger } from '../../../utils/logger.js';
import { RateLimiter } from '../../../utils/RateLimiter.js';

export class OllamaProvider implements AIProvider {
    readonly kind: AIProviderKind = 'ollama';
    private baseURL: string;
    private defaultModel: string;
    private limiter: RateLimiter;

    constructor(baseURL = 'http://localhost:11434', model = 'llama-3.2:3b') {
        this.baseURL = baseURL.replace(/\/$/, '');
        this.defaultModel = model;
        
        this.limiter = new RateLimiter({
            maxConcurrency: 1,
            requestsPerMinute: 30,
            delayBetweenRequestsMs: 1000
        });
    }

    async execute(request: ModelRequest): Promise<ModelResponse> {
        return this.limiter.execute(async () => {
            const model = request.modelOverride ?? this.defaultModel;

            const body = {
                model,
                messages: [
                    { role: 'system', content: request.systemPrompt ?? 'You are a coding assistant.' },
                    { role: 'user', content: request.context },
                ],
                stream: false,
                options: {
                    temperature: request.temperature ?? 0.2,
                    num_predict: request.maxTokens,
                },
            };

            try {
                const response = await fetch(`${this.baseURL}/api/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });

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
                    usage: {
                        promptTokens: data.prompt_eval_count ?? 0,
                        outputTokens: data.eval_count ?? 0,
                        totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
                    },
                    provider: this.kind,
                    model,
                };
            } catch (err) {
                logger.error('Ollama execution failed', { error: String(err) });
                throw err;
            }
        });
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