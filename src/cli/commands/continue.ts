import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import { loadContext } from '../context.js';
import { CheckpointManager } from '../../core/ai/CheckpointManager.js';
import { AgentLoop, type AgentStep } from '../../core/ai/AgentLoop.js';

function printResult(result: Awaited<ReturnType<AgentLoop['run']>>): void {
    console.log(chalk.bold('\nResume Summary'));
    console.log(chalk.gray('─'.repeat(48)));
    console.log(`  Status:   ${result.success ? chalk.green('verified completion') : chalk.yellow('incomplete')}`);
    console.log(`  Verified: ${result.verified ? chalk.green('yes') : chalk.yellow('no')}`);
    console.log(`  Steps:    ${result.totalSteps}`);
    console.log(`  ${result.summary}`);
    if (result.verificationCommands.length > 0) {
        console.log(chalk.gray(`  Evidence: ${result.verificationCommands.join(' | ')}`));
    }
}

export function continueCommand(): Command {
    return new Command('continue')
        .description('Resume the latest incomplete checkpoint through the hardened AgentLoop runtime')
        .action(async () => {
            const ctx = await loadContext();
            if (!ctx) return;

            const { config, db, graph, store, aiProvider } = ctx;
            const checkpointManager = new CheckpointManager(db);
            const checkpoint = checkpointManager.getLatest();

            if (!checkpoint || checkpoint.status === 'finished') {
                console.log(chalk.yellow('\nNo active checkpoint found to resume.'));
                return;
            }

            console.log(chalk.bold('\nCodebase OS — Resuming Session'));
            console.log(chalk.gray('─'.repeat(48)));
            console.log(`  Legacy type: ${chalk.cyan(checkpoint.taskType.toUpperCase())}`);
            console.log(`  Session:     ${chalk.gray(checkpoint.sessionId)}`);
            console.log(`  Status:      ${chalk.gray(checkpoint.status)}`);
            console.log(`  Updated:     ${new Date(checkpoint.updatedAt).toLocaleString()}`);
            console.log('');

            const agent = new AgentLoop(
                aiProvider,
                config.rootDir,
                db,
                checkpoint.sessionId,
                graph,
                store,
            );

            if (checkpoint.taskType === 'agent') {
                const task = checkpoint.metadata.task || checkpoint.plan[0]?.description;
                if (!task || typeof task !== 'string' || task.trim().length === 0) {
                    console.log(chalk.red(
                        'Checkpoint is missing the original task description. Refusing an unsafe blind resume.',
                    ));
                    process.exitCode = 1;
                    return;
                }

                const steps = Array.isArray(checkpoint.metadata.steps) ? checkpoint.metadata.steps : [];
                const files = Array.isArray(checkpoint.metadata.filesWritten)
                    ? checkpoint.metadata.filesWritten
                    : [];
                const messages = Array.isArray(checkpoint.metadata.messages)
                    ? checkpoint.metadata.messages
                    : [];

                console.log(chalk.yellow(`Resuming verified agent runtime from step ${steps.length + 1}...`));
                const spinner = ora('Agent is working...').start();
                const result = await agent.run(String(task), {
                    initialSteps: steps,
                    initialFiles: files,
                    initialMessages: messages,
                    onStep: async (step: number, action: any, toolResult: any) => {
                        if (toolResult.isStreaming) return;
                        spinner.text = `Agent working... (step ${step}: ${action.tool})`;
                    },
                });
                spinner.stop();
                printResult(result);
                if (!result.success) process.exitCode = 1;
                console.log('');
                return;
            }

            // Pre-hardening `ask` checkpoints were created by a different mutation
            // engine. Never resume that engine. Convert its plan/evidence into a
            // new AgentLoop task and force independent verification if any old
            // checkpoint result indicates an already-applied mutation.
            const planText = checkpoint.plan
                .map((item, index) => {
                    const target = item.targetFile
                        ? path.relative(config.rootDir, item.targetFile).replace(/\\/g, '/')
                        : '(unspecified)';
                    return `${index + 1}. ${item.description} [target: ${target}]`;
                })
                .join('\n');
            const appliedResults = checkpoint.results.filter(result => Boolean(result.appliedAt));
            const affectedFiles = [...new Set(appliedResults.map(result =>
                path.isAbsolute(result.filePath)
                    ? path.relative(config.rootDir, result.filePath).replace(/\\/g, '/')
                    : result.filePath.replace(/\\/g, '/'),
            ))];

            const legacyEvidence = checkpoint.results.slice(0, 30).map(result => {
                const file = path.isAbsolute(result.filePath)
                    ? path.relative(config.rootDir, result.filePath).replace(/\\/g, '/')
                    : result.filePath;
                return `- ${file}: previous engine reported ${result.success ? 'success' : 'failure'}; ` +
                    `validation errors=${result.validationErrors.length}; applied=${Boolean(result.appliedAt)}`;
            }).join('\n');

            const task =
                `Resume a legacy Codebase OS checkpoint without trusting the old engine's completion state. ` +
                `Inspect the CURRENT repository before making any new change. Complete the original intent, repair any partial legacy work, ` +
                `and request finish only when the current state is ready for independent verification.\n\n` +
                `LEGACY PLAN:\n${planText || '(no plan text recorded)'}\n\n` +
                `LEGACY RESULT EVIDENCE:\n${legacyEvidence || '(no results recorded)'}`;

            const syntheticSteps: AgentStep[] = affectedFiles.map((file, index) => ({
                step: index + 1,
                action: {
                    tool: 'patch_file',
                    args: { path: file, diff: '[legacy mutation already present before migration]' },
                    reasoning: 'Checkpoint migration marker: legacy runtime previously mutated this path.',
                },
                result: {
                    success: true,
                    output: 'Legacy mutation marker. Current filesystem must be independently verified before completion.',
                },
            }));

            console.log(chalk.yellow(
                `Migrating legacy checkpoint into the verified runtime (${affectedFiles.length} previously affected path(s)).`,
            ));
            const spinner = ora('Agent is reconciling the legacy checkpoint...').start();
            const result = await agent.run(task, {
                initialSteps: syntheticSteps,
                initialFiles: affectedFiles,
                onStep: async (step: number, action: any, toolResult: any) => {
                    if (toolResult.isStreaming) return;
                    spinner.text = `Reconciling... (step ${step}: ${action.tool})`;
                },
            });
            spinner.stop();
            printResult(result);
            if (!result.success) process.exitCode = 1;
            console.log('');
        });
}
