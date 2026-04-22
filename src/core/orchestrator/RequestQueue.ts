import { logger } from '../../utils/logger.js';
import type { ModelRequest, ModelResponse } from '../../types/index.js';
import { TrafficController } from './TrafficController.js';
import crypto from 'crypto';

export interface PriorityRequest {
    id: string;
    priority: number; // 0 (low) to 10 (high)
    fn: () => Promise<ModelResponse>;
    enqueuedAt: number;
    userId: string;
}

/**
 * RequestQueue — Global Priority-Based AI Execution Queue.
 *
 * This system decouples LLM generation from the Agent Loop.
 * Features:
 *  - CONCURRENCY CONTROL: Limits parallel API calls globally.
 *  - BACKPRESSURE: Rejects requests when the queue is saturated.
 *  - PRIORITY: Reasoning tasks skip Scanner embedding tasks.
 *  - USER ISOLATION: Fair-share scheduling (todo: implement per-user weights).
 */
export class RequestQueue {
    private static instance: RequestQueue;
    private queue: PriorityRequest[] = [];
    private running = 0;
    private readonly MAX_CONCURRENCY = 8;
    private readonly MAX_QUEUE_SIZE = 500;

    private constructor() {}

    static getInstance(): RequestQueue {
        if (!RequestQueue.instance) {
            RequestQueue.instance = new RequestQueue();
        }
        return RequestQueue.instance;
    }

    /**
     * Enqueue a request for execution.
     */
    async enqueue(
        fn: () => Promise<ModelResponse>,
        priority: number = 5,
        userId: string = 'default'
    ): Promise<ModelResponse> {
        if (this.queue.length >= this.MAX_QUEUE_SIZE) {
            throw new Error(`[RequestQueue] Critical Congestion: Queue depth ${this.queue.length} exceeded.`);
        }

        return new Promise<ModelResponse>((resolve, reject) => {
            const request: PriorityRequest = {
                id: crypto.randomUUID(),
                priority,
                fn,
                enqueuedAt: Date.now(),
                userId
            };

            this.queue.push(request);
            this.queue.sort((a, b) => b.priority - a.priority); // High priority first

            logger.debug(`[RequestQueue] Enqueued request ${request.id}`, { 
                priority, 
                queueDepth: this.queue.length 
            });

            this.process();

            // Bridge to the promise
            const checkInterval = setInterval(() => {
                // This is a crude bridge — ideally use an EventEmitter
            }, 100);
            
            // Re-wrapping the fn to resolve/reject the outer promise
            const originalFn = request.fn;
            request.fn = async () => {
                try {
                    const res = await originalFn();
                    resolve(res);
                    return res;
                } catch (err) {
                    reject(err);
                    throw err;
                }
            };
        });
    }



    private async process(): Promise<void> {
        if (this.running >= this.MAX_CONCURRENCY || this.queue.length === 0) {
            return;
        }

        const request = this.queue.shift();
        if (!request) return;

        this.running++;
        const waitTime = Date.now() - request.enqueuedAt;
        if (waitTime > 5000) {
            logger.warn(`[RequestQueue] Slow response: Request ${request.id} waited ${waitTime}ms in queue.`);
        }

        try {
            // Use TrafficController to ensure paced execution and adaptive backoff
            await TrafficController.executePaced(async () => {
                return await request.fn();
            }, `Queue:${request.id}`);
        } catch (err) {
            // Error is handled inside the wrapped fn
        } finally {
            this.running--;
            // Recursively process next item
            setImmediate(() => this.process());
        }
    }

    /**
     * Get current congestion metrics.
     */
    getMetrics() {
        return {
            depth: this.queue.length,
            running: this.running,
            utilization: (this.running / this.MAX_CONCURRENCY) * 100
        };
    }
}
