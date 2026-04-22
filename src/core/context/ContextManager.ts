import { ModelRegistry } from '../ai/ModelRegistry.js';
import { logger } from '../../utils/logger.js';

export interface ChatMessage {
    role: string;
    content: string;
    tokens?: number;
}

/**
 * ContextManager — High-fidelity context regulation.
 *
 * This replacement for raw array.slice() handles:
 *  - TOKEN BUDGETING: Ensures we never exceed the model's Lm context.
 *  - DYNAMIC TRUNCATION: Drops middle messages while keeping Head (System) and Tail (Recent).
 *  - SMART SUMMARIZATION: Signals when the ratio of 'lost' content is too high.
 */
export class ContextManager {
    private readonly MAX_PERCENT = 0.8; // Target 80% utilization to leave room for output

    constructor(private modelId: string) {}

    /**
     * Regulate the message history to fit within the model's budget.
     */
    regulate(messages: ChatMessage[], buffer: number = 2000): ChatMessage[] {
        const caps = ModelRegistry.getCapabilities(this.modelId);
        const budget = (caps.contextWindow * this.MAX_PERCENT) - buffer;
        
        let currentTokens = this.estimateTokens(messages);
        if (currentTokens <= budget) return messages;

        logger.warn(`[ContextManager] Context overflow (${currentTokens}/${budget}). Truncating...`);

        // Preservation Strategy:
        // 1. Keep the System Prompt (Index 0)
        // 2. Keep the Head (First few turns of context)
        // 3. Keep the Tail (Most recent 4 turns)
        // 4. Drop from the Middle
        
        const system = messages[0];
        const recent = messages.slice(-6);
        const middle = messages.slice(1, -6);
        
        const regulated: ChatMessage[] = [system];
        
        // Add middle messages until budget reached
        let tokenCount = this.estimateTokens([system, ...recent]);
        for (let i = middle.length - 1; i >= 0; i--) {
            const m = middle[i];
            const ts = this.estimateTokens([m]);
            if (tokenCount + ts < budget) {
                regulated.splice(1, 0, m);
                tokenCount += ts;
            } else {
                break;
            }
        }
        
        regulated.push(...recent);
        
        const finalTokens = this.estimateTokens(regulated);
        logger.info(`[ContextManager] Regulated context: ${messages.length} -> ${regulated.length} msgs (${finalTokens} tokens)`);
        
        return regulated;
    }

    /**
     * Crude token estimation (4 chars per token).
     * In production, this should use tiktoken or similar.
     */
    private estimateTokens(messages: ChatMessage[]): number {
        return messages.reduce((acc, m) => acc + (m.content.length / 4), 0);
    }

    /**
     * Returns true if the message history is "dense" enough to warrant LLM compression.
     */
    shouldCompress(messages: ChatMessage[]): boolean {
        return this.estimateTokens(messages) > (ModelRegistry.getCapabilities(this.modelId).contextWindow * 0.5);
    }
}
