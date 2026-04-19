import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import path from 'path';
import { loadContext } from '../context.js';
import { ModelRouter } from '../../core/orchestrator/ModelRouter.js';
import { ConversationalPlanner } from '../../core/ai/ConversationalPlanner.js';
import { SelfHealingExecutor } from '../../core/ai/SelfHealingExecutor.js';
import { RichFormatter } from '../../core/output/RichFormatter.js';
import { CheckpointManager } from '../../core/ai/CheckpointManager.js';
import { ResourceMonitor } from '../../core/orchestrator/ResourceMonitor.js';

export function askCommand(): Command {
    return new Command('ask')
        .description('Describe a change in plain English and let AI plan and apply it')
        .argument('[request]', 'What you want to change or build')
        .option('--file <file>', 'Scope the change to a specific file')
        .option('--dry-run', 'Preview the plan without applying changes')
        .option('--auto-commit', 'Automatically commit applied changes')
        .option('--yes', 'Skip all confirmation prompts')
        .action(async (request: string | undefined, opts: any) => {
            let actualRequest: string;
            if (!request) {
                const { input } = await inquirer.prompt([{
                    type: 'input',
                    name: 'input',
                    message: 'What would you like to build?',
                    validate: (val) => val.trim().length > 0 || 'Please provide a description.',
                }]);
                actualRequest = input;
            } else {
                actualRequest = request;
            }

            const ctx = await loadContext();
            if (!ctx) return;
            const { config, history, sessionId, graph, store, rootDir, db } = ctx;
            const monitor = new ResourceMonitor(db);
            const router = new ModelRouter(config, db, monitor);

            console.log(chalk.bold('\nCodebase OS — AI Assistant'));
            console.log(chalk.gray('─'.repeat(40)));
            console.log(`  Request: ${chalk.cyan(actualRequest)}`);
            console.log('');

            const spinnerPlan = ora('Thinking...').start();
            const planningProvider = router.getProviderForTask('planning');
            const planner = new ConversationalPlanner(planningProvider, graph, store);

            let plan;
            try {
                plan = await planner.plan(
                    opts.file ? `${actualRequest} (focus: ${opts.file})` : actualRequest,
                    rootDir,
                    opts.file
                );
                spinnerPlan.stop();
            } catch (err) {
                spinnerPlan.fail(`Error: ${String(err)}`);
                return;
            }

            // [STATELESS INQUIRY]: Direct response path
            if (plan.answer && (!plan.tasks || plan.tasks.length === 0)) {
                console.log(chalk.bold.blue('Sovereign Insights:'));
                console.log(chalk.gray('─'.repeat(40)));
                console.log(plan.answer);
                console.log(chalk.gray('─'.repeat(40)));
                console.log('');

                // [ROOT CAUSE 7]: Explicitly clear any stale checkpoints for this session
                const checkpointManager = new CheckpointManager(db);
                const latest = checkpointManager.getLatest();
                if (latest && latest.sessionId === sessionId) {
                    checkpointManager.clear(latest.id);
                }
                return;
            }

            if (!plan.tasks || plan.tasks.length === 0) {
                console.log(chalk.yellow('\nAI could not determine any necessary actions.'));
                if (plan.answer) console.log('\n' + plan.answer);
                return;
            }

            // Standard Change Flow
            console.log(chalk.bold(`Proposed Plan: ${plan.summary}`));
            console.log(RichFormatter.formatAITasks(plan.tasks));

            if (!opts.yes) {
                const { proceed } = await inquirer.prompt([{
                    type: 'confirm',
                    name: 'proceed',
                    message: opts.dryRun ? 'Proceed to preview changes?' : 'Proceed to apply changes?',
                    default: true,
                }]);
                if (!proceed) return;
            }

            const codeProvider = router.getProviderForTask('code');
            const healingExecutor = new SelfHealingExecutor(codeProvider, config, history, sessionId, db);

            const healResult = await healingExecutor.executeAndHeal(
                plan.tasks,
                opts.dryRun,
                (label, status, detail) => {
                    const rel = path.relative(rootDir, label);
                    if (status === 'start') {
                        ora(`${opts.dryRun ? 'Previewing' : 'Applying'}: ${rel}`).start();
                    }
                }
            );

            console.log(RichFormatter.formatExecutionTable(healResult.finalResults));
        });
}
