import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, ModelRequest, ModelResponse, AIProviderKind } from '../../../types/index.js';
import { logger } from '../../../utils/logger.js';
import { RateLimiter } from '../../../utils/RateLimiter.js';
export class AnthropicProvider implements AIProvider {
    readonly kind: AIProviderKind = 'anthropic';
    private client: Anthropic;
    private defaultModel: string;
    private limiter: RateLimiter;

    constructor(apiKey: string, model = 'claude-3-5-sonnet-latest') {
        this.client = new Anthropic({ 
            apiKey,
            timeout: 300000 // 5 minutes persistence
        });
        this.defaultModel = model;
        
        // Anthropic limits fluctuate based on tier, usually safer at 50 RPM concurrency
        this.limiter = new RateLimiter({
            maxConcurrency: 3,
            requestsPerMinute: 45,
            delayBetweenRequestsMs: 500
        });
    }

    async execute(request: ModelRequest): Promise<ModelResponse> {
        return this.limiter.execute(async () => {
            const model = request.modelOverride ?? this.defaultModel;

            try {
                const response = await this.client.messages.create({
                    model,
                    max_tokens: request.maxTokens,
                    system: request.systemPrompt,
                    messages: [{ role: 'user', content: request.context }],
                    temperature: request.temperature ?? 0.2,
                });

                const content = response.content
                    .filter((block: any) => block.type === 'text')
                    .map((block: any) => (block as { type: 'text'; text: string }).text)
                    .join('');

                return {
                    content,
                    usage: {
                        promptTokens: response.usage.input_tokens,
                        outputTokens: response.usage.output_tokens,
                        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
                    },
                    provider: this.kind,
                    model,
                };
            } catch (err) {
                logger.error('Anthropic execution failed', { error: String(err) });
                throw err;
            }
        });
    }



    async isAvailable(): Promise<boolean> {
        return true;
    }

    async listModels(): Promise<string[]> {
        return [
            'claude-3-5-sonnet-latest',
            'claude-3-5-haiku-latest',
            'claude-3-opus-latest',
            'claude-3-opus-20240229',
            'claude-3-sonnet-20240229',
            'claude-3-haiku-20240307'
        ];
    }
}