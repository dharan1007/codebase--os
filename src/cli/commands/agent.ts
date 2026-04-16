import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { loadContext } from '../context.js';
import { AIProviderFactory } from '../../core/ai/AIProviderFactory.js';
import { ModelRouter } from '../../core/ai/ModelRouter.js';
import { AgentLoop } from '../../core/ai/AgentLoop.js';

export function agentCommand(): Command {
    return new Command('agent')
        .description('Autonomous AI agent — reads, plans, writes, and verifies code on its own')
        .argument('[task]', 'The coding task to accomplish autonomously')
        .option('--max-steps <n>', 'Maximum agent loop iterations', '20')
        .option('--show-steps', 'Print each step as the agent works')
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
            console.log(chalk.gray('─'.repeat(40)));
            console.log(`  Task: ${chalk.cyan(actualTask)}`);
            console.log(chalk.gray('  The agent will use Hybrid Retrieval and Semantic RAG to reason autonomously.'));
            console.log('');

            const spinner = opts.showSteps ? null : ora('Agent is working...').start();
            let stepCount = 0;

            const agent = new AgentLoop(aiProvider, config.rootDir, db, sessionId);

            const result = await agent.run(actualTask, (step, action, toolResult) => {
                stepCount = step;
                if (opts.showSteps) {
                    const toolColor = action.tool === 'write_file' ? chalk.green : chalk.cyan;
                    console.log(chalk.gray(`  Step ${step}:`), toolColor(`[${action.tool}]`), chalk.gray(action.args['path'] ?? action.args['command'] ?? action.args['dir'] ?? ''));
                    console.log(chalk.gray(`    Reason: ${action.reasoning}`));
                    if (!toolResult.success && toolResult.error) {
                        console.log(chalk.yellow(`    Error: ${toolResult.error}`));
                    }
                } else {
                    spinner?.start(`Agent working... (step ${step}: ${action.tool})`);
                }
            });

            spinner?.stop();

            console.log('');
            console.log(chalk.bold('Agent Summary'));
            console.log(chalk.gray('─'.repeat(40)));
            console.log(`  ${result.success ? chalk.green('Completed') : chalk.yellow('Partial')} — ${stepCount} step(s) taken`);
            console.log(`  ${result.summary}`);

            if (result.filesWritten.length > 0) {
                console.log('');
                console.log(chalk.bold('  Files Written:'));
                for (const f of result.filesWritten) {
                    console.log(`    ${chalk.green('+')} ${f}`);
                }
            }
            console.log('');
        });
}
