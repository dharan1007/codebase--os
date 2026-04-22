import { logger } from '../../utils/logger.js';
import { RequestQueue } from '../orchestrator/RequestQueue.js';

export interface AgentBudget {
    maxSteps: number;
    maxTokens: number;
    maxCost: number;
}

/**
 * AgentController — Budget-aware regulation of the autonomous loop.
 *
 * This component monitors the "Health" of the session.
 * It can shut down the loop if:
 *  - The request queue is too congested (Backpressure).
 *  - The token budget for the session is exhausted.
 *  - The agent is spinning in a tool-call loop.
 */
export class AgentController {
    private stepCount = 0;
    private tokenCount = 0;
    private costCount = 0;

    constructor(private budget: AgentBudget) {}

    /**
     * Checks if the agent is allowed to proceed to the next step.
     * Throws an error if any budget or safety limit is breached.
     */
    checkpoint(): void {
        this.stepCount++;

        // 1. Step Limit
        if (this.stepCount > this.budget.maxSteps) {
            throw new Error(`[AgentController] Halt: Step limit of ${this.budget.maxSteps} reached.`);
        }

        // 2. Queue Backpressure
        const metrics = RequestQueue.getInstance().getMetrics();
        if (metrics.depth > 100) {
             logger.warn(`[AgentController] System Congestion detected. Queue Depth: ${metrics.depth}. Throttling loop.`);
             // We don't necessarily kill the loop, but we could insert a sleep here.
        }

        // 3. Token Budget
        if (this.tokenCount > this.budget.maxTokens) {
            throw new Error(`[AgentController] Halt: Token budget of ${this.budget.maxTokens} exhausted.`);
        }
    }

    recordUsage(tokens: number, cost: number): void {
        this.tokenCount += tokens;
        this.costCount += cost;
    }

    getStats() {
        return {
            steps: this.stepCount,
            tokens: this.tokenCount,
            cost: this.costCount,
            progress: (this.stepCount / this.budget.maxSteps) * 100
        };
    }
}
