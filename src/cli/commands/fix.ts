import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { loadContext } from '../context.js';
import { ErrorDetector } from '../../core/diagnostics/ErrorDetector.js';
import { AgentLoop } from '../../core/ai/AgentLoop.js';
import { RichFormatter } from '../../core/output/RichFormatter.js';

export function fixCommand(): Command {
    return new Command('fix')
        .description('Detect supported diagnostics and repair them through the transactional, independently verified AgentLoop')
        .argument('[file]', 'Specific repository-relative file to diagnose and repair')
        .option('--all', 'Explicitly diagnose the whole supported project surface')
        .option('--dry-run', 'Run and display diagnostics only; do not modify files')
        .option('--yes', 'Skip the repair confirmation prompt')
        .option('--max-steps <n>', 'Maximum autonomous repair steps', '50')
        .action(async (file: string | undefined, opts: any) => {
            const ctx = await loadContext();
            if (!ctx) return;
            const { config, db, graph, store, aiProvider } = ctx;

            let filePaths: string[] | undefined;
            if (file) {
                const absolute = path.resolve(config.rootDir, file);
                const relative = path.relative(config.rootDir, absolute);
                if (relative.startsWith('..') || path.isAbsolute(relative)) {
                    console.log(chalk.red('The requested file must be inside the initialized project root.'));
                    process.exitCode = 1;
                    return;
                }
                filePaths = [absolute];
            }

            const detector = new ErrorDetector(config.rootDir);
            const spinner = ora('Running supported diagnostics...').start();
            let reports;
            try {
                reports = await detector.runAll(filePaths);
            } catch (err) {
                spinner.fail(`Diagnostics failed: ${String(err)}`);
                process.exitCode = 1;
                return;
            }

            const totalErrors = reports.reduce((sum, report) => sum + report.errors.length, 0);
            const totalWarnings = reports.reduce((sum, report) => sum + report.warnings.length, 0);
            if (totalErrors + totalWarnings === 0) {
                spinner.succeed(chalk.green('No supported diagnostics were reported.'));
                return;
            }
            spinner.succeed(`Found ${totalErrors} error(s) and ${totalWarnings} warning(s).`);

            console.log('');
            console.log(chalk.bold('Diagnostic Report'));
            console.log(RichFormatter.formatDiagnostics(reports, config.rootDir));

            if (opts.dryRun) {
                console.log(chalk.cyan('\nDry run complete. No files were modified.\n'));
                return;
            }

            const diagnostics = [...detector.groupByFile(reports).entries()]
                .map(([diagnosticFile, items]) => {
                    const relative = diagnosticFile
                        ? path.relative(config.rootDir, diagnosticFile).replace(/\\/g, '/')
                        : '(tool-level diagnostic)';
                    const lines = items.slice(0, 40).map(item =>
                        `  - ${item.severity.toUpperCase()} line ${item.line}:${item.column} ` +
                        `[${item.code ?? item.tool}] ${item.message}`,
                    );
                    return `${relative}\n${lines.join('\n')}`;
                })
                .join('\n\n')
                .slice(0, 18000);

            if (!opts.yes) {
                const { proceed } = await inquirer.prompt([{
                    type: 'confirm',
                    name: 'proceed',
                    message: `Run a verified repair pass for these ${totalErrors + totalWarnings} diagnostic(s)?`,
                    default: false,
                }]);
                if (!proceed) {
                    console.log(chalk.yellow('Repair cancelled.'));
                    return;
                }
            }

            const scope = file
                ? `The user explicitly scoped this repair to ${file}. Do not modify unrelated files unless required to preserve compilation/runtime contracts.`
                : 'Repair only files required to resolve the diagnostics. Do not perform opportunistic refactors.';
            const task =
                `Resolve the following diagnostics in the current repository. ${scope}\n\n` +
                `DIAGNOSTICS:\n${diagnostics}\n\n` +
                `Requirements:\n` +
                `- reproduce/inspect the relevant code before modifying it;\n` +
                `- make the smallest semantically correct changes;\n` +
                `- do not add dependencies unless the diagnostics cannot be solved correctly without one;\n` +
                `- do not suppress errors with unsafe casts, ignored checks, disabled lint rules, or test deletion unless the user explicitly requested that behavior;\n` +
                `- when the repair is complete, request finish. Codebase OS will independently run the repository's verification gates.`;

            const maxSteps = Math.min(120, Math.max(1, Number.parseInt(String(opts.maxSteps), 10) || 50));
            const agent = new AgentLoop(aiProvider, config.rootDir, db, uuidv4(), graph, store);
            const result = await agent.run(task, {
                maxSteps,
                onStep: async (step, action, toolResult) => {
                    if (toolResult.isStreaming) {
                        process.stdout.write(chalk.gray(String(toolResult.output || '')));
                        return;
                    }
                    const target = action.args?.path || action.args?.oldPath || action.args?.command || '';
                    console.log(
                        `  ${chalk.gray(`[${step}]`)} ${chalk.cyan(String(action.tool).toUpperCase())} ` +
                        `${chalk.gray(target)} ${toolResult.success ? chalk.green('OK') : chalk.red('FAIL')}`,
                    );
                    if (!toolResult.success && toolResult.error) {
                        console.log(chalk.red(`       ${String(toolResult.error).slice(0, 220)}`));
                    }
                },
            });

            console.log('');
            console.log(result.success
                ? chalk.green.bold('VERIFIED REPAIR COMPLETE')
                : chalk.yellow.bold('REPAIR INCOMPLETE / NOT VERIFIED'));
            console.log(`  ${result.summary}`);
            if (result.verificationCommands.length > 0) {
                console.log(chalk.gray(`  Verification: ${result.verificationCommands.join(' | ')}`));
            }
            if (!result.success) process.exitCode = 1;
            console.log('');
        });
}
