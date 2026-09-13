import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { v4 as uuidv4 } from 'uuid';
import { loadContext } from '../context.js';
import { AgentLoop } from '../../core/ai/AgentLoop.js';
import { TopologicalPlanner } from '../../core/ai/TopologicalPlanner.js';

function renderPlan(task: string, planner: TopologicalPlanner, file?: string): void {
    const report = file
        ? planner.planFromFiles([file])
        : planner.planFromTask(task);

    console.log(chalk.bold('\nProposed impact scope'));
    console.log(chalk.gray('─'.repeat(60)));
    if (report.totalFiles === 0) {
        console.log(chalk.yellow('  No matching affected files were found in the current graph.'));
        console.log(chalk.gray('  Refresh with `cos scan` if the repository changed substantially.'));
        return;
    }

    for (const item of report.affectedFiles.slice(0, 40)) {
        const root = item.isRoot ? ' root' : '';
        console.log(
            `  ${chalk.gray(`[${item.executionOrder}]`)} ${chalk.cyan(item.relativePath)} ` +
            chalk.gray(`[${item.layer}] ${item.reason}${root}`),
        );
    }
    if (report.cycles.length > 0) {
        console.log(chalk.red('\n  Dependency cycles require explicit review:'));
        for (const cycle of report.cycles) console.log(chalk.red(`    ${cycle}`));
    }
}

export function askCommand(): Command {
    return new Command('ask')
        .description('Describe an engineering change, preview its graph scope, and execute it through the verified AgentLoop')
        .argument('[request]', 'What you want to change or build')
        .option('--file <file>', 'Scope planning and implementation to a specific repository-relative file')
        .option('--dry-run', 'Show the graph-derived impact plan without modifying files')
        .option('--yes', 'Skip the execution confirmation prompt')
        .option('--max-steps <n>', 'Maximum autonomous steps', '40')
        .action(async (request: string | undefined, opts: any) => {
            let actualRequest = request?.trim() ?? '';
            if (!actualRequest) {
                const { input } = await inquirer.prompt([{
                    type: 'input',
                    name: 'input',
                    message: 'What would you like to build or change?',
                    validate: (value: string) => value.trim().length > 0 || 'Please provide a description.',
                }]);
                actualRequest = String(input).trim();
            }

            const ctx = await loadContext();
            if (!ctx) return;
            const { config, db, graph, store, aiProvider } = ctx;

            const scopedTask = opts.file
                ? `${actualRequest}\n\nUSER-SPECIFIED FILE SCOPE: ${String(opts.file)}. Do not modify unrelated files unless compatibility requires it and verification evidence justifies the expansion.`
                : actualRequest;

            console.log(chalk.bold('\nCodebase OS — Verified Engineering Request'));
            console.log(chalk.gray('─'.repeat(60)));
            console.log(`  Request: ${chalk.cyan(actualRequest)}`);
            if (opts.file) console.log(`  Scope:   ${chalk.cyan(String(opts.file))}`);

            if (graph.nodes.size > 0) {
                const planner = new TopologicalPlanner(graph, config.rootDir);
                const scopedFile = opts.file ? String(opts.file) : undefined;
                renderPlan(actualRequest, planner, scopedFile);
            } else {
                console.log(chalk.yellow('\n  Relationship graph is empty; run `cos scan` for impact-aware planning.'));
            }

            if (opts.dryRun) {
                console.log(chalk.cyan('\nDry run complete. No files were modified.\n'));
                return;
            }

            if (!opts.yes) {
                const { proceed } = await inquirer.prompt([{
                    type: 'confirm',
                    name: 'proceed',
                    message: 'Execute this request through the transactional, independently verified agent runtime?',
                    default: false,
                }]);
                if (!proceed) {
                    console.log(chalk.yellow('Execution cancelled.'));
                    return;
                }
            }

            const maxSteps = Math.min(100, Math.max(1, Number.parseInt(String(opts.maxSteps), 10) || 40));
            const agent = new AgentLoop(aiProvider, config.rootDir, db, uuidv4(), graph, store);
            const result = await agent.run(scopedTask, {
                maxSteps,
                onStep: async (step, action, toolResult, _tasklist, diff) => {
                    if (toolResult.isStreaming) {
                        process.stdout.write(chalk.gray(String(toolResult.output || '')));
                        return;
                    }
                    const target = action.args?.path || action.args?.oldPath || action.args?.command || action.args?.dir || '';
                    const status = toolResult.success ? chalk.green('OK') : chalk.red('FAIL');
                    console.log(`  ${chalk.gray(`[${step}]`)} ${chalk.cyan(String(action.tool).toUpperCase())} ${chalk.gray(target)} ${status}`);
                    if (!toolResult.success && toolResult.error) {
                        console.log(chalk.red(`       ${String(toolResult.error).slice(0, 220)}`));
                    }
                    if (diff) {
                        for (const line of diff.split('\n').slice(0, 18)) {
                            if (line.startsWith('+') && !line.startsWith('+++')) console.log(chalk.green(`       ${line}`));
                            else if (line.startsWith('-') && !line.startsWith('---')) console.log(chalk.red(`       ${line}`));
                            else if (line.startsWith('@@')) console.log(chalk.cyan(`       ${line}`));
                        }
                    }
                },
            });

            console.log('');
            console.log(result.success
                ? chalk.green.bold('VERIFIED COMPLETION')
                : chalk.yellow.bold('INCOMPLETE / NOT VERIFIED'));
            console.log(`  ${result.summary}`);
            if (result.verificationCommands.length > 0) {
                console.log(chalk.gray(`  Verification: ${result.verificationCommands.join(' | ')}`));
            }
            if (result.filesWritten.length > 0) {
                console.log(chalk.gray(`  Affected paths: ${result.filesWritten.join(', ')}`));
            }
            if (!result.success) process.exitCode = 1;
            console.log('');
        });
}
