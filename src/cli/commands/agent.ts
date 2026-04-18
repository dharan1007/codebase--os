import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { loadContext } from '../context.js';
import { AgentLoop } from '../../core/ai/AgentLoop.js';

export function agentCommand(): Command {
    return new Command('agent')
        .description('Autonomous AI agent — reads, plans, writes, and verifies code on its own')
        .argument('[task]', 'The coding task to accomplish autonomously')
        .option('--max-steps <n>', 'Maximum agent loop iterations', '28')
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

            const agent = new AgentLoop(aiProvider, config.rootDir, db, sessionId, graph, store);

            const result = await agent.run(actualTask, async (step, action, toolResult, tasklist) => {
                stepCount = step;
                
                if (step === 1 && (action as any).tool !== 'thinking') {
                    console.log(chalk.bold('\n🚀 Principal Execution Started'));
                    console.log(chalk.gray('─'.repeat(40)));
                }

                if ((action as any).tool === 'thinking') {
                    const token = (action.args as any).token;
                    process.stdout.write(chalk.gray(token));
                    return;
                }

                if (tasklist && tasklist.length > 0) {
                    process.stdout.write('\x1Bc'); 
                    console.log(chalk.bold('Codebase OS — Principal Dashboard'));
                    console.log(chalk.gray('─'.repeat(40)));
                    console.log(chalk.bold('📋 Tasklist:'));
                    tasklist.forEach(t => {
                        if (t.includes('(done)') || t.includes('✔')) console.log(`  ${chalk.green('✔')} ${chalk.gray(t)}`);
                        else if (t.includes('(in progress)') || t.includes('➤')) console.log(`  ${chalk.yellow('➤')} ${chalk.bold(t)}`);
                        else console.log(`  ${chalk.gray('○')} ${t}`);
                    });
                    console.log(chalk.gray('─'.repeat(40)));
                }

                const toolColor = action.tool === 'write_file' ? chalk.green : chalk.cyan;
                console.log(chalk.gray(`\n[Step ${step}]`), toolColor(action.tool.toUpperCase()));
                console.log(chalk.white(`  Reason: ${action.reasoning}`));

                if ((toolResult as any).isStreaming) {
                    process.stdout.write(chalk.gray(toolResult.output));
                    return;
                }

                if (action.tool === 'pause_and_ask') {
                    console.log(chalk.yellow('\n⚠️  INTERVENTION REQUIRED'));
                    const { feedback } = await inquirer.prompt([{
                        type: 'input',
                        name: 'feedback',
                        message: action.args['feedback'] ?? 'Approval required:',
                    }]);
                    toolResult.output = feedback;
                }

                if (!toolResult.success && toolResult.error) {
                    console.log(chalk.red(`  Result: FAILED — ${toolResult.error}`));
                } else if (action.tool !== 'finish') {
                    const argSummary = action.args['path'] ?? action.args['command'] ?? action.args['dir'] ?? '';
                    if (argSummary) console.log(chalk.gray(`  Target: ${argSummary}`));
                    console.log(chalk.green(`  Result: SUCCESS`));
                }
            });

            spinner?.stop();

            if (result.outageDetected || result.quotaReached) {
                const title = result.quotaReached ? ' ❄️  DAILY QUOTA REACHED ' : ' ⚡  OUTAGE DEHYDRATION ACTIVE ';
                console.log('\n' + chalk.bold.bgRed(title));
                console.log(chalk.gray('─'.repeat(40)));
                if (result.quotaReached) {
                    console.log(chalk.yellow('  You have hit the OpenRouter daily limit (50 free model requests).'));
                    console.log(chalk.white('  I have safely dehydrated (saved) your progress to the database.'));
                } else {
                    console.log(chalk.yellow('  OpenRouter is currently experiencing a total outage.'));
                    console.log(chalk.white('  Progress has been saved to the database.'));
                }
                console.log('');
                console.log(chalk.bold('  NEXT STEPS:'));
                if (result.quotaReached) {
                    console.log(`    1. Wait until your OpenRouter quota resets (00:00 UTC).`);
                    console.log(`    2. OR: Add $5 balance to OpenRouter to unlock 1000 requests/day.`);
                    console.log(`    3. Run ${chalk.cyan('cos continue')} to resume instantly.`);
                } else {
                    console.log(`    1. Wait ~5 minutes for traffic to stabilize.`);
                    console.log(`    2. Run ${chalk.cyan('cos continue')} to resume.`);
                }
                console.log(chalk.gray('─'.repeat(40)));
                return;
            }

            console.log('');
            console.log(chalk.bold('Agent Summary'));
            console.log(chalk.gray('─'.repeat(40)));
            console.log(`  ${result.success ? chalk.green('Completed') : chalk.gray('Paused')} — ${stepCount} step(s) taken`);
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
