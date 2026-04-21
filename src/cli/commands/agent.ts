import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { loadContext } from '../context.js';
import { AgentLoop } from '../../core/ai/AgentLoop.js';
import { computeDiff } from '../../utils/diff.js';
import path from 'path';
import fs from 'fs';

const TOOL_COLOR: Record<string, (s: string) => string> = {
    write_file:      chalk.green,
    patch_file:      chalk.cyan,
    read_file:       chalk.gray,
    list_files:      chalk.gray,
    search_code:     chalk.blue,
    find_references: chalk.blue,
    run_shell:       chalk.yellow,
    delete_file:     chalk.red,
    move_file:       chalk.magenta,
    finish:          chalk.green,
};

function formatTool(tool: string): string {
    const fn = TOOL_COLOR[tool] ?? chalk.white;
    return fn(tool.toUpperCase().replace(/_/g, '_'));
}

function renderInlineDiff(filePath: string, rootDir: string, newContent?: string, unifiedDiff?: string): void {
    try {
        const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);

        let diffText: string;
        if (unifiedDiff) {
            diffText = unifiedDiff;
        } else if (newContent) {
            let original = '';
            try { original = fs.readFileSync(absPath, 'utf8'); } catch { /* new file */ }
            diffText = computeDiff(original, newContent, filePath).raw;
        } else {
            return;
        }

        const lines = diffText.split('\n');
        let shown = 0;
        const MAX_LINES = 30;

        for (const line of lines) {
            if (shown >= MAX_LINES) {
                console.log(chalk.gray(`  ... (${lines.length - shown} more diff lines)`));
                break;
            }
            if (line.startsWith('+++') || line.startsWith('---')) continue;
            if (line.startsWith('@@')) {
                console.log(chalk.cyan(`  ${line}`));
            } else if (line.startsWith('+')) {
                console.log(chalk.green(`  ${line}`));
            } else if (line.startsWith('-')) {
                console.log(chalk.red(`  ${line}`));
            } else {
                console.log(chalk.gray(`  ${line}`));
            }
            shown++;
        }
    } catch {
        // diff rendering is best-effort
    }
}

function renderTasklist(tasklist: string[]): void {
    if (!tasklist || tasklist.length === 0) return;
    const done = tasklist.filter(t => t.includes('(done)')).length;
    const total = tasklist.length;
    const active = tasklist.find(t => t.includes('(in progress)'));
    console.log(
        chalk.gray(`  Tasks: [${done}/${total}]`) +
        (active ? chalk.white(` — ${active.replace('(in progress)', '').trim()}`) : '')
    );
}

