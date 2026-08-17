import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { v4 as uuidv4 } from 'uuid';
import { loadContext } from '../context.js';
import { ProjectScanner } from '../../core/scanner/ProjectScanner.js';
import { TopologicalPlanner } from '../../core/ai/TopologicalPlanner.js';
import { AgentLoop } from '../../core/ai/AgentLoop.js';

const ALLOWED_CHANGE_TYPES = new Set(['modified', 'added', 'deleted']);

export function applyCommand(): Command {
    return new Command('apply')
        .description('Analyze a user-made file change and repair required downstream compatibility through the verified AgentLoop')
        .argument('<file>', 'Repository-relative file that was changed')
        .option('--type <type>', 'Change type: modified | added | deleted', 'modified')
        .option('--dry-run', 'Refresh the graph and show downstream impact without changing other files')
        .option('--no-confirm', 'Skip the execution confirmation prompt')
        .option('--max-steps <n>', 'Maximum autonomous repair steps', '40')
        .action(async (file: string, opts: any) => {
            const changeType = String(opts.type || 'modified').toLowerCase();
            if (!ALLOWED_CHANGE_TYPES.has(changeType)) {
                console.log(chalk.red(`Invalid --type "${opts.type}". Use modified, added, or deleted.`));
                process.exitCode = 1;
                return;
            }

            const ctx = await loadContext();
            if (!ctx) return;
            const { config, graph, db, store, aiProvider } = ctx;
            const absolutePath = path.resolve(config.rootDir, file);
            const relativePath = path.relative(config.rootDir, absolutePath).replace(/\\/g, '/');

            if (relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
                console.log(chalk.red('The target file must be inside the initialized project root.'));
                process.exitCode = 1;
                return;
            }
            if (changeType !== 'deleted' && (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile())) {
                console.log(chalk.red(`Changed file not found: ${relativePath}`));
                process.exitCode = 1;
                return;
            }
            if (changeType === 'deleted' && fs.existsSync(absolutePath)) {
                console.log(chalk.yellow(`--type deleted was specified, but ${relativePath} still exists. Analysis will use the current filesystem state.`));
            }

            console.log(chalk.bold('\nCodebase OS — Downstream Compatibility Analysis'));
            console.log(chalk.gray('─'.repeat(60)));
            console.log(`  File: ${chalk.cyan(relativePath)}`);
            console.log(`  Type: ${chalk.cyan(changeType)}`);

            const scanner = new ProjectScanner(config.rootDir, graph, config, db);
            try {
                await scanner.scanFile(absolutePath);
            } catch (err) {
                console.log(chalk.red(`Graph refresh failed: ${String(err)}`));
                process.exitCode = 1;
                return;
            }

            const planner = new TopologicalPlanner(graph, config.rootDir);
            const report = planner.planFromFiles([absolutePath]);
            const downstream = report.affectedFiles.filter(item =>
                !item.isRoot && item.reason.startsWith('dependent'),
            );

            console.log(`  Downstream candidates: ${chalk.white(String(downstream.length))}`);
            for (const item of downstream.slice(0, 40)) {
                console.log(`    ${chalk.gray('-')} ${chalk.cyan(item.relativePath)} ${chalk.gray(`[${item.layer}] ${item.reason}`)}`);
            }
            if (report.cycles.length > 0) {
                console.log(chalk.red('  Dependency cycles:'));
                report.cycles.forEach(cycle => console.log(chalk.red(`    ${cycle}`)));
            }

            if (opts.dryRun) {
                console.log(chalk.cyan('\nDry run complete. No downstream files were modified.\n'));
                return;
            }
            if (downstream.length === 0) {
                console.log(chalk.green('\nNo graph-derived downstream consumers require an autonomous repair pass.\n'));
                return;
            }

            if (opts.confirm !== false) {
                const { proceed } = await inquirer.prompt([{
                    type: 'confirm',
                    name: 'proceed',
                    message: `Run a verified repair pass over ${downstream.length} downstream candidate(s)?`,
                    default: false,
                }]);
                if (!proceed) {
                    console.log(chalk.yellow('Execution cancelled.'));
                    return;
                }
            }

            const candidateList = downstream.slice(0, 40).map(item => `- ${item.relativePath}: ${item.reason}`).join('\n');
            const task =
                `The user already made a ${changeType} change to ${relativePath}. ` +
                `Treat that user change as authoritative and do not undo it. ` +
                `Inspect the changed file/current repository state and repair ONLY downstream consumers that are actually incompatible. ` +
                `Do not edit an upstream dependency merely because it is graph-connected.\n\n` +
                `GRAPH-DERIVED DOWNSTREAM CANDIDATES:\n${candidateList}\n\n` +
                `For each candidate, verify whether a compatibility change is required before modifying it. ` +
                `Preserve behavior outside this propagation. When implementation is complete, request finish; ` +
                `Codebase OS will run independent repository verification.`;

            const maxSteps = Math.min(100, Math.max(1, Number.parseInt(String(opts.maxSteps), 10) || 40));
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
                ? chalk.green.bold('VERIFIED DOWNSTREAM REPAIR')
                : chalk.yellow.bold('DOWNSTREAM REPAIR INCOMPLETE / NOT VERIFIED'));
            console.log(`  ${result.summary}`);
            if (result.verificationCommands.length > 0) {
                console.log(chalk.gray(`  Verification: ${result.verificationCommands.join(' | ')}`));
            }
            if (!result.success) process.exitCode = 1;
            console.log('');
        });
}
