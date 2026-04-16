import OpenAI from 'openai';
import type { AIProvider, AICompletionRequest, AICompletionResponse, AIProviderKind } from '../../../types/index.js';
import { logger } from '../../../utils/logger.js';

export class OpenAIProvider implements AIProvider {
    readonly kind: AIProviderKind = 'openai';
    private client: OpenAI;
    private defaultModel: string;

    constructor(apiKey: string, model = 'gpt-4o') {
        this.client = new OpenAI({ 
            apiKey,
            timeout: 300000 // 5 minutes persistence
        });
        this.defaultModel = model;
    }

    async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
        const model = request.model ?? this.defaultModel;

        try {
            const response = await this.client.chat.completions.create({
                model,
                messages: [
                    { role: 'system', content: request.systemPrompt },
                    { role: 'user', content: request.userPrompt },
                ],
                temperature: request.temperature ?? 0.2,
                max_tokens: request.maxTokens ?? 4096,
                response_format: request.responseFormat === 'json'
                    ? { type: 'json_object' }
                    : { type: 'text' },
            });

            const content = response.choices[0]?.message?.content ?? '';
            return {
                content,
                model,
                usage: {
                    inputTokens: response.usage?.prompt_tokens ?? 0,
                    outputTokens: response.usage?.completion_tokens ?? 0,
                },
                provider: this.kind,
            };
        } catch (err) {
            logger.error('OpenAI completion failed', { error: String(err) });
            throw new Error(`OpenAI completion failed: ${String(err)}`);
        }
    }

    async listModels(): Promise<string[]> {
        try {
            const response = await this.client.models.list();
            if (response?.data?.length > 0) {
                return response.data.map(m => m.id);
            }
        } catch (err) {
            logger.error('Failed to fetch OpenAI models', { error: String(err) });
        }
        
        return [
            'gpt-4o',
            'gpt-4o-mini',
            'o1-preview',
            'o1-mini',
            'o3-mini'
        ];
    }

    async isAvailable(): Promise<boolean> {
        try {
            await this.client.models.list();
            return true;
        } catch {
            return false;
        }
    }
}