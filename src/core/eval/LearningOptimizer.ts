import { Database } from '../../storage/Database.js';
import type { ProjectConfig } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

export class LearningOptimizer {
    constructor(private db: Database) {}

    optimize(config: ProjectConfig): ProjectConfig {
        try {
            const rows = this.db.prepare(`
                SELECT taskProfile, AVG(successRate) as avgSuccess, COUNT(*) as vol
                FROM eval_metrics
                GROUP BY taskProfile
            `).all() as Array<{ taskProfile: string; avgSuccess: number; vol: number }>;

            let newConfig = { ...config };

            for (const row of rows) {
                if (row.vol >= 5 && row.avgSuccess < 0.6) {
                    logger.warn(`[LEARNING OPTIMIZER] Task Profile '${row.taskProfile}' is underperforming (Success: ${(row.avgSuccess * 100).toFixed(1)}%). Scaling up model selection.`);
                    
                    if (!newConfig.ai.model) continue;
                    
                    if (newConfig.ai.model.includes('flash')) {
                        newConfig.ai.model = 'gemini-1.5-pro';
                    } else if (newConfig.ai.model.includes('mini')) {
                        newConfig.ai.model = 'gpt-4o';
                    } else if (newConfig.ai.model.includes('haiku')) {
                        newConfig.ai.model = 'claude-3-5-sonnet-latest';
                    }
                }
            }

            return newConfig;
        } catch (err) {
            logger.error('LearningOptimizer failed to calculate new heuristics', { error: String(err) });
            return config;
        }
    }
}
