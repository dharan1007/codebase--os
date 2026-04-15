import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import inquirer from 'inquirer';
import Table from 'cli-table3';
import { loadContext } from '../context.js';

export function rollbackCommand(): Command {
    return new Command('rollback')
        .description('Roll back AI-applied changes')
        .argument('[changeId]', 'Specific change ID to roll back (omit to list recent changes)')
        .option('--session <id>', 'Roll back all changes from a session')
        .option('--file <file>', 'Roll back all changes to a specific file')
        .action(async (changeId: string | undefined, opts: any) => {
            const ctx = await loadContext();
            if (!ctx) return;

            const { history } = ctx;

            if (!changeId && !opts.session && !opts.file) {
                const records = history.getRecent(20).filter(r => !r.rolledBack);

                if (records.length === 0) {
                    console.log(chalk.green('No changes to roll back.'));
                    return;
                }

                const table = new Table({
                    head: [chalk.cyan('ID'), chalk.cyan('File'), chalk.cyan('Provider'), chalk.cyan('Applied At'), chalk.cyan('Confidence')],
                    colWidths: [12, 40, 12, 25, 12],
                });

                for (const rec of records) {
                    table.push([
                        rec.id.slice(0, 8),
                        path.relative(process.cwd(), rec.filePath),
                        rec.provider,
                        new Date(rec.appliedAt).toLocaleString(),
                        `${(rec.confidence * 100).toFixed(0)}%`,
                    ]);
                }

                console.log('\nRecent applied changes:\n');
                console.log(table.toString());
                console.log(chalk.gray('\nRun: cos rollback <changeId>'));
                return;
            }

            let targetId = changeId;

            if (opts.file) {
                const absolutePath = path.resolve(process.cwd(), opts.file as string);
                const records = history.getActiveByFile(absolutePath);
                if (records.length === 0) {
                    console.log(chalk.yellow(`No active changes found for: ${opts.file}`));
                    return;
                }
                targetId = records[records.length - 1]!.id;
            }

            if (opts.session) {
                const records = history.getBySession(opts.session as string).filter(r => !r.rolledBack);
                if (records.length === 0) {
                    console.log(chalk.yellow(`No active changes found for session: ${opts.session}`));
                    return;
                }

                const { confirm } = await inquirer.prompt([{
                    type: 'confirm', name: 'confirm',
                    message: `Roll back ${records.length} change(s) from session ${(opts.session as string).slice(0, 8)}?`,
                    default: false,
                }]);
                if (!confirm) return;

                for (const rec of records) {
                    fs.writeFileSync(rec.filePath, rec.originalContent, 'utf8');
                    history.markRolledBack(rec.id);
                    console.log(chalk.green(`  ✓ Rolled back: ${path.relative(process.cwd(), rec.filePath)}`));
                }
                return;
            }

            if (!targetId) return;

            const record = history.getById(targetId);
            if (!record) {
                console.log(chalk.red(`Change not found: ${targetId}`));
                process.exit(1);
            }
            if (record.rolledBack) {
                console.log(chalk.yellow(`Change ${targetId.slice(0, 8)} is already rolled back.`));
                return;
            }

            console.log(`\nRolling back change to: ${chalk.cyan(path.relative(process.cwd(), record.filePath))}`);
            console.log(`Applied: ${new Date(record.appliedAt).toLocaleString()} (confidence: ${(record.confidence * 100).toFixed(0)}%)`);

            const { confirm } = await inquirer.prompt([{
                type: 'confirm', name: 'confirm',
                message: 'Proceed with rollback?',
                default: true,
            }]);

            if (!confirm) {
                console.log(chalk.yellow('Rollback cancelled.'));
                return;
            }

            fs.writeFileSync(record.filePath, record.originalContent, 'utf8');
            history.markRolledBack(record.id);

            console.log(chalk.green(`\n✓ Rolled back successfully`));
        });
}