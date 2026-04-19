import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import path from 'path';
import { loadContext } from '../context.js';
import { AIProviderFactory } from '../../core/ai/AIProviderFactory.js';
import { ChangeExecutor } from '../../core/ai/ChangeExecutor.js';
import { ErrorDetector } from '../../core/diagnostics/ErrorDetector.js';
import { DecisionEngine } from '../../core/ai/DecisionEngine.js';
import type { AITask } from '../../types/index.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';
import { RichFormatter } from '../../core/output/RichFormatter.js';
import { StaticPatternLibrary } from '../../core/diagnostics/StaticPatternLibrary.js';
import { FailureManager } from '../../core/diagnostics/FailureManager.js';
import { FailureStore } from '../../core/failure/FailureStore.js';
import { TestRunner } from '../../core/diagnostics/TestRunner.js';

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

            const { config, history, sessionId, graph, db } = ctx;

            let provider;
            try {
                provider = AIProviderFactory.create(config);
            } catch (err) {
                console.log(chalk.red(`AI provider error: ${String(err)}`));
                process.exit(1);
            }

            const detector = new ErrorDetector(config.rootDir);
            const decisionEngine = new DecisionEngine(graph);

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

            const byFile = detector.groupByFile(reports);

            // Step 3 — Build and execute fixing pipeline
            const executor = new ChangeExecutor(provider, config, history, sessionId);
            const patternLibrary = new StaticPatternLibrary(config.rootDir);
            const failureStore = new FailureStore(db);
            const failureManager = new FailureManager(db, history, failureStore);
            const testRunner = new TestRunner(config.rootDir, graph);
            failureManager.init();

            const concurrency = 3; // Lower concurrency for stability
            const results: any[] = [];
            const entries = Array.from(byFile.entries());

            // Process files in batches to respect concurrency
            for (let i = 0; i < entries.length; i += concurrency) {
                const chunk = entries.slice(i, i + concurrency);
                await Promise.all(chunk.map(async ([filePath, diags]) => {
                    const rel = path.relative(config.rootDir, filePath);
                    const errorSummary = diags
                        .filter(d => d.severity === 'error')
                        .map(d => `Line ${d.line}: [${d.code ?? d.tool}] ${d.message}`)
                        .join('\n');

                    if (!errorSummary) return;

                    const spinner = ora(`Processing: ${rel}`).start();
                    
                    try {
                        // Stage 1: Static Pattern Fixes
                        let fixedByPattern = false;
                        if (!opts.dryRun) {
                            for (const diag of diags) {
                                if (await patternLibrary.applyFix(diag)) {
                                    fixedByPattern = true;
                                }
                            }
                        }

                        if (fixedByPattern) {
                            spinner.text = `Applied static fixes: ${rel}`;
                        }

                        // Stage 2: AI Fixes
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

                        const result = await executor.execute(task, opts.dryRun as boolean ?? false);

                        if (!result.success) {
                            spinner.fail(`AI Fix Failed: ${rel}`);
                            await failureManager.handleFailure('parse_error', filePath, result.validationErrors.join('\n'));
                            results.push({ result, filePath });
                            return;
                        }

                        spinner.stop();

                        const diffLines = result.diff.split('\n').length;
                        const evaluation = decisionEngine.evaluate('write_file', filePath, diffLines, result.confidence);
                        const allowed = await decisionEngine.enforce('AI Auto-Fix', filePath, evaluation);

                        if (allowed && !opts.dryRun) {
                            executor.apply(task, result);
                            
                            // Stage 3: Semantic Validation & Partial Tests
                            const reVerify = await detector.runAll([filePath]);
                            const newErrors = reVerify.reduce((acc, r) => acc + r.errors.length, 0);
                            
                            if (newErrors > 0) {
                                await failureManager.handleFailure('parse_error', filePath, `Found ${newErrors} regressions after fix.`);
                                result.success = false;
                            } else {
                                // Run impacted tests
                                const testResults = await testRunner.runImpactedTests(filePath);
                                const failures = testResults.filter(t => !t.success);
                                
                                if (failures.length > 0) {
                                    const details = failures.map(f => `${f.testFile}: ${f.output}`).join('\n');
                                    await failureManager.handleFailure('test_regression', filePath, details);
                                    result.success = false;
                                } else {
                                    console.log(chalk.green(`  ✔ Fixed ${rel} — Verification passed`));
                                }
                            }
                        } else if (!allowed) {
                            console.log(chalk.yellow(`  Skipped: ${rel}`));
                            result.success = false;
                        }

                        results.push({ result, filePath });
                    } catch (err) {
                        spinner.fail(`Error: ${rel} - ${String(err)}`);
                        logger.error('fix task failed', { file: filePath, error: String(err) });
                    }
                }));
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
                const recheck = ora('Re-running global verification...').start();
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

