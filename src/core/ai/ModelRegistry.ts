import type { AIProviderKind } from '../../types/index.js';

export interface ModelCapabilities {
    supportsSystemRole: boolean;
    supportsJsonMode: boolean;
    contextWindow: number;
    maxOutputTokens: number;
    tpmLimit: number; // Tokens Per Minute
    rpmLimit: number; // Requests Per Minute
}

export type SemanticModelSlug = 
    | 'reasoning-high' 
    | 'reasoning-fast' 
    | 'analysis-fast' 
    | 'design-premium'
    | 'embedding-small';

export const ModelRegistry = {
    // Semantic Slug mapping to Provider-specific IDs
    mappings: {
        'reasoning-high': {
            openrouter: 'anthropic/claude-3.5-sonnet',
            anthropic: 'claude-3-5-sonnet-latest',
            openai: 'gpt-4o',
            gemini: 'gemini-1.5-pro',
        },
        'reasoning-fast': {
            openrouter: 'openai/gpt-4o-mini',
            openai: 'gpt-4o-mini',
            anthropic: 'claude-3-haiku-20240307',
            gemini: 'gemini-1.5-flash',
        },
        'analysis-fast': {
            openrouter: 'google/gemini-flash-1.5',
            gemini: 'gemini-1.5-flash',
            openai: 'gpt-4o-mini',
        },
        'design-premium': {
            openrouter: 'anthropic/claude-3.5-sonnet',
            anthropic: 'claude-3-5-sonnet-latest',
            openai: 'gpt-4o',
        },
        'embedding-small': {
            openai: 'text-embedding-3-small',
            gemini: 'text-embedding-004',
            openrouter: 'openai/text-embedding-3-small',
        }
    } as Record<SemanticModelSlug, Partial<Record<AIProviderKind, string>>>,

    // Full Capability Registry
    capabilities: {
        'anthropic/claude-3.5-sonnet': {
            supportsSystemRole: true,
            supportsJsonMode: true,
            contextWindow: 200000,
            maxOutputTokens: 8192,
            tpmLimit: 80000,
            rpmLimit: 50,
        },
        'claude-3-5-sonnet-latest': {
            supportsSystemRole: true,
            supportsJsonMode: true,
            contextWindow: 200000,
            maxOutputTokens: 8192,
            tpmLimit: 80000,
            rpmLimit: 50,
        },
        'gpt-4o': {
            supportsSystemRole: true,
            supportsJsonMode: true,
            contextWindow: 128000,
            maxOutputTokens: 4096,
            tpmLimit: 30000,
            rpmLimit: 3500, // OpenAI has high RPM
        },
        'google/gemini-flash-1.5': {
            supportsSystemRole: true,
            supportsJsonMode: true,
            contextWindow: 1000000,
            maxOutputTokens: 8192,
            tpmLimit: 1000000,
            rpmLimit: 2000,
        },
        'gemini-1.5-flash': {
            supportsSystemRole: true,
            supportsJsonMode: true,
            contextWindow: 1000000,
            maxOutputTokens: 8192,
            tpmLimit: 1000000,
            rpmLimit: 2000,
        }
    } as Record<string, ModelCapabilities>,

    /**
     * Resolves a semantic slug to a provider-specific model ID.
     */
    resolve(slug: SemanticModelSlug | string, provider: AIProviderKind): string {
        const mapping = this.mappings[slug as SemanticModelSlug];
        if (!mapping) return slug; // Already a raw ID

        const providerId = mapping[provider];
        if (providerId) return providerId;

        // Intelligent fallback
        if (provider === 'openrouter') return 'anthropic/claude-3.5-sonnet';
        if (provider === 'openai') return 'gpt-4o';
        if (provider === 'anthropic') return 'claude-3-5-sonnet-latest';
        
        return slug;
    },

    /**
     * Get capabilities for a specific model ID.
     */
    getCapabilities(modelId: string): ModelCapabilities {
        // Default to safe values if unknown
        return this.capabilities[modelId] || {
            supportsSystemRole: false, // Safer default
            supportsJsonMode: false,
            contextWindow: 8192,
            maxOutputTokens: 2048,
            tpmLimit: 20000,
            rpmLimit: 10,
        };
    }
};
