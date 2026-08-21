import { EventEmitter } from 'events';
import crypto from 'crypto';
import { logger } from '../../utils/logger.js';
import type { AIProviderKind, ModelRequest, ModelResponse } from '../../types/index.js';
import { ProviderHealthTracker } from './ProviderHealthTracker.js';

const SYSTEM_CONFIG = {
    MIN_DISPATCH_INTERVAL_MS: 150,
    MAX_CONCURRENCY: 4,
    MAX_PAYLOAD_TOKENS: 120_000,
    MAX_PROVIDER_ROUNDS: 3,
    BASE_BACKOFF_MS: 750,
    CAP_BACKOFF_MS: 15_000,
    MAX_IN_FLIGHT_TOKENS: 160_000,
    REQUEST_DEADLINE_MS: 180_000,
};

export interface AIRequest {
    id: string;
    requestDetails: ModelRequest;
    providerSequence: AIProviderKind[];
    providerIndex: number;
    round: number;
    estimatedTokens: number;
    enqueuedAt: number;
    deadlineAt: number;
    lastError?: string;
    resolve: (value: ModelResponse) => void;
    reject: (reason: Error) => void;
}

export class TokenEstimator {
    static estimate(text: string): number {
        if (!text) return 0;
        return Math.ceil(text.length / 3.5);
    }
}

export class RetryHandler {
    static calculateDelay(round: number): number {
        const cap = Math.min(SYSTEM_CONFIG.CAP_BACKOFF_MS, SYSTEM_CONFIG.BASE_BACKOFF_MS * Math.pow(2, round));
        return Math.floor(cap / 2 + Math.random() * cap / 2);
    }
}

export class AdaptiveConcurrencyManager {
    public limit = 1;

    recordSuccess(): void {
        if (this.limit < SYSTEM_CONFIG.MAX_CONCURRENCY) this.limit++;
    }

    recordOverload(): void {
        this.limit = Math.max(1, Math.floor(this.limit / 2));
    }
}

/**
 * Deadline-bounded provider scheduler. Production orchestrators should use
 * createIsolated(); getInstance() remains only for legacy aggregate metrics.
 */
export class TrafficController extends EventEmitter {
    private static instance: TrafficController;
    private queue: AIRequest[] = [];
    private inFlightRequests = new Map<string, AIRequest>();
    private inFlightTokens = 0;
    private concurrencyManager = new AdaptiveConcurrencyManager();
    private healthTracker = ProviderHealthTracker.getInstance();
    private lastDispatchTime = 0;
    private isProcessorRunning = false;
    private networkExecutor?: (req: AIRequest, provider: AIProviderKind) => Promise<ModelResponse>;

    constructor() {
        super();
    }

    static getInstance(): TrafficController {
        if (!TrafficController.instance) TrafficController.instance = new TrafficController();
        return TrafficController.instance;
    }

    static createIsolated(): TrafficController {
        return new TrafficController();
    }

    setNetworkExecutor(executor: (req: AIRequest, provider: AIProviderKind) => Promise<ModelResponse>): void {
        this.networkExecutor = executor;
    }

    async schedule(requestDetails: ModelRequest, providerSequence: AIProviderKind[]): Promise<ModelResponse> {
        const sequence = [...new Set(providerSequence)];
        if (sequence.length === 0) {
            throw new Error('NO_PROVIDER_AVAILABLE: no configured/healthy provider candidates were supplied.');
        }
        if (!this.networkExecutor) {
            throw new Error('ORCHESTRATOR_NOT_READY: network executor is not configured.');
        }

        const estimatedTokens = TokenEstimator.estimate(this.contextText(requestDetails.context));
        if (estimatedTokens > SYSTEM_CONFIG.MAX_PAYLOAD_TOKENS) {
            throw new Error(
                `PAYLOAD_TOO_LARGE: estimated ${estimatedTokens} tokens exceeds scheduler limit ${SYSTEM_CONFIG.MAX_PAYLOAD_TOKENS}.`,
            );
        }

        const now = Date.now();
        return new Promise<ModelResponse>((resolve, reject) => {
            this.queue.push({
                id: crypto.randomUUID(),
                requestDetails,
                providerSequence: sequence,
                providerIndex: 0,
                round: 0,
                estimatedTokens,
                enqueuedAt: now,
                deadlineAt: now + SYSTEM_CONFIG.REQUEST_DEADLINE_MS,
                resolve,
                reject,
            });
            void this.startProcessor();
        });
    }

    private async startProcessor(): Promise<void> {
        if (this.isProcessorRunning) return;
        this.isProcessorRunning = true;
        try {
            while (this.queue.length > 0 || this.inFlightRequests.size > 0) {
                this.rejectExpired();
                this.tryDispatch();
                await new Promise(resolve => setTimeout(resolve, 40));
            }
        } finally {
            this.isProcessorRunning = false;
            // A request may have been requeued between the final condition check
            // and finally; restart deterministically if so.
            if (this.queue.length > 0) void this.startProcessor();
        }
    }

