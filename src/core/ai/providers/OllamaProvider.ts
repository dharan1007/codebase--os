import type { AIProvider, ModelRequest, ModelResponse, AIProviderKind } from '../../../types/index.js';
import { logger } from '../../../utils/logger.js';
import { RateLimiter } from '../../../utils/RateLimiter.js';
import { classifyProviderError } from './ProviderError.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000; // Ollama local server can be slow to recover

export class OllamaProvider implements AIProvider {
    readonly kind: AIProviderKind = 'ollama';
    private baseURL: string;
    private defaultModel: string;
    private limiter: RateLimiter;

    constructor(baseURL = 'http://localhost:11434', model = 'llama-3.2:3b') {
        this.baseURL = baseURL.replace(/\/$/, '');
        this.defaultModel = model;

        // Ollama is local — concurrency depends on hardware (GPU VRAM).
        // Default to 1 concurrent request. Power users can set OLLAMA_CONCURRENCY.
        const concurrency = parseInt(process.env['OLLAMA_CONCURRENCY'] ?? '1', 10);
        this.limiter = new RateLimiter({
            maxConcurrency: concurrency,
            requestsPerMinute: 60, // No real limit — local server
            delayBetweenRequestsMs: 500,
            circuitBreakerThreshold: 5,
            circuitBreakerCooldownMs: 30_000, // Shorter cooldown for local recovery
            maxQueueSize: 50,
            label: 'ollama',
        });
    }

    async execute(request: ModelRequest): Promise<ModelResponse> {
        return this.limiter.execute(async () => {
            return RateLimiter.withRetry(
                () => this.callAPI(request),
                MAX_RETRIES,
                BASE_DELAY_MS,
                'ollama.execute'
            );
        });
    }

    private async callAPI(request: ModelRequest): Promise<ModelResponse> {
        const model = request.modelOverride ?? this.defaultModel;

        let response: Response;
        try {
            response = await fetch(`${this.baseURL}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: 'system', content: request.systemPrompt ?? 'You are a coding assistant.' },
                        { role: 'user', content: request.context },
                    ],
                    stream: false,
                    options: {
                        temperature: request.temperature ?? 0.2,
                        num_predict: request.maxTokens ?? 4096,
                    },
                }),
            });
        } catch (err) {
            // Network errors (ECONNREFUSED, etc.) — Ollama server not running
            const classified = classifyProviderError(err, 'ollama');
            logger.error('Ollama: Cannot reach local server', {
                baseURL: this.baseURL,
                error: classified.message,
            });
            throw classified;
        }

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            const syntheticErr = Object.assign(new Error(`Ollama HTTP ${response.status}: ${text}`), {
                status: response.status,
            });
            const classified = classifyProviderError(syntheticErr, 'ollama');
            logger.error('Ollama call failed', { code: classified.code, status: response.status, model });
            throw classified;
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
    }

    async isAvailable(): Promise<boolean> {
        try {
            const resp = await fetch(`${this.baseURL}/api/tags`, { signal: AbortSignal.timeout(3000) });
            return resp.ok;
        } catch {
            return false;
        }
    }

    async listModels(): Promise<string[]> {
        try {
            const resp = await fetch(`${this.baseURL}/api/tags`);
            if (resp.ok) {
                const data = await resp.json() as any;
                return (data.models ?? []).map((m: any) => m.name as string);
            }
        } catch {
            // Local server not available
        }
        return ['codellama:7b', 'llama3', 'mistral', 'phi3', 'deepseek-coder'];
    }
}