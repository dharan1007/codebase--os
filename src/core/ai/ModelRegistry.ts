import type { AIProviderKind } from '../../types/index.js';

export interface ModelCapabilities {
    supportsSystemRole: boolean;
    supportsJsonMode: boolean;
    contextWindow: number;
    maxOutputTokens: number;
    tpmLimit: number;
    rpmLimit: number;
}

export type SemanticModelSlug =
    | 'reasoning-high'
    | 'reasoning-fast'
    | 'analysis-fast'
    | 'design-premium'
    | 'embedding-small';

/**
 * Current production defaults as of August 2026. They are semantic routing
 * defaults, not benchmark claims, and every role remains environment-overridable.
 */
const DEFAULTS: Record<SemanticModelSlug, Partial<Record<AIProviderKind, string>>> = {
    'reasoning-high': {
        openai: 'gpt-5.6-sol',
        anthropic: 'claude-opus-5',
        gemini: 'gemini-3.7-flash',
        openrouter: 'openai/gpt-5.6-sol',
        ollama: 'qwen2.5-coder:latest',
    },
    'reasoning-fast': {
        openai: 'gpt-5.6-terra',
        anthropic: 'claude-sonnet-5',
        gemini: 'gemini-3.7-flash',
        openrouter: 'anthropic/claude-sonnet-5',
        ollama: 'qwen2.5-coder:7b',
    },
    'analysis-fast': {
        openai: 'gpt-5.6-terra',
        anthropic: 'claude-sonnet-5',
        gemini: 'gemini-3.7-flash',
        openrouter: 'google/gemini-3.7-flash',
        ollama: 'qwen2.5-coder:7b',
    },
    'design-premium': {
        openai: 'gpt-5.6-sol',
        anthropic: 'claude-opus-5',
        gemini: 'gemini-3.7-flash',
        openrouter: 'openai/gpt-5.6-sol',
        ollama: 'qwen2.5-coder:latest',
    },
    'embedding-small': {
        openai: 'text-embedding-3-small',
        gemini: 'gemini-embedding-2',
        openrouter: 'openai/text-embedding-3-small',
    },
};

const ENV_PREFIX: Partial<Record<AIProviderKind, string>> = {
    openai: 'OPENAI',
    anthropic: 'ANTHROPIC',
    gemini: 'GEMINI',
    openrouter: 'OPENROUTER',
    ollama: 'OLLAMA',
};

function slugEnvSuffix(slug: SemanticModelSlug): string {
    return slug.toUpperCase().replace(/-/g, '_');
}

function positiveInt(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const ModelRegistry = {
    resolve(slug: SemanticModelSlug | string, provider: AIProviderKind): string {
        const mapping = DEFAULTS[slug as SemanticModelSlug];
        if (!mapping) return slug;

        const prefix = ENV_PREFIX[provider];
        if (prefix) {
            const exact = process.env[`COS_${prefix}_${slugEnvSuffix(slug as SemanticModelSlug)}_MODEL`];
            if (exact?.trim()) return exact.trim();

            const providerDefault = process.env[`${prefix}_MODEL`];
            if (providerDefault?.trim() && slug !== 'embedding-small') return providerDefault.trim();
        }

        const model = mapping[provider];
        if (!model) throw new Error(`No model mapping for semantic role "${slug}" on provider "${provider}".`);
        return model;
    },

    getCapabilities(modelId: string): ModelCapabilities {
        if (modelId === 'gpt-5.6' || modelId.startsWith('gpt-5.6-')) {
            return {
                supportsSystemRole: true,
                supportsJsonMode: true,
                contextWindow: positiveInt(process.env['OPENAI_CONTEXT_WINDOW'], 1_050_000),
                maxOutputTokens: positiveInt(process.env['OPENAI_MAX_OUTPUT_TOKENS'], 128_000),
                tpmLimit: positiveInt(process.env['OPENAI_TPM'], 500_000),
                rpmLimit: positiveInt(process.env['OPENAI_RPM'], 50),
            };
        }

        if (modelId.startsWith('claude-opus-5') || modelId.startsWith('claude-sonnet-5')) {
            return {
                supportsSystemRole: true,
                supportsJsonMode: false,
                contextWindow: positiveInt(process.env['ANTHROPIC_CONTEXT_WINDOW'], 1_000_000),
                // Keep output conservative unless the operator/account publishes
                // a larger supported limit. Context size is independently useful.
                maxOutputTokens: positiveInt(process.env['ANTHROPIC_MAX_OUTPUT_TOKENS'], 8_192),
                tpmLimit: positiveInt(process.env['ANTHROPIC_TPM'], 30_000),
                rpmLimit: positiveInt(process.env['ANTHROPIC_RPM'], 40),
            };
        }

        if (modelId.startsWith('claude-opus-4') || modelId.startsWith('claude-sonnet-4')) {
            return {
                supportsSystemRole: true,
                supportsJsonMode: false,
                contextWindow: positiveInt(process.env['ANTHROPIC_CONTEXT_WINDOW'], 200_000),
                maxOutputTokens: positiveInt(process.env['ANTHROPIC_MAX_OUTPUT_TOKENS'], 8_192),
                tpmLimit: positiveInt(process.env['ANTHROPIC_TPM'], 30_000),
                rpmLimit: positiveInt(process.env['ANTHROPIC_RPM'], 40),
            };
        }

        if (modelId.startsWith('gemini-3.7-flash') || modelId.startsWith('gemini-3.6-flash')) {
            return {
                supportsSystemRole: true,
                supportsJsonMode: true,
                contextWindow: positiveInt(process.env['GEMINI_CONTEXT_WINDOW'], 1_048_576),
                maxOutputTokens: positiveInt(process.env['GEMINI_MAX_OUTPUT_TOKENS'], 65_536),
                tpmLimit: positiveInt(process.env['GEMINI_TPM'], 100_000),
                rpmLimit: positiveInt(process.env['GEMINI_RPM'], 50),
            };
        }

        return {
            supportsSystemRole: true,
            supportsJsonMode: false,
            contextWindow: positiveInt(process.env['COS_DEFAULT_CONTEXT_WINDOW'], 32_000),
            maxOutputTokens: positiveInt(process.env['COS_DEFAULT_MAX_OUTPUT_TOKENS'], 4_096),
            tpmLimit: positiveInt(process.env['COS_DEFAULT_TPM'], 20_000),
            rpmLimit: positiveInt(process.env['COS_DEFAULT_RPM'], 10),
        };
    },
};
