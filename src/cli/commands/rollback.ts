import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import inquirer from 'inquirer';
import Table from 'cli-table3';
import { loadContext } from '../context.js';
import type { ChangeRecord } from '../../types/index.js';
import type { ChangeHistory } from '../../storage/ChangeHistory.js';

interface RollbackResult {
    success: boolean;
    message: string;
}

function readCurrent(filePath: string): string | null {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return fs.readFileSync(filePath, 'utf8');
}

/**
 * Applies an inverse change only when the filesystem still exactly matches the
 * recorded post-change state. This protects human/later-agent edits from being
 * clobbered by a stale rollback.
 */
function applyRollback(record: ChangeRecord, history: ChangeHistory): RollbackResult {
    const operation = record.operation ?? 'modify';

    if (operation === 'modify') {
        const current = readCurrent(record.filePath);
        if (current === null) {
            return { success: false, message: `Conflict: modified file no longer exists: ${record.filePath}` };
        }
        if (current !== record.updatedContent) {
            return {
                success: false,
                message: `Conflict: ${record.filePath} changed after this transaction. Refusing to overwrite newer work.`,
            };
        }
        fs.writeFileSync(record.filePath, record.originalContent, 'utf8');
    } else if (operation === 'create') {
        const current = readCurrent(record.filePath);
        if (current === null) {
            return { success: false, message: `Conflict: created file is already absent: ${record.filePath}` };
        }
        if (current !== record.updatedContent) {
            return {
                success: false,
                message: `Conflict: created file ${record.filePath} was subsequently changed. Refusing to delete it.`,
            };
        }
        fs.unlinkSync(record.filePath);
    } else if (operation === 'delete') {
        if (fs.existsSync(record.filePath)) {
            return {
                success: false,
                message: `Conflict: ${record.filePath} exists again. Refusing to overwrite the newer file.`,
            };
        }
        fs.mkdirSync(path.dirname(record.filePath), { recursive: true });
        fs.writeFileSync(record.filePath, record.originalContent, 'utf8');
    } else if (operation === 'move') {
        if (!record.sourcePath) {
            return { success: false, message: `Invalid move record ${record.id}: source path is missing.` };
        }
        if (fs.existsSync(record.sourcePath)) {
            return {
                success: false,
                message: `Conflict: original move source exists again: ${record.sourcePath}`,
            };
        }
        const current = readCurrent(record.filePath);
        if (current === null) {
            return { success: false, message: `Conflict: move destination is missing: ${record.filePath}` };
        }
        if (current !== record.updatedContent) {
            return {
                success: false,
                message: `Conflict: move destination ${record.filePath} changed after the move.`,
            };
        }
        fs.mkdirSync(path.dirname(record.sourcePath), { recursive: true });
        fs.renameSync(record.filePath, record.sourcePath);
    } else {
        return { success: false, message: `Unsupported rollback operation: ${String(operation)}` };
    }

    history.markRolledBack(record.id);
    return { success: true, message: `Rolled back ${operation}: ${record.filePath}` };
}

export function rollbackCommand(): Command {
    return new Command('rollback')
        .description('Roll back recorded Codebase OS changes with conflict detection')
        .argument('[changeId]', 'Specific change ID to roll back (omit to list recent changes)')
        .option('--session <id>', 'Roll back all active changes from a session in reverse order')
        .option('--file <file>', 'Roll back the latest active change affecting a specific file')
        .action(async (changeId: string | undefined, opts: any) => {
            const ctx = await loadContext();
            if (!ctx) return;
            const { history, config } = ctx;

            if (!changeId && !opts.session && !opts.file) {
                const records = history.getRecent(20).filter(record => !record.rolledBack);
                if (records.length === 0) {
                    console.log(chalk.green('No active recorded changes to roll back.'));
                    return;
                }

                const table = new Table({
                    head: [
                        chalk.cyan('ID'),
                        chalk.cyan('Op'),
                        chalk.cyan('File'),
                        chalk.cyan('Provider'),
                        chalk.cyan('Applied At'),
                    ],
                    colWidths: [12, 10, 42, 12, 24],
                });
                for (const record of records) {
                    table.push([
                        record.id.slice(0, 8),
                        record.operation ?? 'modify',
                        path.relative(config.rootDir, record.filePath),
                        record.provider,
                        new Date(record.appliedAt).toLocaleString(),
                    ]);
                }
                console.log('\nRecent active changes:\n');
                console.log(table.toString());
                console.log(chalk.gray('\nRun: cos rollback <changeId>'));
                return;
            }

            if (opts.session) {
                const records = history.getBySession(String(opts.session)).filter(record => !record.rolledBack);
                if (records.length === 0) {
                    console.log(chalk.yellow(`No active changes found for session: ${opts.session}`));
                    return;
                }

                const { confirm } = await inquirer.prompt([{
                    type: 'confirm',
                    name: 'confirm',
                    message: `Roll back ${records.length} transaction(s) from session ${String(opts.session).slice(0, 8)}?`,
                    default: false,
                }]);
                if (!confirm) return;

                // getBySession is newest-first. That is the required inverse order.
                for (const record of records) {
                    const result = applyRollback(record, history);
                    if (!result.success) {
                        console.log(chalk.red(`  ✗ ${result.message}`));
                        console.log(chalk.yellow('  Session rollback stopped at the first conflict. No newer work was overwritten.'));
                        process.exitCode = 1;
                        return;
                    }
                    console.log(chalk.green(`  ✓ ${result.message}`));
                }
                return;
            }

            let targetId = changeId;
            if (opts.file) {
                const absolutePath = path.resolve(config.rootDir, String(opts.file));
                const records = history.getActiveByFile(absolutePath);
                if (records.length === 0) {
                    console.log(chalk.yellow(`No active changes found for: ${opts.file}`));
                    return;
                }
                targetId = records[0]!.id;
            }
            if (!targetId) return;

            const record = history.getById(targetId);
            if (!record) {
                console.log(chalk.red(`Change not found: ${targetId}`));
                process.exitCode = 1;
                return;
            }
            if (record.rolledBack) {
                console.log(chalk.yellow(`Change ${targetId.slice(0, 8)} is already rolled back.`));
                return;
            }

            console.log(`\nTransaction: ${chalk.cyan(record.operation ?? 'modify')} ${chalk.cyan(path.relative(config.rootDir, record.filePath))}`);
            console.log(`Applied: ${new Date(record.appliedAt).toLocaleString()}`);
            const { confirm } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirm',
                message: 'Proceed only if the filesystem still matches the recorded post-change state?',
                default: true,
            }]);
            if (!confirm) {
                console.log(chalk.yellow('Rollback cancelled.'));
                return;
            }

            const result = applyRollback(record, history);
            if (!result.success) {
                console.log(chalk.red(`\n✗ ${result.message}`));
                process.exitCode = 1;
                return;
            }
            console.log(chalk.green(`\n✓ ${result.message}`));
        });
}
