import type { AIProvider, AICompletionRequest, AICompletionResponse, AIProviderKind } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import chalk from 'chalk';

/**
 * AIOrchestrator wraps a raw AIProvider to add resiliency,
 * adaptive token management, and intelligent retries.
 */
export class AIOrchestrator implements AIProvider {
    readonly kind: AIProviderKind;

    constructor(private readonly provider: AIProvider) {
        this.kind = provider.kind;
    }

    async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
        let attempts = 0;
        const maxAttempts = 15; // Increased patience for highly congested times

        // Pre-flight sleep to prevent burst rate limit collisions
        await new Promise(resolve => setTimeout(resolve, 800));

        while (attempts < maxAttempts) {
            try {
                return await this.provider.complete(request);
            } catch (err) {
                attempts++;
                const error = err instanceof Error ? err : new Error(String(err));
                const errorMsg = error.message.toLowerCase();

                // 1. Handle Model Not Found (404) - Check this FIRST to avoid false 'busy' retries
                if (errorMsg.includes('404') || errorMsg.includes('model_not_found') || errorMsg.includes('not found')) {
                    const listFn = (this.provider as any).listModels;
                    if (typeof listFn === 'function') {
                        const availableModels = await listFn.call(this.provider);
                        if (availableModels.length > 0) {
                            const requestedModel = request.model ? `'${request.model}'` : 'currently configured AI model';
                            logger.error(`The ${requestedModel} is not available on ${this.kind}.`);
                            logger.info(`Try changing your model to one of these: ${availableModels.slice(0, 5).join(', ')}`);
                            logger.info('You can change this anytime by typing: cos config');
                            throw new Error(`AI Model not found.`);
                        }
                    }
                }

                // 2. Handle Rate Limits (429) & Server Overload (503/504)
                if (errorMsg.includes('429') || errorMsg.includes('rate limit') || errorMsg.includes('too many requests') ||
                    errorMsg.includes('503') || errorMsg.includes('504') || errorMsg.includes('overloaded') || errorMsg.includes('busy')) {
                    
                    if (attempts < maxAttempts) {
                        // Incremental backoff capped at 90s to survive long quota resets
                        const waitTime = Math.min(Math.pow(1.6, attempts) * 3000, 90000); 
                        
                        // Silent Wait: Don't show scary error icons on the first few attempts
                        // Mirrors Claude's 'Thinking...' persistence
                        if (attempts > 5) {
                            logger.error(`${this.kind.toUpperCase()} busy: ${error.message}`);
                        }
                        
                        const waitSecs = Math.round(waitTime/1000);
                        logger.warn(`AI provider is processing or busy [Attempt ${attempts}/${maxAttempts}]. Holding for ${waitSecs}s...`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        continue;
                    }
                    logger.error(`AI provider error limit exceeded after ${maxAttempts} attempts. Please try again in a few minutes.`);
                    throw new Error(`AI Provider Busy: ${error.message}`);
                }

                // 3. Handle Authentication / Expired Errors (400/401)
                if (errorMsg.includes('400') || errorMsg.includes('401') || errorMsg.includes('expired') || errorMsg.includes('invalid api key')) {
                    logger.error(`${this.kind.toUpperCase()} Authentication Error: ${error.message}`);
                    if (errorMsg.includes('expired')) {
                        logger.info(chalk.yellow('\n💡 TIP: If your key is new, please ensure your system clock is set to the correct date and time.'));
                    }
                    logger.info(`You can update your API key anytime by typing: ${chalk.bold('cos config')}`);
                    throw error;
                }

                // 3. Handle Insufficient Credits (402)
                if (errorMsg.includes('402') || errorMsg.includes('credit') || errorMsg.includes('balance') || errorMsg.includes('quota')) {
                    const match = errorMsg.match(/can only afford (\d+)/i);
                    const affordable = match ? parseInt(match[1], 10) : 0;
                    const minTokens = 1024; // Minimum budget for a valid agent response
                    
                    if (affordable > 0 && affordable < minTokens) {
                        logger.error(`${this.kind.toUpperCase()} reports low budget: can only afford ${affordable} tokens (need ${minTokens}).`);
                        logger.info(chalk.yellow('💡 STOPPING to prevent wasted credits on a truncated response.'));
                    } else if (!(request as any)._retried_low_budget && affordable >= minTokens && request.maxTokens && request.maxTokens > affordable) {
                        // Only retry once if it's still a reasonable amount
                        const retryTokens = affordable - 50;
                        logger.warn(`AI provider budget low. Retrying with a smaller token limit (${retryTokens}) once.`);
                        request.maxTokens = retryTokens;
                        (request as any)._retried_low_budget = true;
                        continue;
                    }

                    const providerName = this.kind.toUpperCase();
                    const topupUrl = this.getTopupUrl();
                    logger.error(`\nYour AI provider (${providerName}) is out of credits or has insufficient balance.`);
                    if (topupUrl) logger.info(`Visit here to top up: ${chalk.bold(topupUrl)}`);
                    throw new Error(`Insufficient credits on ${providerName}.`);
                }

                // 4. Handle Model Not Found (404)
                if (errorMsg.includes('404') || errorMsg.includes('model_not_found') || errorMsg.includes('not found')) {
                    const listFn = (this.provider as any).listModels;
                    if (typeof listFn === 'function') {
                        const availableModels = await listFn.call(this.provider);
                        if (availableModels.length > 0) {
                            const requestedModel = request.model ? `'${request.model}'` : 'currently configured AI model';
                            logger.error(`The ${requestedModel} is not available on ${this.kind}.`);
                            logger.info(`Try changing your model to one of these: ${availableModels.slice(0, 5).join(', ')}`);
                            logger.info('You can change this anytime by typing: cos config');
                            throw new Error(`AI Model not found.`);
                        }
                    }
                }

                // 5. Default Error Handling
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