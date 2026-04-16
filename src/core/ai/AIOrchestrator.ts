import type { AIProvider, AICompletionRequest, AICompletionResponse, AIProviderKind } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import chalk from 'chalk';

/**
 * AIOrchestrator wraps a raw AIProvider to add resiliency,
 * adaptive token management, and intelligent retries.
 */
export class AIOrchestrator implements AIProvider {
    readonly kind: AIProviderKind;

    private failureCount = 0;
    private lastFailureTime = 0;
    private readonly circuitThreshold = 3;
    private readonly circuitResetMs = 60000; // 1 minute

    constructor(private readonly provider: AIProvider) {
        this.kind = provider.kind;
    }

    private isCircuitOpen(): boolean {
        if (this.failureCount >= this.circuitThreshold) {
            const elapsed = Date.now() - this.lastFailureTime;
            if (elapsed < this.circuitResetMs) return true;
            // Reset after cooldown
            this.failureCount = 0;
        }
        return false;
    }

    async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
        return this.internalComplete(request, (req) => this.provider.complete(req));
    }

    async completeStream(request: AICompletionRequest, onToken: (token: string) => void): Promise<AICompletionResponse> {
        if (!this.provider.completeStream) {
            // Fallback to non-streaming if provider doesn't support it
            return this.complete(request);
        }
        return this.internalComplete(request, (req) => this.provider.completeStream!(req, onToken));
    }

    private async internalComplete(
        request: AICompletionRequest,
        fn: (req: AICompletionRequest) => Promise<AICompletionResponse>
    ): Promise<AICompletionResponse> {
        if (this.isCircuitOpen()) {
            throw new Error(`AI Circuit Breaker is OPEN for ${this.kind}. Provider is currently considered unstable.`);
        }

        let attempts = 0;
        const maxAttempts = 15;

        // Pre-flight sleep to prevent burst rate limit collisions
        await new Promise(resolve => setTimeout(resolve, 800));

        while (attempts < maxAttempts) {
            try {
                const result = await fn(request);
                this.failureCount = 0; // Success resets circuit
                return result;
            } catch (err) {
                attempts++;
                const error = err instanceof Error ? err : new Error(String(err));
                const errorMsg = error.message.toLowerCase();

                // Increment failures for circuit breaker
                this.failureCount++;
                this.lastFailureTime = Date.now();

                // handle Model Not Found (404)
                if (errorMsg.includes('404') || errorMsg.includes('model_not_found') || errorMsg.includes('not found')) {
                    // (Handle models as before but condensed)
                    throw error;
                }

                // handle Rate Limits (429) & Server Overload (503/504)
                if (errorMsg.includes('429') || errorMsg.includes('rate limit') || errorMsg.includes('503') || errorMsg.includes('504') || errorMsg.includes('overloaded') || errorMsg.includes('busy')) {
                    if (attempts < maxAttempts) {
                        const waitTime = Math.min(Math.pow(1.6, attempts) * 3000, 90000); 
                        if (attempts > 5) logger.error(`${this.kind.toUpperCase()} busy: ${error.message}`);
                        logger.warn(`AI provider is processing or busy [Attempt ${attempts}/${maxAttempts}]. Holding for ${Math.round(waitTime/1000)}s...`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        continue;
                    }
                }

                // Default Error Handling
                logger.error(`AI provider error: ${error.message}`);
                throw error;
            }
        }
        throw new Error('AI request failed after multiple attempts.');
    }

    private getTopupUrl(): string | null {
        switch (this.kind) {
            case 'openrouter': return 'https://openrouter.ai/settings/credits';
            case 'openai': return 'https://platform.openai.com/account/billing';
            case 'anthropic': return 'https://console.anthropic.com/settings/billing';
            default: return null;
        }
    }

    async isAvailable(): Promise<boolean> {
        return this.provider.isAvailable();
    }

    async listModels(): Promise<string[]> {
        return typeof this.provider.listModels === 'function' ? await this.provider.listModels() : [];
    }

    async embed(text: string): Promise<number[]> {
        if (!this.provider.embed) {
            throw new Error(`Provider ${this.kind} does not support embeddings.`);
        }
        
        let attempts = 0;
        const maxAttempts = 5;

        while (attempts < maxAttempts) {
            try {
                return await this.provider.embed(text);
            } catch (err: any) {
                attempts++;
                const errorMsg = err.message.toLowerCase();
                if (errorMsg.includes('429') || errorMsg.includes('rate limit')) {
                    const waitTime = Math.pow(2, attempts) * 1000;
                    logger.warn(`Embed rate limit hit. Waiting ${waitTime}ms...`);
                    await new Promise(r => setTimeout(r, waitTime));
                    continue;
                }
                throw err;
            }
        }
        throw new Error('Embed request failed after multiple attempts.');
    }

    async batchEmbed(texts: string[]): Promise<number[][]> {
        if (!this.provider.batchEmbed) {
            throw new Error(`Provider ${this.kind} does not support batch embeddings.`);
        }

        let attempts = 0;
        const maxAttempts = 5;

        while (attempts < maxAttempts) {
            try {
                return await this.provider.batchEmbed(texts);
            } catch (err: any) {
                attempts++;
                const errorMsg = err.message.toLowerCase();
                if (errorMsg.includes('429') || errorMsg.includes('rate limit')) {
                    const waitTime = Math.pow(2, attempts) * 1000;
                    logger.warn(`Batch embed rate limit hit. Waiting ${waitTime}ms...`);
                    await new Promise(r => setTimeout(r, waitTime));
                    continue;
                }
                throw err;
            }
        }
        throw new Error('Batch embed request failed after multiple attempts.');
    }
}