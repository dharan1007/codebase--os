/**
 * ProviderError — Structured error hierarchy for all AI provider failures.
 *
 * The previous implementation had every provider catch and re-throw raw errors
 * with no classification. This meant:
 *   - An expired API key would trigger 5 retry attempts (wasting 25+ seconds)
 *   - Rate-limit errors and server errors were treated identically
 *   - The ModelRouter had no way to distinguish a dead provider from a busy one
 *
 * This module defines the error hierarchy used by ALL providers. The retry
 * logic and circuit breaker use the error type to make correct decisions.
 */

export type ProviderErrorCode =
    | 'AUTH_ERROR'           // 401, 403 — invalid/expired key. Do NOT retry.
    | 'RATE_LIMIT'           // 429 — too many requests. Retry with backoff.
    | 'MODEL_NOT_FOUND'      // 404 model — bad model name. Do NOT retry.
    | 'QUOTA_EXCEEDED'       // 402, billing limit. Do NOT retry.
    | 'SERVER_ERROR'         // 500, 502, 503. Retry.
    | 'NETWORK_ERROR'        // Connection refused, timeout. Retry.
    | 'CONTENT_FILTERED'     // Provider blocked output. Do NOT retry same input.
    | 'CONTEXT_TOO_LONG'     // Context exceeds model limit. Do NOT retry same input.
    | 'UNKNOWN';             // Anything else.

/** Whether this error type warrants a retry attempt */
export const RETRYABLE_CODES = new Set<ProviderErrorCode>([
    'RATE_LIMIT',
    'SERVER_ERROR',
    'NETWORK_ERROR',
]);

export class ProviderError extends Error {
    constructor(
        public readonly code: ProviderErrorCode,
        message: string,
        public readonly providerName: string,
        public readonly statusCode?: number,
        public readonly originalError?: unknown
    ) {
        super(message);
        this.name = 'ProviderError';
    }

    get isRetryable(): boolean {
        return RETRYABLE_CODES.has(this.code);
    }

    get isFatal(): boolean {
        return this.code === 'AUTH_ERROR' ||
            this.code === 'MODEL_NOT_FOUND' ||
            this.code === 'QUOTA_EXCEEDED';
    }
}

/**
 * Classify a raw API error from any provider into a typed ProviderError.
 * Handles HTTP status codes, common error message patterns, and SDK-specific
 * error shapes from Anthropic, OpenAI, Gemini, and Ollama.
 */
export function classifyProviderError(
    err: unknown,
    providerName: string
): ProviderError {
    const msg = String((err as any)?.message ?? err).toLowerCase();
    const status: number | undefined = (err as any)?.status ?? (err as any)?.statusCode ?? (err as any)?.response?.status;

    // ── Status code classification ─────────────────────────────────────────
    if (status === 401 || status === 403) {
        return new ProviderError('AUTH_ERROR',
            `Authentication failed for ${providerName}. Check your API key.`,
            providerName, status, err);
    }
    if (status === 402) {
        return new ProviderError('QUOTA_EXCEEDED',
            `Billing quota exceeded for ${providerName}.`,
            providerName, status, err);
    }
    if (status === 404) {
        return new ProviderError('MODEL_NOT_FOUND',
            `Model not found on ${providerName}. Check model name in config.`,
            providerName, status, err);
    }
    if (status === 429) {
        return new ProviderError('RATE_LIMIT',
            `Rate limit hit on ${providerName}. Backing off.`,
            providerName, status, err);
    }
    if (status !== undefined && status >= 500) {
        return new ProviderError('SERVER_ERROR',
            `${providerName} server error (HTTP ${status}).`,
            providerName, status, err);
    }

    // ── Message-based classification (for SDK wrappers that don't surface status) ──
    if (msg.includes('invalid api key') || msg.includes('incorrect api key') ||
        msg.includes('authentication') || msg.includes('unauthorized') ||
        msg.includes('permission denied') || msg.includes('api key')) {
        return new ProviderError('AUTH_ERROR',
            `Authentication failed for ${providerName}.`,
            providerName, undefined, err);
    }
    if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests') ||
        msg.includes('requests per minute') || msg.includes('quota')) {
        return new ProviderError('RATE_LIMIT',
            `Rate limit hit on ${providerName}.`,
            providerName, undefined, err);
    }
    if (msg.includes('model not found') || msg.includes('no such model') ||
        msg.includes('does not exist') || msg.includes('invalid model')) {
        return new ProviderError('MODEL_NOT_FOUND',
            `Model not found on ${providerName}.`,
            providerName, undefined, err);
    }
    if (msg.includes('billing') || msg.includes('payment') || msg.includes('subscription') ||
        msg.includes('exceeded your current quota')) {
        return new ProviderError('QUOTA_EXCEEDED',
            `Billing quota exceeded for ${providerName}.`,
            providerName, undefined, err);
    }
    if (msg.includes('context length') || msg.includes('too long') || msg.includes('token limit') ||
        msg.includes('max tokens') || msg.includes('context window')) {
        return new ProviderError('CONTEXT_TOO_LONG',
            `Context too long for ${providerName}.`,
            providerName, undefined, err);
    }
    if (msg.includes('content policy') || msg.includes('safety') || msg.includes('filtered') ||
        msg.includes('blocked') || msg.includes('harmful')) {
        return new ProviderError('CONTENT_FILTERED',
            `Content filtered by ${providerName}.`,
            providerName, undefined, err);
    }
    if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('etimedout') ||
        msg.includes('network') || msg.includes('fetch failed') || msg.includes('connection')) {
        return new ProviderError('NETWORK_ERROR',
            `Network error reaching ${providerName}. Check connectivity.`,
            providerName, undefined, err);
    }
    if (msg.includes('500') || msg.includes('502') || msg.includes('503') ||
        msg.includes('overloaded') || msg.includes('service unavailable') ||
        msg.includes('internal server error')) {
        return new ProviderError('SERVER_ERROR',
            `${providerName} server error.`,
            providerName, undefined, err);
    }

    return new ProviderError('UNKNOWN',
        `Unexpected error from ${providerName}: ${(err as any)?.message ?? String(err)}`,
        providerName, undefined, err);
}
