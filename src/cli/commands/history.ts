import { Command } from 'commander';
import path from 'path';
import chalk from 'chalk';
import Table from 'cli-table3';
import { loadContext } from '../context.js';

export function historyCommand(): Command {
    return new Command('history')
        .description('View history of AI-applied changes')
        .option('-n, --limit <n>', 'Number of records to show', '20')
        .option('--file <file>', 'Filter by file')
        .option('--session <id>', 'Filter by session ID')
        .action(async (opts: any) => {
            const ctx = await loadContext();
            if (!ctx) return;

            const { history } = ctx;
            const limit = parseInt(opts.limit as string, 10);

            let records;
            if (opts.file) {
                const abs = path.resolve(process.cwd(), opts.file as string);
                records = history.getByFile(abs, limit);
            } else if (opts.session) {
                records = history.getBySession(opts.session as string);
            } else {
                records = history.getRecent(limit);
            }

            if (records.length === 0) {
                console.log(chalk.yellow('No change history found.'));
                return;
            }

            const table = new Table({
                head: [
                    chalk.cyan('ID'),
                    chalk.cyan('File'),
                    chalk.cyan('Provider'),
                    chalk.cyan('Applied At'),
                    chalk.cyan('Confidence'),
                    chalk.cyan('Status'),
                ],
                colWidths: [10, 40, 12, 25, 12, 12],
            });

            for (const rec of records) {
                table.push([
                    rec.id.slice(0, 8),
                    path.relative(process.cwd(), rec.filePath),
                    rec.provider,
                    new Date(rec.appliedAt).toLocaleString(),
                    `${(rec.confidence * 100).toFixed(0)}%`,
                    rec.rolledBack ? chalk.yellow('rolled back') : chalk.green('active'),
                ]);
            }

            console.log('\nChange History:\n');
            console.log(table.toString());
            console.log(chalk.gray(`\nShowing ${records.length} record(s). Use 'cos rollback <id>' to revert a change.`));
        });
}