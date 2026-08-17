import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import { loadContext } from '../context.js';
import { CheckpointManager } from '../../core/ai/CheckpointManager.js';
import { AgentLoop } from '../../core/ai/AgentLoop.js';
import { SelfHealingExecutor } from '../../core/ai/SelfHealingExecutor.js';
import { ModelRouter } from '../../core/orchestrator/ModelRouter.js';
import { ResourceMonitor } from '../../core/orchestrator/ResourceMonitor.js';
import { RichFormatter } from '../../core/output/RichFormatter.js';
import { ChangeHistory } from '../../storage/ChangeHistory.js';

export function continueCommand(): Command {
    return new Command('continue')
        .description('Resume the last interrupted AI task from its durable checkpoint')
        .action(async () => {
            const ctx = await loadContext();
            if (!ctx) return;

            const { config, db, graph, store } = ctx;
            const checkpointManager = new CheckpointManager(db);
            const checkpoint = checkpointManager.getLatest();

            if (!checkpoint || checkpoint.status === 'finished') {
                console.log(chalk.yellow('\nNo active checkpoint found to resume.'));
                return;
            }

            console.log(chalk.bold('\nCodebase OS — Resuming Session'));
            console.log(chalk.gray('─'.repeat(40)));
            console.log(`  Task Type: ${chalk.cyan(checkpoint.taskType.toUpperCase())}`);
            console.log(`  Session:   ${chalk.gray(checkpoint.sessionId)}`);
            console.log(`  Status:    ${chalk.gray(checkpoint.status)}`);
            console.log(`  Updated:   ${new Date(checkpoint.updatedAt).toLocaleString()}`);
            console.log('');

            const monitor = new ResourceMonitor(db);
            const modelRouter = new ModelRouter(config, db, monitor);
            const provider = modelRouter.getProviderForTask('reasoning');

            if (checkpoint.taskType === 'agent') {
                const agent = new AgentLoop(provider, config.rootDir, db, checkpoint.sessionId, graph, store);
                const task = checkpoint.metadata.task || checkpoint.plan[0]?.description;
                if (!task || typeof task !== 'string' || task.trim().length === 0) {
                    console.log(chalk.red('Checkpoint is missing the original task description; refusing an unsafe blind resume.'));
                    return;
                }

                const steps = Array.isArray(checkpoint.metadata.steps) ? checkpoint.metadata.steps : [];
                const files = Array.isArray(checkpoint.metadata.filesWritten) ? checkpoint.metadata.filesWritten : [];
                const messages = Array.isArray(checkpoint.metadata.messages) ? checkpoint.metadata.messages : [];

                console.log(chalk.yellow(`Resuming autonomous agent from step ${steps.length + 1}...`));

                const spinner = ora('Agent is working...').start();
                const result = await agent.run(task, {
                    onStep: async (step: number, action: any) => {
                        spinner.text = `Agent working... (step ${step}: ${action.tool})`;
                    },
                    initialSteps: steps,
                    initialFiles: files,
                    initialMessages: messages,
                });

                spinner.stop();
                console.log(chalk.bold('\nAgent Summary'));
                console.log(chalk.gray('─'.repeat(40)));
                console.log(`  ${result.success ? chalk.green('Verified completion') : chalk.yellow('Still incomplete')} — ${result.totalSteps} step(s)`);
                console.log(`  Verified: ${result.verified ? chalk.green('yes') : chalk.yellow('no')}`);
                console.log(`  ${result.summary}`);
                if (result.verificationCommands.length > 0) {
                    console.log(chalk.gray(`  Evidence: ${result.verificationCommands.join(' | ')}`));
                }
                // AgentLoop owns checkpoint status. Do not mark a partial resume
                // finished merely because this command returned.
            } else {
                const history = new ChangeHistory(db);
                const executor = new SelfHealingExecutor(provider, config, history, checkpoint.sessionId, db);

                console.log(chalk.yellow(
                    `Resuming plan execution: ${checkpoint.results.length} / ${checkpoint.plan.length} tasks completed.`,
                ));

                const spinners = new Map<string, any>();
                const healResult = await executor.executeAndHeal(
                    checkpoint.plan,
                    false,
                    (label, status, detail) => {
                        const rel = path.relative(config.rootDir, label);
                        if (status === 'start') {
                            spinners.set(label, ora(`Resuming: ${rel}`).start());
                        } else if (status === 'done') {
                            spinners.get(label)?.succeed(`Applied — ${detail ?? 'done'}`);
                        } else {
                            spinners.get(label)?.fail(`Failed: ${detail ?? 'error'}`);
                        }
                    },
                    checkpoint.results,
                );

                console.log(RichFormatter.formatExecutionTable(healResult.finalResults));
                const complete = healResult.finalResults.length >= checkpoint.plan.length &&
                    healResult.finalResults.every(result => result.success);
                if (complete) {
                    checkpointManager.markFinished(checkpoint.id);
                } else {
                    console.log(chalk.yellow('Plan remains checkpointed because one or more tasks are not verified successful.'));
                }
            }

            console.log('');
        });
}
