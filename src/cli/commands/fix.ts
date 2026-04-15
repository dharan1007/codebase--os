import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import path from 'path';
import { loadContext } from '../context.js';
import { AIProviderFactory } from '../../core/ai/AIProviderFactory.js';
import { ChangeExecutor } from '../../core/ai/ChangeExecutor.js';
import { ErrorDetector } from '../../core/diagnostics/ErrorDetector.js';
import { PermissionGate } from '../../core/permissions/PermissionGate.js';
import type { AITask } from '../../types/index.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';
import { RichFormatter } from '../../core/output/RichFormatter.js';

export function fixCommand(): Command {
    return new Command('fix')
        .description('Detect and AI-fix errors across your project')
        .argument('[file]', 'Specific file to fix (optional)')
        .option('--all', 'Scan and fix all files in the project')
        .option('--dry-run', 'Show what would be fixed without applying changes')
        .option('--yes', 'Auto-approve all permission requests')
        .option('--no-verify', 'Skip re-running diagnostics after fixes are applied')
        .action(async (file: string | undefined, opts: any) => {
            const ctx = await loadContext();
            if (!ctx) return;

            const { config, history, sessionId } = ctx;

            let provider;
            try {
                provider = AIProviderFactory.create(config);
            } catch (err) {
                console.log(chalk.red(`AI provider error: ${String(err)}`));
                process.exit(1);
            }

            const detector = new ErrorDetector(config.rootDir);
            const gate = new PermissionGate({
                autoApprove: opts.yes as boolean,
                logFile: `${config.dataDir ?? '.cos'}/permissions.log`,
            });

            // Step 1 — Run diagnostics
            const spinnerScan = ora('Running diagnostics...').start();
            let reports;
            try {
                const filePaths = file ? [path.resolve(process.cwd(), file)] : undefined;
                reports = await detector.runAll(filePaths);
                const totalErrors = reports.reduce((s, r) => s + r.errors.length, 0);
                const totalWarnings = reports.reduce((s, r) => s + r.warnings.length, 0);
                if (totalErrors + totalWarnings === 0) {
                    spinnerScan.succeed(chalk.green('No errors detected. Project looks clean.'));
                    return;
                }
                spinnerScan.succeed(`Found ${chalk.red(String(totalErrors))} error(s) and ${chalk.yellow(String(totalWarnings))} warning(s)`);
            } catch (err) {
                spinnerScan.fail(`Diagnostics failed: ${String(err)}`);
                return;
            }

            // Step 2 — Display errors
            console.log('');
            console.log(chalk.bold('Diagnostic Report:'));
            console.log(RichFormatter.formatDiagnostics(reports, config.rootDir));

            // Step 3 — Request permission
            const byFile = detector.groupByFile(reports);
            const affectedFiles = Array.from(byFile.keys()).map(f => path.relative(config.rootDir, f));
            const allowed = await gate.requestPermission({
                action: 'AI Auto-Fix',
                description: `Use AI to fix errors in ${byFile.size} file(s)`,
                affectedFiles,
                riskLevel: byFile.size > 5 ? 'medium' : 'low',
                isDestructive: false,
                canUndo: true,
            });

            if (!allowed) {
                console.log(chalk.yellow('\nFix cancelled.'));
                return;
            }

            // Step 4 — Build and execute AI tasks
            const executor = new ChangeExecutor(provider, config, history, sessionId);
            const results = [];

            for (const [filePath, diags] of byFile) {
                const rel = path.relative(config.rootDir, filePath);
                const errorSummary = diags
                    .filter(d => d.severity === 'error')
                    .map(d => `Line ${d.line}: [${d.code ?? d.tool}] ${d.message}`)
                    .join('\n');

                if (!errorSummary) continue;

                const task: AITask = {
                    id: uuidv4(),
                    kind: 'fix',
                    description: `Fix ${diags.filter(d => d.severity === 'error').length} error(s) in this file`,
                    targetFile: filePath,
                    context: `The following errors were detected by static analysis:\n${errorSummary}`,
                    constraints: [
                        'Fix ONLY the listed errors — do not change unrelated code',
                        'Maintain existing code style, imports, and structure',
                        'Do not add new dependencies',
                        'Ensure the file remains syntactically valid after the fix',
                    ],
                    expectedOutput: 'The same file with all listed errors resolved',
                    priority: 10,
                };

                const spinner = ora(`Fixing: ${rel}`).start();
                try {
                    const result = await executor.execute(task, opts.dryRun as boolean ?? false);
                    results.push({ result, filePath });

                    if (!result.success) {
                        spinner.fail(`Failed: ${result.validationErrors.slice(0, 1).join(', ')}`);
                    } else if (result.confidence < 0.5) {
                        spinner.warn(`Applied with low confidence (${(result.confidence * 100).toFixed(0)}%) — review manually`);
                    } else {
                        spinner.succeed(`Fixed — ${(result.confidence * 100).toFixed(0)}% confidence`);
                    }

                    if (result.success && opts.dryRun && result.diff) {
                        console.log(RichFormatter.formatDiff(result.diff));
                    }
                } catch (err) {
                    spinner.fail(`Error: ${String(err)}`);
                    logger.error('fix task failed', { file: filePath, error: String(err) });
                }
            }

            // Step 5 — Summary
            const applied = results.filter(r => r.result.success && r.result.appliedAt);
            const failed = results.filter(r => !r.result.success);

            console.log('');
            console.log(chalk.bold('Fix Summary:'));
            console.log(`  ${chalk.green(String(applied.length))} file(s) fixed   ${chalk.red(String(failed.length))} failed`);
            if (opts.dryRun) {
                console.log(chalk.cyan('  Note: Dry run — no physical changes were made.'));
                return;
            }

            // Step 6 — Re-verify (optional)
            if (!opts.noVerify && applied.length > 0) {
                console.log('');
                const recheck = ora('Re-running diagnostics to verify fixes...').start();
                try {
                    const fixedFiles = applied.map(r => r.filePath);
                    const recheckReports = await detector.runAll(fixedFiles);
                    const remaining = recheckReports.reduce((s, r) => s + r.errors.length, 0);
                    if (remaining === 0) {
                        recheck.succeed(chalk.green('All errors resolved!'));
                    } else {
                        recheck.warn(`${remaining} error(s) remain. Run 'cos fix' again or fix manually.`);
                    }
                } catch (err) {
                    recheck.fail(`Re-verification failed: ${String(err)}`);
                }
            }
        });
}
