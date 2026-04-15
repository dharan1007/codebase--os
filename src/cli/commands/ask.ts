import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import path from 'path';
import fs from 'fs';
import { loadContext } from '../context.js';
import { AIProviderFactory } from '../../core/ai/AIProviderFactory.js';
import { ModelRouter } from '../../core/ai/ModelRouter.js';
import { ConversationalPlanner } from '../../core/ai/ConversationalPlanner.js';
import { SelfHealingExecutor } from '../../core/ai/SelfHealingExecutor.js';
import { GitManager } from '../../core/git/GitManager.js';
import { logger } from '../../utils/logger.js';
import { RichFormatter } from '../../core/output/RichFormatter.js';

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
                    message: 'What would you like to change or build?',
                    validate: (val) => val.trim().length > 0 || 'Please provide a description.',
                }]);
                actualRequest = input;
            } else {
                actualRequest = request;
            }

            const ctx = await loadContext();
            if (!ctx) return;

            const { config, history, sessionId } = ctx;

            let router;
            let provider;
            try {
                router = new ModelRouter(config);
                provider = AIProviderFactory.create(config);
            } catch (err) {
                console.log(chalk.red(`AI provider error: ${String(err)}`));
                process.exit(1);
            }

            console.log(chalk.bold('\nCodebase OS — AI Assistant'));
            console.log(chalk.gray('─'.repeat(40)));
            console.log(`  Request: ${chalk.cyan(actualRequest)}`);
            if (opts.file) console.log(`  Scope:   ${chalk.gray(opts.file)}`);
            console.log('');

            // Step 1 — Plan using the fast planning model
            const spinnerPlan = ora('Analyzing request and building plan...').start();
            const planningProvider = router.getProviderForTask('planning');
            const planner = new ConversationalPlanner(planningProvider, ctx.graph);

            let plan;
            try {
                plan = await planner.plan(
                    opts.file ? `${actualRequest} (focus on file: ${opts.file})` : actualRequest,
                    config.rootDir,
                    opts.file ? opts.file : undefined
                );
                spinnerPlan.succeed(`Plan ready — ${plan.tasks.length} tasks, estimated effort: ${chalk.yellow(plan.estimatedEffort)}`);
            } catch (err) {
                spinnerPlan.fail(`Planning failed: ${String(err)}`);
                return;
            }

            if (plan.tasks.length === 0) {
                console.log(chalk.yellow('\nAI could not determine what changes to make for this request.'));
                return;
            }

            // Step 2 — Show plan to user
            console.log('');
            console.log(chalk.bold(`Assistant: ${plan.summary}`));
            console.log(RichFormatter.formatAITasks(plan.tasks));

            // Step 3 — Confirm
            if (!opts.yes) {
                const { proceed } = await inquirer.prompt([{
                    type: 'confirm',
                    name: 'proceed',
                    message: opts.dryRun
                        ? `Proceed to preview ${plan.tasks.length} change(s)?`
                        : `Proceed to apply ${plan.tasks.length} change(s)?`,
                    default: true,
                }]);
                if (!proceed) {
                    console.log(chalk.yellow('Cancelled.'));
                    return;
                }
            }

            // Step 4 — Execute with self-healing, using the powerful code model
            const codeProvider = router.getProviderForTask('code');
            const healingExecutor = new SelfHealingExecutor(codeProvider, config, history, sessionId, ctx.db);

            // Pre-create any new files the plan needs
            for (const task of plan.tasks) {
                if (!fs.existsSync(task.targetFile)) {
                    const dir = path.dirname(task.targetFile);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(task.targetFile, '', 'utf8');
                }
            }

            const spinners = new Map<string, ReturnType<typeof ora>>();

            const healResult = await healingExecutor.executeAndHeal(
                plan.tasks,
                opts.dryRun as boolean ?? false,
                (label, status, detail) => {
                    const rel = path.relative(config.rootDir, label);
                    if (status === 'start') {
                        const sp = ora(`${opts.dryRun ? 'Previewing' : 'Applying'}: ${rel}`).start();
                        spinners.set(label, sp);
                    } else if (status === 'done') {
                        spinners.get(label)?.succeed(`Applied — ${detail ?? 'done'}`);
                        spinners.delete(label);
                    } else {
                        spinners.get(label)?.fail(`Failed: ${detail ?? 'error'}`);
                        spinners.delete(label);
                    }
                }
            );

            const results = healResult.finalResults;

            // Show diff previews
            if (opts.dryRun) {
                for (const r of results.filter(r => r.diff)) {
                    console.log(RichFormatter.formatDiff(r.diff));
                }
            }

            // Step 5 — Summary
            console.log(RichFormatter.formatExecutionTable(results));
            const appliedCount = results.filter(r => r.success && r.appliedAt).length;

            if (!opts.dryRun) {
                if (healResult.healed) {
                    console.log(`  ${chalk.cyan('Self-healed')} compile errors automatically.`);
                } else if (healResult.remainingErrors > 0) {
                    console.log(`  ${chalk.yellow(`${healResult.remainingErrors} errors remain`)} — run 'cos fix' to fix manually.`);
                } else {
                    console.log(`  ${chalk.green('✓ All changes compile cleanly.')}`);
                }
            }
            if (opts.dryRun) console.log(chalk.cyan('\n  Note: Dry run — no physical changes were made.'));

            // Step 6 — Auto-commit
            if (opts.autoCommit && !opts.dryRun && appliedCount > 0) {
                const gitManager = new GitManager(config.rootDir);
                if (gitManager.isGitRepo()) {
                    gitManager.add([]);
                    const commitMsg = `feat: ${plan.summary}`;
                    if (gitManager.commit(commitMsg)) {
                        console.log(chalk.green(`  Auto-committed: "${commitMsg}"`));
                    }
                }
            }
            console.log('');
        });
}
