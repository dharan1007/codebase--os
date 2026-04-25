import { TrafficController } from './TrafficController.js';

/**
 * RequestQueue — Legacy Facade for AI execution metrics.
 * 
 * Replaced by the robust TrafficController in Sovereign Edition.
 * This class now serves as a bridge for metrics integration (e.g. AgentController).
 */
export class RequestQueue {
    private static instance: RequestQueue;

    private constructor() {}

    static getInstance(): RequestQueue {
        if (!RequestQueue.instance) {
            RequestQueue.instance = new RequestQueue();
        }
        return RequestQueue.instance;
    }

    /**
     * Get current congestion metrics from the TrafficController.
     */
    getMetrics() {
        const controller = TrafficController.getInstance();
        const metrics = controller.getInternalMetrics();
        
        return {
            depth: metrics.queueDepth,
            running: metrics.inFlightCount,
            utilization: (metrics.inFlightCount / 4) * 100 // Normalized to new concurrency cap
        };
    }
    
    // Legacy enqueue method for safety (deprecated)
    async enqueue(fn: any): Promise<any> {
       return await fn();
    }
}
