import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { loadContext } from '../context.js';
import { ImpactAnalyzer } from '../../core/impact/ImpactAnalyzer.js';
import { TaskDecomposer } from '../../core/ai/TaskDecomposer.js';
import { ChangeExecutor } from '../../core/ai/ChangeExecutor.js';
import { AIProviderFactory } from '../../core/ai/AIProviderFactory.js';
import { TypeScriptAnalyzer } from '../../core/scanner/TypeScriptAnalyzer.js';
import type { FileChange } from '../../types/index.js';
import { v4 as uuidv4 } from 'uuid';
import { RichFormatter } from '../../core/output/RichFormatter.js';

export function applyCommand(): Command {
    return new Command('apply')
        .description('AI-driven: analyze impact and apply fixes for a changed file')
        .argument('<file>', 'The file that was changed')
        .option('--type <type>', 'Change type (modified|added|deleted)', 'modified')
        .option('--dry-run', 'Preview changes without applying them')
        .option('--no-confirm', 'Apply without confirmation prompts')
        .option('--confidence <level>', 'Minimum confidence threshold (0-1)', '0.6')
        .action(async (file: string, opts: any) => {
            const ctx = await loadContext();
            if (!ctx) return;

            const { config, graph, db, history, sessionId } = ctx;

            const absolutePath = path.resolve(process.cwd(), file);
            const tsAnalyzer = new TypeScriptAnalyzer(config.rootDir);

            let provider;
            try {
                provider = AIProviderFactory.create(config);
            } catch (err) {
                console.log(chalk.red(`AI provider error: ${String(err)}`));
                process.exit(1);
            }

            const analyzer = new ImpactAnalyzer(graph, tsAnalyzer, db);
            const decomposer = new TaskDecomposer(provider);
            const executor = new ChangeExecutor(provider, config, history, sessionId);
            const minConfidence = parseFloat(opts.confidence as string);

            const content = opts.type !== 'deleted' && fs.existsSync(absolutePath)
                ? fs.readFileSync(absolutePath, 'utf8')
                : undefined;

            const change: FileChange = {
                id: uuidv4(),
                filePath: absolutePath,
                changeType: opts.type as FileChange['changeType'],
                newContent: content,
                timestamp: Date.now(),
            };

            const spinnerAnalyze = ora('Analyzing impact...').start();
            const report = analyzer.analyze(change);
            spinnerAnalyze.succeed(`Impact analyzed: ${report.impactedNodes.filter(n => n.requiresUpdate).length} file(s) may need updates`);

            if (report.impactedNodes.filter(n => n.requiresUpdate).length === 0) {
                console.log(chalk.green('\n✓ No downstream files require updates.'));
                return;
            }

            const spinnerDecompose = ora('Decomposing tasks with AI...').start();
            let tasks;
            try {
                tasks = await decomposer.decompose(report, config.rootDir);
                spinnerDecompose.succeed(`${tasks.length} task(s) created`);
            } catch (err) {
                spinnerDecompose.fail(`Task decomposition failed: ${String(err)}`);
                return;
            }

            if (tasks.length === 0) {
                console.log(chalk.green('\n✓ AI determined no additional changes are required.'));
                return;
            }

            console.log(RichFormatter.formatAITasks(tasks));

            if (opts.confirm !== false) {
                const { proceed } = await inquirer.prompt([{
                    type: 'confirm', name: 'proceed',
                    message: opts.dryRun
                        ? `Preview ${tasks.length} change(s)?`
                        : `Apply ${tasks.length} change(s)? This will modify files.`,
                    default: true,
                }]);
                if (!proceed) {
                    console.log(chalk.yellow('Cancelled.'));
                    return;
                }
            }

            const results = [];
            for (const task of tasks) {
                const spinner = ora(`${opts.dryRun ? 'Previewing' : 'Applying'}: ${path.relative(process.cwd(), task.targetFile)}`).start();
                try {
                    const result = await executor.execute(task, opts.dryRun as boolean);
                    results.push(result);

                    if (!result.success) {
                        spinner.fail(`Failed: ${result.validationErrors.join(', ')}`);
                    } else if (result.confidence < minConfidence) {
                        spinner.warn(`Low confidence (${(result.confidence * 100).toFixed(0)}%) — skipped`);
                    } else {
                        spinner.succeed(
                            `${opts.dryRun ? 'Preview' : 'Applied'} — confidence ${(result.confidence * 100).toFixed(0)}%`
                        );
                    }

                    if (opts.dryRun && result.diff) {
                        console.log(RichFormatter.formatDiff(result.diff));
                    }
                } catch (err) {
                    spinner.fail(`Error: ${String(err)}`);
                }
            }

            const appliedCount = results.filter(r => r.success && r.appliedAt).length;
            const failedCount = results.filter(r => !r.success).length;

            console.log('');
            console.log(chalk.bold('Execution Summary'));
            console.log(chalk.gray('─'.repeat(40)));
            console.log(`  Tasks: ${tasks.length}`);
            if (!opts.dryRun) {
                console.log(`  Applied: ${chalk.green(String(appliedCount))}`);
            }
            console.log(`  Failed: ${chalk.red(String(failedCount))}`);
            if (opts.dryRun) {
                console.log(chalk.cyan('  Note: Dry run — no physical changes were made.'));
            }
            console.log('');
        });
}