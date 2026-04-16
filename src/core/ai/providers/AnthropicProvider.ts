import Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, AICompletionRequest, AICompletionResponse, AIProviderKind } from '../../../types/index.js';
import { logger } from '../../../utils/logger.js';
import { RateLimiter } from '../../../utils/RateLimiter.js';
export class AnthropicProvider implements AIProvider {
    readonly kind: AIProviderKind = 'anthropic';
    private client: Anthropic;
    private defaultModel: string;
    private limiter: RateLimiter;

    constructor(apiKey: string, model = 'claude-3-5-sonnet-20241022') {
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

    async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
        return this.limiter.execute(async () => {
            const model = request.model ?? this.defaultModel;

            try {
                const response = await this.client.messages.create({
                    model,
                    max_tokens: request.maxTokens ?? 4096,
                    system: request.systemPrompt,
                    messages: [{ role: 'user', content: request.userPrompt }],
                    temperature: request.temperature ?? 0.2,
                });

                const content = response.content
                    .filter((block: any) => block.type === 'text')
                    .map((block: any) => (block as { type: 'text'; text: string }).text)
                    .join('');

                return {
                    content,
                    model,
                    usage: {
                        inputTokens: response.usage.input_tokens,
                        outputTokens: response.usage.output_tokens,
                    },
                    provider: this.kind,
                };
            } catch (err) {
                logger.error('Anthropic completion failed', { error: String(err) });
                throw err;
            }
        });
    }

    async listModels(): Promise<string[]> {
        try {
            // Anthropic SDK v0.20+ supports models.list()
            if (typeof (this.client as any).models?.list === 'function') {
                const response = await (this.client as any).models.list();
                if (response?.data?.length > 0) {
                    return response.data.map((m: any) => m.id);
                }
            }
        } catch {
            // Fall through to hardcoded if API endpoint is restricted
        }
        
        return [
            'claude-3-7-sonnet-20250219',
            'claude-3-5-sonnet-20241022',
            'claude-3-5-haiku-20241022',
            'claude-3-opus-20240229'
        ];
    }

    async isAvailable(): Promise<boolean> {
        return true;
    }
}