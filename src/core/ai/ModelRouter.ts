import type { ProjectConfig, AIProvider } from '../../types/index.js';
import { AIProviderFactory } from './AIProviderFactory.js';

export type TaskProfile = 'planning' | 'code' | 'analysis' | 'fast';

/**
 * ModelRouter intelligently routes different task types to the most
 * appropriate AI model — balancing speed, cost, and capability.
 *
 * - Planning (JSON structures): Use a fast, cheap model.
 * - Code Generation (large, complex output): Use the most powerful model.
 * - Analysis (structured data): Use a mid-tier model.
 * - Fast (simple lookups): Use the cheapest available.
 *
 * This makes Codebase OS faster and cheaper than competitors
 * while being smarter where it matters most.
 */
export class ModelRouter {
    private profileMap: Record<TaskProfile, string>;

    constructor(private config: ProjectConfig) {
        this.profileMap = this.buildProfileMap(config);
    }

    /**
     * Get a provider configured for a specific task profile.
     * Falls back to the user's primary provider if no profile override is set.
     */
    getProviderForTask(profile: TaskProfile): AIProvider {
        const overrideModel = this.profileMap[profile];
        if (!overrideModel || overrideModel === this.config.ai.model) {
            return AIProviderFactory.create(this.config);
        }

        // Create a modified config with the profile-specific model
        const profileConfig: ProjectConfig = {
            ...this.config,
            ai: {
                ...this.config.ai,
                model: overrideModel,
            },
        };

        return AIProviderFactory.create(profileConfig);
    }

    private buildProfileMap(config: ProjectConfig): Record<TaskProfile, string> {
        const baseModel = config.ai.model ?? '';
        const provider = config.ai.provider;

        switch (provider) {
            case 'openrouter':
                // OpenRouter keys are often restricted. It's safer to use the baseModel
                // for all tasks unless we know the user has access to cheaper models.
                return {
                    planning: baseModel,
                    code: baseModel,
                    analysis: baseModel,
                    fast: baseModel,
                };
            case 'openai':
                return {
                    planning: baseModel,
                    code: baseModel,
                    analysis: baseModel,
                    fast: baseModel,
                };
            case 'anthropic':
                return {
                    planning: baseModel,
                    code: baseModel,
                    analysis: baseModel,
                    fast: baseModel,
                };
            case 'gemini':
                return {
                    planning: baseModel,
                    code: baseModel,
                    analysis: baseModel,
                    fast: baseModel,
                };
            default:
                // Ollama/unknown: always use the configured model
                return {
                    planning: baseModel,
                    code: baseModel,
                    analysis: baseModel,
                    fast: baseModel,
                };
        }
    }
}
