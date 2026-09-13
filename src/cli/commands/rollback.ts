import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import inquirer from 'inquirer';
import Table from 'cli-table3';
import { loadContext } from '../context.js';
import type { ChangeRecord } from '../../types/index.js';
import type { ChangeHistory } from '../../storage/ChangeHistory.js';
import { resolveWithinRoot } from '../../core/security/PathPolicy.js';

interface RollbackResult {
    success: boolean;
    message: string;
}

function readCurrent(filePath: string, rootDir: string): string | null {
    const resolved = resolveWithinRoot(filePath, rootDir, filePath);
    if (!fs.existsSync(resolved)) return null;
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;
    return fs.readFileSync(resolved, 'utf8');
}

/**
 * Applies an inverse change only when the filesystem still exactly matches the
 * recorded post-change state. Every stored path is revalidated against the
 * current real filesystem immediately before mutation so a later symlink swap
 * cannot redirect rollback outside the repository.
 */
function applyRollback(
    record: ChangeRecord,
    history: ChangeHistory,
    rootDir: string,
): RollbackResult {
    try {
        const operation = record.operation ?? 'modify';
        const destination = resolveWithinRoot(record.filePath, rootDir, record.filePath);
        const source = record.sourcePath
            ? resolveWithinRoot(record.sourcePath, rootDir, record.sourcePath)
            : undefined;

        if (operation === 'modify') {
            const current = readCurrent(destination, rootDir);
            if (current === null) {
                return { success: false, message: `Conflict: modified file no longer exists: ${record.filePath}` };
            }
            if (current !== record.updatedContent) {
                return { success: false, message: `Conflict: ${record.filePath} changed after this transaction. Refusing to overwrite newer work.` };
            }
            resolveWithinRoot(destination, rootDir, record.filePath);
            fs.writeFileSync(destination, record.originalContent, 'utf8');
        } else if (operation === 'create') {
            const current = readCurrent(destination, rootDir);
            if (current === null) {
                return { success: false, message: `Conflict: created file is already absent: ${record.filePath}` };
            }
            if (current !== record.updatedContent) {
                return { success: false, message: `Conflict: created file ${record.filePath} was subsequently changed. Refusing to delete it.` };
            }
            resolveWithinRoot(destination, rootDir, record.filePath);
            fs.unlinkSync(destination);
        } else if (operation === 'delete') {
            if (fs.existsSync(destination)) {
                return { success: false, message: `Conflict: ${record.filePath} exists again. Refusing to overwrite the newer file.` };
            }
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            resolveWithinRoot(destination, rootDir, record.filePath);
            fs.writeFileSync(destination, record.originalContent, { encoding: 'utf8', flag: 'wx' });
        } else if (operation === 'move') {
            if (!source) {
                return { success: false, message: `Invalid move record ${record.id}: source path is missing.` };
            }
            if (fs.existsSync(source)) {
                return { success: false, message: `Conflict: original move source exists again: ${record.sourcePath}` };
            }
            const current = readCurrent(destination, rootDir);
            if (current === null) {
                return { success: false, message: `Conflict: move destination is missing: ${record.filePath}` };
            }
            if (current !== record.updatedContent) {
                return { success: false, message: `Conflict: move destination ${record.filePath} changed after the move.` };
            }
            fs.mkdirSync(path.dirname(source), { recursive: true });
            resolveWithinRoot(source, rootDir, record.sourcePath!);
            resolveWithinRoot(destination, rootDir, record.filePath);
            fs.renameSync(destination, source);
        } else {
            return { success: false, message: `Unsupported rollback operation: ${String(operation)}` };
        }

        history.markRolledBack(record.id);
        return { success: true, message: `Rolled back ${operation}: ${record.filePath}` };
    } catch (err) {
        return { success: false, message: `Rollback safety check failed: ${String(err)}` };
    }
}

export function rollbackCommand(): Command {
    return new Command('rollback')
        .description('Roll back recorded Codebase OS changes with conflict and path-safety checks')
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
                    head: [chalk.cyan('ID'), chalk.cyan('Op'), chalk.cyan('File'), chalk.cyan('Provider'), chalk.cyan('Applied At')],
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
                    type: 'confirm', name: 'confirm',
                    message: `Roll back ${records.length} transaction(s) from session ${String(opts.session).slice(0, 8)}?`,
                    default: false,
                }]);
                if (!confirm) return;

                for (const record of records) {
                    const result = applyRollback(record, history, config.rootDir);
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
                let absolutePath: string;
                try {
                    absolutePath = resolveWithinRoot(String(opts.file), config.rootDir, String(opts.file));
                } catch (err) {
                    console.log(chalk.red(String(err)));
                    process.exitCode = 1;
                    return;
                }
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
                type: 'confirm', name: 'confirm',
                message: 'Proceed only if the filesystem still matches the recorded post-change state?',
                default: true,
            }]);
            if (!confirm) {
                console.log(chalk.yellow('Rollback cancelled.'));
                return;
            }

            const result = applyRollback(record, history, config.rootDir);
            if (!result.success) {
                console.log(chalk.red(`\n✗ ${result.message}`));
                process.exitCode = 1;
                return;
            }
            console.log(chalk.green(`\n✓ ${result.message}`));
        });
}
