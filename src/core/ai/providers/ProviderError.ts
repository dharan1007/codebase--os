export type ProviderErrorCode =
    | 'AUTH_ERROR'
    | 'RATE_LIMIT'
    | 'MODEL_NOT_FOUND'
    | 'QUOTA_EXCEEDED'
    | 'SERVER_ERROR'
    | 'NETWORK_ERROR'
    | 'TIMEOUT'
    | 'CANCELLED'
    | 'CONTENT_FILTERED'
    | 'CONTEXT_TOO_LONG'
    | 'UNKNOWN';

const RETRYABLE_CODES = new Set<ProviderErrorCode>([
    'RATE_LIMIT',
    'SERVER_ERROR',
    'NETWORK_ERROR',
    'TIMEOUT',
]);

export class ProviderError extends Error {
    constructor(
        public readonly code: ProviderErrorCode,
        message: string,
        public readonly providerName: string,
        public readonly statusCode?: number,
        public readonly originalError?: unknown,
        public readonly retryAfterMs?: number,
    ) {
        super(message);
        this.name = 'ProviderError';
    }

    get isRetryable(): boolean {
        return RETRYABLE_CODES.has(this.code);
    }

    get isFatal(): boolean {
        return this.code === 'AUTH_ERROR' || this.code === 'MODEL_NOT_FOUND' || this.code === 'QUOTA_EXCEEDED';
    }
}

function extractRetryAfterMs(error: any): number | undefined {
    const direct = Number(error?.retryAfterMs);
    if (Number.isFinite(direct) && direct >= 0) return direct;

    const seconds = Number(error?.retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

    const raw = error?.headers?.get?.('retry-after') ?? error?.response?.headers?.get?.('retry-after');
    if (raw == null) return undefined;
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric * 1000;
    const date = Date.parse(String(raw));
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function classifyProviderError(error: unknown, providerName: string): ProviderError {
    if (error instanceof ProviderError) return error;

    const raw = error as any;
    const message = String(raw?.message ?? error);
    const normalized = message.toLowerCase();
    const status: number | undefined = raw?.status ?? raw?.statusCode ?? raw?.response?.status;
    const providerCode = String(raw?.code ?? raw?.error?.code ?? '').toLowerCase();
    const retryAfterMs = extractRetryAfterMs(raw);

    if (
        providerCode === 'insufficient_quota' ||
        normalized.includes('exceeded your current quota') ||
        normalized.includes('insufficient quota') ||
        normalized.includes('billing quota') ||
        normalized.includes('billing limit') ||
        normalized.includes('payment required')
    ) {
        return new ProviderError('QUOTA_EXCEEDED', message, providerName, status, error);
    }
    if (status === 401 || status === 403) {
        return new ProviderError('AUTH_ERROR', message, providerName, status, error);
    }
    if (status === 404 || normalized.includes('model not found') || normalized.includes('unknown model')) {
        return new ProviderError('MODEL_NOT_FOUND', message, providerName, status, error);
    }
    if (status === 429 || normalized.includes('rate limit') || normalized.includes('too many requests')) {
        return new ProviderError('RATE_LIMIT', message, providerName, status, error, retryAfterMs);
    }
    if (status !== undefined && status >= 500) {
        return new ProviderError('SERVER_ERROR', message, providerName, status, error, retryAfterMs);
    }
    if (normalized.includes('timeout') || normalized.includes('timed out') || normalized.includes('etimedout')) {
        return new ProviderError('TIMEOUT', message, providerName, status, error, retryAfterMs);
    }
    if (normalized.includes('abort') || normalized.includes('cancel')) {
        return new ProviderError('CANCELLED', message, providerName, status, error);
    }
    if (normalized.includes('context') && (normalized.includes('length') || normalized.includes('token'))) {
        return new ProviderError('CONTEXT_TOO_LONG', message, providerName, status, error);
    }
    if (normalized.includes('content filter') || normalized.includes('content policy') || normalized.includes('safety')) {
        return new ProviderError('CONTENT_FILTERED', message, providerName, status, error);
    }
    if (
        normalized.includes('network') || normalized.includes('fetch failed') || normalized.includes('econnreset') ||
        normalized.includes('econnrefused') || normalized.includes('enotfound') || normalized.includes('socket')
    ) {
        return new ProviderError('NETWORK_ERROR', message, providerName, status, error, retryAfterMs);
    }
    return new ProviderError('UNKNOWN', message, providerName, status, error, retryAfterMs);
}
