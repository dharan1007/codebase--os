import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.js';
import type { AIProviderKind, ModelRequest, ModelResponse } from '../../types/index.js';
import { ProviderHealthTracker } from './ProviderHealthTracker.js';

// --- CONFIGURATION ---
const SYSTEM_CONFIG = {
    MIN_DISPATCH_INTERVAL_MS: 800,
    MAX_CONCURRENCY: 4,
    MAX_PAYLOAD_TOKENS: 60000,
    MAX_RETRIES: 5,
    BASE_BACKOFF_MS: 1500,
    CAP_BACKOFF_MS: 60000,
    MAX_IN_FLIGHT_TOKENS: 80000 
};

export interface AIRequest {
    id: string;
    requestDetails: ModelRequest;
    providerSequence: AIProviderKind[];
    attempt: number;
    estimatedTokens: number;
    resolve: (value: ModelResponse) => void;
    reject: (reason: any) => void;
}

export class TokenEstimator {
    static estimate(text: string): number {
        if (!text) return 0;
        return Math.ceil(text.length / 3.5);
    }
}

export class RetryHandler {
    static calculateDelay(attempt: number): number {
        const standardBackoff = Math.min(
            SYSTEM_CONFIG.CAP_BACKOFF_MS,
            SYSTEM_CONFIG.BASE_BACKOFF_MS * Math.pow(2, attempt)
        );
        return Math.floor(Math.random() * standardBackoff);
    }
}

export class AdaptiveConcurrencyManager {
    public limit = 1; // Boot in warm-up mode

    recordSuccess() {
        if (this.limit < SYSTEM_CONFIG.MAX_CONCURRENCY) {
            this.limit++;
            logger.debug(`[CONCURRENCY] Scaling up: ${this.limit}`);
        }
    }

    recordFailure() {
        if (this.limit > 1) {
            this.limit = 1; // Snap back to safe mode securely.
            logger.warn(`[CONCURRENCY] Overload handled. Scaling down dynamically to: ${this.limit}`);
        }
    }
}

export class TrafficController extends EventEmitter {
    private static instance: TrafficController;
    private queue: AIRequest[] = [];
    private inFlightRequests: Map<string, AIRequest> = new Map();
    private inFlightTokens: number = 0;
    
    private concurrencyManager = new AdaptiveConcurrencyManager();
    private healthTracker = ProviderHealthTracker.getInstance();
    
    private lastDispatchTime: number = 0;
    private isProcessorRunning: boolean = false;
    
    // Injected by orchestrator
    private networkExecutor?: (req: AIRequest, provider: AIProviderKind) => Promise<ModelResponse>;

    private constructor() {
        super();
    }

    static getInstance(): TrafficController {
        if (!TrafficController.instance) {
            TrafficController.instance = new TrafficController();
        }
        return TrafficController.instance;
    }

    setNetworkExecutor(executor: (req: AIRequest, provider: AIProviderKind) => Promise<ModelResponse>) {
        this.networkExecutor = executor;
    }

    public async schedule(requestDetails: ModelRequest, providerSequence: AIProviderKind[]): Promise<ModelResponse> {
        let estimatedLen = 0;
        if (Array.isArray(requestDetails.context)) {
            estimatedLen = requestDetails.context.reduce((acc, c) => acc + (typeof c.content === 'string' ? c.content.length : 0), 0);
        } else if (typeof requestDetails.context === 'string') {
            estimatedLen = requestDetails.context.length;
        }
        
        return new Promise((resolve, reject) => {
            const req: AIRequest = {
                id: Math.random().toString(36).substring(7),
                requestDetails,
                providerSequence,
                attempt: 0,
                estimatedTokens: Math.ceil(estimatedLen / 3.5),
                resolve,
                reject
            };
            this.queue.push(req);
            this.startProcessor();
        });
    }

    private async startProcessor() {
        if (this.isProcessorRunning) return;
        this.isProcessorRunning = true;

        while (this.queue.length > 0 || this.inFlightRequests.size > 0) {
            this.tryDispatch();
            await new Promise(r => setTimeout(r, 50)); 
        }

        this.isProcessorRunning = false;
    }

    private tryDispatch() {
        if (this.queue.length === 0) return;
        if (!this.networkExecutor) return;

        // 1. Max Concurrency check
        if (this.inFlightRequests.size >= this.concurrencyManager.limit) return;

        // 2. Token Limit Pacing
        const nextReq = this.queue[0];
        if (this.inFlightRequests.size > 0 && (this.inFlightTokens + nextReq.estimatedTokens) > SYSTEM_CONFIG.MAX_IN_FLIGHT_TOKENS) {
            return; 
        }

        // 3. Spaced Staggering Check
        const now = Date.now();
        if ((now - this.lastDispatchTime) < SYSTEM_CONFIG.MIN_DISPATCH_INTERVAL_MS) {
            return;
        }

        // 4. Determine optimal provider based on sequence
        let targetProvider: AIProviderKind | null = null;
        for (const p of nextReq.providerSequence) {
            if (this.healthTracker.isHealthy(p)) {
                targetProvider = p;
                break;
            }
        }

        if (!targetProvider) {
            // All requested providers are locked via circuit breaker. Pause entirely.
            return;
        }

        this.lastDispatchTime = Date.now();
        const request = this.queue.shift()!;
        
        this.inFlightRequests.set(request.id, request);
        this.inFlightTokens += request.estimatedTokens;

        this.executeNetworkCall(request, targetProvider);
    }

    private async executeNetworkCall(req: AIRequest, provider: AIProviderKind) {
        try {
            if (!this.networkExecutor) throw new Error("Executor missing");
            const response = await this.networkExecutor(req, provider);
            
            this.healthTracker.reportSuccess(provider);
            this.concurrencyManager.recordSuccess();
            
            this.finalizeRequest(req);
            req.resolve(response);

        } catch (error: any) {
            this.handleFailure(req, provider, error);
        }
    }

    private handleFailure(req: AIRequest, provider: AIProviderKind, error: any) {
        this.finalizeRequest(req);

        // Treat strictly: report failure to immediately penalize provider
        this.healthTracker.reportFailure(provider, error);

        const msg = String(error?.message || error).toLowerCase();
        if (msg.includes('429') || msg.includes('too many') || msg.includes('rate')) {
            this.concurrencyManager.recordFailure();
        }

        req.attempt++;
        if (req.attempt >= SYSTEM_CONFIG.MAX_RETRIES) {
            req.reject(new Error(`Max retries exceeded for AI Request. Last Error: ${error?.message || error}`));
            return;
        }

        const delay = RetryHandler.calculateDelay(req.attempt);
        logger.warn(`[TrafficController] Request failed. Backing off for ${delay}ms before requeueing. Provider: ${provider}`);
        
        setTimeout(() => {
            this.queue.unshift(req);
            this.startProcessor();
        }, delay);
    }

    private finalizeRequest(req: AIRequest) {
        this.inFlightRequests.delete(req.id);
        this.inFlightTokens -= req.estimatedTokens;
        if (this.inFlightTokens < 0) this.inFlightTokens = 0; 
    }

    public getInternalMetrics() {
        return {
            queueDepth: this.queue.length,
            inFlightCount: this.inFlightRequests.size,
            inFlightTokens: this.inFlightTokens,
            concurrencyLimit: this.concurrencyManager.limit
        };
    }
}
