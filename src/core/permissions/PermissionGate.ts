import inquirer from 'inquirer';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface PermissionRequest {
    action: string;
    description: string;
    affectedFiles: string[];
    riskLevel: RiskLevel;
    isDestructive?: boolean;
    canUndo?: boolean;
}

export interface PermissionOptions {
    autoApprove?: boolean;
    blockDestructive?: boolean;
    logFile?: string;
}

export class PermissionGate {
    constructor(private options: PermissionOptions = {}) {}

    async requestPermission(request: PermissionRequest): Promise<boolean> {
        if (request.isDestructive && this.options.blockDestructive) {
            console.log(chalk.red(`\nBlocked: "${request.action}" is a destructive action and --no-destructive flag is set.`));
            this.log(request, false, 'blocked-destructive');
            return false;
        }

        if (this.options.autoApprove) {
            this.log(request, true, 'auto-approved');
            return true;
        }

        this.displayPermissionBox(request);

        const { approved } = await inquirer.prompt([{
            type: 'confirm',
            name: 'approved',
            message: `Allow this action?`,
            default: request.riskLevel === 'low',
        }]);

        this.log(request, approved, approved ? 'approved' : 'denied');
        return approved;
    }

    private displayPermissionBox(request: PermissionRequest): void {
        const riskColor = {
            low: chalk.green,
            medium: chalk.yellow,
            high: chalk.red,
            critical: chalk.bgRed.white,
        }[request.riskLevel];

        console.log('');
        console.log(chalk.bold('  Permission Required'));
        console.log(chalk.gray('  ' + '─'.repeat(56)));
        console.log(`  Action:   ${chalk.bold(request.action)}`);
        console.log(`  Risk:     ${riskColor(request.riskLevel.toUpperCase())}`);
        console.log(`  Details:  ${chalk.gray(request.description)}`);
        if (request.isDestructive) console.log(`  Warning:  ${chalk.red('This action is DESTRUCTIVE')}`);
        if (request.canUndo === false) console.log(`  Undo:     ${chalk.red('Cannot be undone')}`);
        if (request.affectedFiles.length > 0) {
            console.log(`  Files (${request.affectedFiles.length}):`);
            request.affectedFiles.slice(0, 5).forEach(f => {
                console.log(`    ${chalk.gray('▸')} ${f}`);
            });
            if (request.affectedFiles.length > 5) {
                console.log(chalk.gray(`    ... and ${request.affectedFiles.length - 5} more`));
            }
        }
        console.log(chalk.gray('  ' + '─'.repeat(56)));
    }

    private log(request: PermissionRequest, approved: boolean, reason: string): void {
        if (!this.options.logFile) return;
        try {
            const entry = JSON.stringify({
                timestamp: new Date().toISOString(),
                action: request.action,
                riskLevel: request.riskLevel,
                approved,
                reason,
                affectedFiles: request.affectedFiles,
            }) + '\n';
            fs.appendFileSync(this.options.logFile, entry, 'utf8');
        } catch (err) {
            logger.debug('Failed to write permission log', { error: String(err) });
        }
    }
}