export function agentCommand(): Command {
    return new Command('agent')
        .description('Autonomous AI agent — reads, plans, writes, and verifies code autonomously')
        .argument('[task]', 'The coding task to accomplish')
        .option('--max-steps <n>', 'Maximum agent loop iterations', '40')
        .option('--show-diff', 'Show inline colored diffs on every file write (default: on)', true)
        .action(async (task: string | undefined, opts: any) => {
            let actualTask: string;
            if (!task) {
                const { input } = await inquirer.prompt([{
                    type: 'input',
                    name: 'input',
                    message: 'What should the agent build or fix?',
                    validate: (v) => v.trim().length > 0 || 'Please describe the task.',
                }]);
                actualTask = input;
            } else {
                actualTask = task;
            }

            const ctx = await loadContext();
            if (!ctx) return;

            const { config, db, sessionId, aiProvider, graph, store } = ctx;

            console.log('');
            console.log(chalk.bold('Codebase OS — Autonomous Agent'));
            console.log(chalk.gray('─'.repeat(50)));
            console.log(`  Task:    ${chalk.cyan(actualTask)}`);
            console.log(`  Root:    ${chalk.gray(config.rootDir)}`);
            console.log(`  Max:     ${chalk.gray(opts.maxSteps + ' steps')}`);
            console.log(chalk.gray('─'.repeat(50)));
            console.log('');

            const agent = new AgentLoop(aiProvider, config.rootDir, db, sessionId, graph, store);

            const result = await agent.run(actualTask, {
                maxSteps: parseInt(opts.maxSteps, 10) || 40,

                onStep: async (step: number, action: any, toolResult: any, tasklist: string[], diff?: string) => {
                    // Never clear the terminal — always append

                    if ((action as any).tool === 'thinking') {
                        process.stdout.write(chalk.gray(action.args?.token ?? ''));
                        return;
                    }

                    const status = toolResult.success ? chalk.green('OK') : chalk.red('FAIL');
                    const toolStr = formatTool(action.tool);
                    const target = action.args?.path || action.args?.command || action.args?.dir || '';
                    const targetStr = target ? chalk.gray(` ${target}`) : '';

                    console.log(`${chalk.gray(`[${step}]`)} ${toolStr}${targetStr} ${status}`);

                    // Show reasoning on a single line
                    if (action.reasoning) {
                        const short = action.reasoning.substring(0, 100) + (action.reasoning.length > 100 ? '...' : '');
                        console.log(chalk.gray(`     ${short}`));
                    }

                    // Handle interactive pause_and_ask
                    if (action.tool === 'pause_and_ask') {
                        console.log(chalk.yellow('\n  INTERVENTION REQUIRED'));
                        const { feedback } = await inquirer.prompt([{
                            type: 'input',
                            name: 'feedback',
                            message: `  ${action.args?.['feedback'] ?? 'Agent needs input:'}`,
                        }]);
                        toolResult.output = feedback;
                    }

                    // Show streaming shell output
                    if (toolResult.isStreaming) {
                        process.stdout.write(chalk.gray(toolResult.output));
                        return;
                    }

                    // Show error detail
                    if (!toolResult.success && toolResult.error) {
                        console.log(chalk.red(`     Error: ${toolResult.error.substring(0, 120)}`));
                    }

                    // Show inline diff for write and patch operations
                    if (toolResult.success && opts.showDiff !== false) {
                        if (action.tool === 'patch_file' && diff) {
                            renderInlineDiff(action.args?.path ?? '', config.rootDir, undefined, diff);
                        } else if (action.tool === 'write_file' && action.args?.content) {
                            renderInlineDiff(action.args?.path ?? '', config.rootDir, action.args.content);
                        }
                    }

                    // Compact tasklist indicator (no screen clearing)
                    renderTasklist(tasklist);
                    console.log('');
                },
            });

            // Final summary
            console.log('');
            console.log(chalk.bold('─'.repeat(50)));
            console.log(chalk.bold('Agent Complete'));
            console.log(chalk.gray('─'.repeat(50)));
            console.log(`  Status:  ${result.success ? chalk.green('Completed') : chalk.yellow('Paused')}`);
            console.log(`  Steps:   ${chalk.white(String(result.totalSteps))}`);
            console.log(`  Summary: ${chalk.white(result.summary)}`);

            if (result.filesWritten.length > 0) {
                console.log('');
                console.log(chalk.bold('  Files Modified:'));
                for (const f of [...new Set(result.filesWritten)]) {
                    console.log(`    ${chalk.green('+')} ${f}`);
                }
            }

            if (result.tasklist.length > 0) {
                console.log('');
                console.log(chalk.bold('  Final Task Plan:'));
                for (const t of result.tasklist) {
                    const isDone = t.includes('(done)');
                    const isActive = t.includes('(in progress)');
                    const prefix = isDone ? chalk.green('[x]') : isActive ? chalk.yellow('[>]') : chalk.gray('[ ]');
                    const text = isDone ? chalk.gray(t) : isActive ? chalk.white(t) : chalk.gray(t);
                    console.log(`    ${prefix} ${text}`);
                }
            }

            if (result.outageDetected || result.quotaReached) {
                console.log('');
                const title = result.quotaReached ? 'QUOTA REACHED' : 'PROVIDER OUTAGE';
                console.log(chalk.bold.bgYellow.black(` ${title} `));
                console.log(chalk.yellow('  Progress saved. Run cos continue to resume.'));
            }

            console.log('');
        });
}
