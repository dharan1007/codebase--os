import { Database } from '../../storage/Database.js';
import type { AgentResult } from '../ai/AgentLoop.js';
import { logger } from '../../utils/logger.js';
import crypto from 'crypto';

export interface EvaluationMetric {
    sessionId: string;
    taskProfile: string;
    durationMs: number;
    tokensUsed: number;
    successRate: number;
    regressionDetected: boolean;
    costEstimate: number;
    provider: string;
    model: string;
    timestamp: number;
}

export class EvalTracker {
    constructor(private db: Database) {}

    init() {
        this.db.prepare(`
            CREATE TABLE IF NOT EXISTS eval_metrics (
                id TEXT PRIMARY KEY,
                sessionId TEXT NOT NULL,
                taskProfile TEXT NOT NULL,
                durationMs INTEGER NOT NULL,
                tokensUsed INTEGER NOT NULL,
                successRate REAL NOT NULL,
                regressionDetected INTEGER NOT NULL,
                costEstimate REAL NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                timestamp INTEGER NOT NULL
            )
        `).run();
    }

    trackSession(
        sessionId: string,
        taskProfile: string,
        startTime: number,
        result: AgentResult,
        tokensUsed: number,
        provider: string,
        model: string
    ) {
        try {
            const durationMs = Date.now() - startTime;
            
            const successfulSteps = result.steps.filter(s => s.result.success).length;
            const successRate = result.steps.length > 0 ? (successfulSteps / result.steps.length) : (result.success ? 1 : 0);

            // Rough token cost estimate
            const tokenCostAvg = 0.0000005; 
            const costEstimate = tokensUsed * tokenCostAvg;

            const regressionDetected = result.outageDetected || result.tasklist.some((t: string) => t.includes('test fail') || t.includes('regression'));

            const metric: EvaluationMetric = {
                sessionId,
                taskProfile,
                durationMs,
                tokensUsed,
                successRate,
                regressionDetected: !!regressionDetected,
                costEstimate,
                provider,
                model,
                timestamp: Date.now()
            };

            this.db.prepare(`
                INSERT INTO eval_metrics (id, sessionId, taskProfile, durationMs, tokensUsed, successRate, regressionDetected, costEstimate, provider, model, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                crypto.randomUUID(),
                metric.sessionId,
                metric.taskProfile,
                metric.durationMs,
                metric.tokensUsed,
                metric.successRate,
                metric.regressionDetected ? 1 : 0,
                metric.costEstimate,
                metric.provider,
                metric.model,
                metric.timestamp
            );

            logger.info(`[EVALUATION] Tracked Session - Cost: $${costEstimate.toFixed(5)}, Time: ${durationMs}ms, Success: ${(successRate * 100).toFixed(1)}%`);
        } catch (err) {
            logger.error('Failed to log evaluation metric', { error: String(err) });
        }
    }
}