    private tryDispatch(): void {
        if (this.queue.length === 0 || !this.networkExecutor) return;
        if (this.inFlightRequests.size >= this.concurrencyManager.limit) return;

        const request = this.queue[0]!;
        if (Date.now() >= request.deadlineAt) {
            this.queue.shift();
            request.reject(this.deadlineError(request));
            return;
        }
        if (this.inFlightRequests.size > 0 && this.inFlightTokens + request.estimatedTokens > SYSTEM_CONFIG.MAX_IN_FLIGHT_TOKENS) return;
        if (Date.now() - this.lastDispatchTime < SYSTEM_CONFIG.MIN_DISPATCH_INTERVAL_MS) return;

        const selected = this.selectHealthyProvider(request);
        if (!selected) return; // circuit breakers may recover before deadline

        this.queue.shift();
        request.providerIndex = selected.index;
        this.lastDispatchTime = Date.now();
        this.inFlightRequests.set(request.id, request);
        this.inFlightTokens += request.estimatedTokens;
        void this.executeNetworkCall(request, selected.provider);
    }

    private selectHealthyProvider(request: AIRequest): { provider: AIProviderKind; index: number } | null {
        for (let offset = 0; offset < request.providerSequence.length; offset++) {
            const index = (request.providerIndex + offset) % request.providerSequence.length;
            const provider = request.providerSequence[index]!;
            if (this.healthTracker.isHealthy(provider)) return { provider, index };
        }
        return null;
    }

    private async executeNetworkCall(req: AIRequest, provider: AIProviderKind): Promise<void> {
        try {
            const response = await this.networkExecutor!(req, provider);
            this.healthTracker.reportSuccess(provider);
            this.concurrencyManager.recordSuccess();
            this.finalizeRequest(req);
            req.resolve(response);
        } catch (error: any) {
            this.handleFailure(req, provider, error);
        }
    }

    private handleFailure(req: AIRequest, provider: AIProviderKind, error: any): void {
        this.finalizeRequest(req);
        this.healthTracker.reportFailure(provider, error);
        req.lastError = String(error?.message ?? error);

        if (/429|too many|rate.?limit|overload|capacity/i.test(req.lastError)) {
            this.concurrencyManager.recordOverload();
        }

        req.providerIndex++;
        if (req.providerIndex >= req.providerSequence.length) {
            req.providerIndex = 0;
            req.round++;
        }

        if (req.round >= SYSTEM_CONFIG.MAX_PROVIDER_ROUNDS || Date.now() >= req.deadlineAt) {
            req.reject(new Error(
                `PROVIDER_EXHAUSTED: ${req.providerSequence.join(', ')} failed after ${req.round + 1} round(s). ` +
                `Last error: ${req.lastError}`,
            ));
            return;
        }

        const delay = RetryHandler.calculateDelay(req.round);
        logger.warn('Provider request failed; scheduling next candidate', {
            provider,
            nextIndex: req.providerIndex,
            round: req.round,
            delay,
            error: req.lastError,
        });
        setTimeout(() => {
            if (Date.now() >= req.deadlineAt) {
                req.reject(this.deadlineError(req));
                return;
            }
            this.queue.unshift(req);
            void this.startProcessor();
        }, Math.min(delay, Math.max(0, req.deadlineAt - Date.now()))).unref();
    }

    private rejectExpired(): void {
        const now = Date.now();
        const retained: AIRequest[] = [];
        for (const request of this.queue) {
            if (now >= request.deadlineAt) request.reject(this.deadlineError(request));
            else retained.push(request);
        }
        this.queue = retained;
    }

    private deadlineError(req: AIRequest): Error {
        return new Error(
            `PROVIDER_TIMEOUT: request exceeded ${SYSTEM_CONFIG.REQUEST_DEADLINE_MS}ms without a usable provider.` +
            (req.lastError ? ` Last error: ${req.lastError}` : ''),
        );
    }

    private finalizeRequest(req: AIRequest): void {
        if (this.inFlightRequests.delete(req.id)) {
            this.inFlightTokens = Math.max(0, this.inFlightTokens - req.estimatedTokens);
        }
    }

    private contextText(context: unknown): string {
        if (typeof context === 'string') return context;
        if (Array.isArray(context)) {
            return context.map(item => {
                if (item && typeof item === 'object' && 'content' in item) return String((item as any).content ?? '');
                return String(item ?? '');
            }).join('\n');
        }
        return String(context ?? '');
    }

    getInternalMetrics(): {
        queueDepth: number;
        inFlightCount: number;
        inFlightTokens: number;
        concurrencyLimit: number;
    } {
        return {
            queueDepth: this.queue.length,
            inFlightCount: this.inFlightRequests.size,
            inFlightTokens: this.inFlightTokens,
            concurrencyLimit: this.concurrencyManager.limit,
        };
    }
}
