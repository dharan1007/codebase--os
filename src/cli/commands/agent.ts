import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { loadContext } from '../context.js';
import { AgentLoop } from '../../core/ai/AgentLoop.js';
import path from 'path';

const TOOL_COLOR: Record<string, (value: string) => string> = {
    write_file: chalk.green,
    patch_file: chalk.cyan,
    read_file: chalk.gray,
    list_files: chalk.gray,
    search_code: chalk.blue,
    find_references: chalk.blue,
    run_shell: chalk.yellow,
    delete_file: chalk.red,
    move_file: chalk.magenta,
    finish: chalk.green,
};

function formatTool(tool: string): string {
    return (TOOL_COLOR[tool] ?? chalk.white)(tool.toUpperCase());
}

function renderDiff(diffText: string): void {
    const lines = diffText.split('\n');
    const limit = 30;
    for (const line of lines.slice(0, limit)) {
        if (line.startsWith('+++') || line.startsWith('---')) continue;
        if (line.startsWith('@@')) console.log(chalk.cyan(`  ${line}`));
        else if (line.startsWith('+')) console.log(chalk.green(`  ${line}`));
        else if (line.startsWith('-')) console.log(chalk.red(`  ${line}`));
        else console.log(chalk.gray(`  ${line}`));
    }
    if (lines.length > limit) console.log(chalk.gray(`  ... (${lines.length - limit} more diff lines)`));
}

function renderTasklist(tasklist: string[]): void {
    if (!tasklist?.length) return;
    const done = tasklist.filter(item => item.includes('(done)')).length;
    const active = tasklist.find(item => item.includes('(in progress)'));
    console.log(
        chalk.gray(`  Tasks: [${done}/${tasklist.length}]`) +
        (active ? chalk.white(` — ${active.replace('(in progress)', '').trim()}`) : ''),
    );
}

export function agentCommand(): Command {
    return new Command('agent')
        .description('Transactional autonomous coding agent with independent completion verification')
        .argument('[task]', 'Engineering task to accomplish')
        .option('--max-steps <n>', 'Maximum agent loop iterations', '40')
        .option('--show-diff', 'Show inline diffs for patch operations', true)
        .action(async (task: string | undefined, opts: any) => {
            let actualTask = task?.trim() ?? '';
            if (!actualTask) {
                const { input } = await inquirer.prompt([{
                    type: 'input',
                    name: 'input',
                    message: 'What should the agent build or fix?',
                    validate: (value: string) => value.trim().length > 0 || 'Please describe the task.',
                }]);
                actualTask = String(input).trim();
            }

            const ctx = await loadContext();
            if (!ctx) return;
            const { config, db, sessionId, aiProvider, graph, store } = ctx;
            const maxSteps = Math.min(120, Math.max(1, Number.parseInt(String(opts.maxSteps), 10) || 40));

            console.log('');
            console.log(chalk.bold('Codebase OS — Verified Autonomous Agent'));
            console.log(chalk.gray('─'.repeat(56)));
            console.log(`  Task:     ${chalk.cyan(actualTask)}`);
            console.log(`  Root:     ${chalk.gray(config.rootDir)}`);
            console.log(`  Max:      ${chalk.gray(`${maxSteps} steps`)}`);
            console.log(`  Complete: ${chalk.gray('only after independent post-mutation verification')}`);
            console.log(chalk.gray('─'.repeat(56)));
            console.log('');

            const agent = new AgentLoop(aiProvider, config.rootDir, db, sessionId, graph, store);
            const result = await agent.run(actualTask, {
                maxSteps,
                onStep: async (step: number, action: any, toolResult: any, tasklist: string[], diff?: string) => {
                    if (toolResult.isStreaming) {
                        process.stdout.write(chalk.gray(String(toolResult.output || '')));
                        return;
                    }

                    const status = toolResult.success ? chalk.green('OK') : chalk.red('FAIL');
                    const target = action.args?.path || action.args?.oldPath || action.args?.command || action.args?.dir || '';
                    console.log(`${chalk.gray(`[${step}]`)} ${formatTool(action.tool)}${target ? chalk.gray(` ${target}`) : ''} ${status}`);

                    if (action.reasoning) {
                        const reasoning = String(action.reasoning);
                        console.log(chalk.gray(`     ${reasoning.length > 120 ? `${reasoning.slice(0, 120)}...` : reasoning}`));
                    }
                    if (!toolResult.success && toolResult.error) {
                        console.log(chalk.red(`     Error: ${String(toolResult.error).slice(0, 220)}`));
                    }
                    if (toolResult.success && opts.showDiff !== false && action.tool === 'patch_file' && diff) {
                        renderDiff(diff);
                    }
                    renderTasklist(tasklist);
                    console.log('');
                },
            });

            console.log('');
            console.log(chalk.bold('─'.repeat(56)));
            const outcome = result.success
                ? chalk.green.bold('VERIFIED COMPLETION')
                : result.verified
                    ? chalk.yellow.bold('VERIFIED STATE, TASK INCOMPLETE')
                    : chalk.yellow.bold('INCOMPLETE / NOT VERIFIED');
            console.log(outcome);
            console.log(chalk.gray('─'.repeat(56)));
            console.log(`  Steps:    ${result.totalSteps}`);
            console.log(`  Summary:  ${result.summary}`);
            console.log(`  Verified: ${result.verified ? chalk.green('yes') : chalk.yellow('no')}`);

            if (result.filesWritten.length > 0) {
                console.log('');
                console.log(chalk.bold('  Affected paths:'));
                for (const file of [...new Set(result.filesWritten)]) {
                    const display = path.isAbsolute(file)
                        ? path.relative(config.rootDir, file)
                        : file;
                    console.log(`    ${chalk.gray('-')} ${display}`);
                }
            }

            if (result.verificationCommands.length > 0) {
                console.log('');
                console.log(chalk.bold('  Verification evidence:'));
                for (const command of result.verificationCommands) {
                    console.log(`    ${chalk.gray('-')} ${command}`);
                }
            }

            if (result.tasklist.length > 0) {
                console.log('');
                console.log(chalk.bold('  Final task plan:'));
                for (const item of result.tasklist) {
                    const done = item.includes('(done)');
                    const active = item.includes('(in progress)');
                    const marker = done ? '[x]' : active ? '[>]' : '[ ]';
                    console.log(`    ${done ? chalk.green(marker) : active ? chalk.yellow(marker) : chalk.gray(marker)} ${item}`);
                }
            }

            if (result.quotaReached || result.outageDetected) {
                console.log('');
                console.log(chalk.yellow(
                    result.quotaReached
                        ? 'Provider quota/rate limit interrupted execution. The checkpoint remains resumable with `cos continue`.'
                        : 'Provider execution failed. The checkpoint remains resumable with `cos continue`.',
                ));
            }

            if (!result.success) process.exitCode = 1;
            console.log('');
        });
}
