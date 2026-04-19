import { Database } from '../../storage/Database.js';
import { ChangeHistory } from '../../storage/ChangeHistory.js';
import { logger } from '../../utils/logger.js';
import type { FailureCategory } from '../../types/index.js';
import { FailureStore } from '../failure/FailureStore.js';
import chalk from 'chalk';
import fs from 'fs';

export interface FailureReport {
    id: string;
    category: FailureCategory;
    filePath: string;
    details: string;
    canAutoFix: boolean;
    suggestedAction: string;
    isRecurring?: boolean;
}

export class FailureManager {
    constructor(
        private db: Database,
        private history: ChangeHistory,
        private store: FailureStore
    ) {}

    init() {
        this.store.init();
    }

    async handleFailure(category: FailureCategory, filePath: string, details: string): Promise<FailureReport> {
        // Capture context for the intelligence system
        let context = '[No context available]';
        try {
            if (fs.existsSync(filePath)) {
                context = fs.readFileSync(filePath, 'utf8').slice(0, 5000);
            }
        } catch {}

        const snapshot = await this.store.record(category, filePath, details, context);
        
        let suggestedAction = 'Check the logs for more details.';
        let canAutoFix = false;

        if (snapshot.frequency >= 3) {
            suggestedAction = chalk.bold.red('ROOT CAUSE MODE RECOMMENDED: ') + 'This failure is recurring frequently. Triggering deep analysis...';
        } else {
            switch (category) {
                case 'test_regression':
                    suggestedAction = 'Reverting change automatically...';
                    canAutoFix = true;
                    await this.rollback(filePath);
                    break;
                case 'ai_timeout':
                    suggestedAction = 'The AI model took too long. Try a faster model or increase timeout.';
                    break;
                case 'parse_error':
                    suggestedAction = 'The output code was invalid. Check the syntax or refine constraints.';
                    break;
                case 'model_outage':
                    suggestedAction = 'Switch to a fallback AI provider in config.';
                    break;
            }
        }

        const report = { 
            id: snapshot.id, 
            category, 
            filePath, 
            details, 
            canAutoFix, 
            suggestedAction,
            isRecurring: snapshot.frequency >= 3
        };
        this.logReport(report, snapshot.frequency);
        return report;
    }

    private async rollback(filePath: string) {
        const latest = this.history.getLatestForFile(filePath);
        if (latest) {
            logger.warn(`FailureManager: Automatically rolling back regression in ${filePath}`);
        }
    }

    private logReport(report: FailureReport, frequency: number) {
        const title = frequency >= 3 ? ' ❗ RECURRING FAILURE DETECTED ' : ' ❗ FAILURE DETECTED ';
        console.log('\n' + chalk.bold.bgRed.white(title));
        console.log(`  Category:  ${chalk.bold(report.category)}`);
        console.log(`  File:      ${chalk.cyan(report.filePath)}`);
        console.log(`  Frequency: ${chalk.magenta(frequency + ' times')}`);
        console.log(`  Action:    ${chalk.yellow(report.suggestedAction)}`);
        
        logger.error('[FAILURE MANAGER] Detected issue', { 
            category: report.category,
            file: report.filePath,
            frequency,
            details: report.details
        });
    }
}

