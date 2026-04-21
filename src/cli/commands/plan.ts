import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import { loadContext } from '../context.js';
import { TopologicalPlanner } from '../../core/ai/TopologicalPlanner.js';
import type { BlastRadiusReport, PlannedFile } from '../../core/ai/TopologicalPlanner.js';

const LAYER_COLOR: Record<string, (s: string) => string> = {
    database:       chalk.yellow,
    backend:        chalk.cyan,
    api:            chalk.blue,
    frontend:       chalk.green,
    config:         chalk.gray,
    infrastructure: chalk.magenta,
};

const COMPLEXITY_COLOR: Record<string, (s: string) => string> = {
    low:    chalk.green,
    medium: chalk.yellow,
    high:   chalk.red,
};

function layerStr(layer: string): string {
    const fn = LAYER_COLOR[layer] ?? chalk.white;
    return fn(`[${layer}]`);
}

function printBlastRadius(report: BlastRadiusReport, rootDir: string): void {
    const sep = chalk.gray('─'.repeat(60));

    console.log('');
    console.log(chalk.bold('Blast Radius Analysis'));
    console.log(sep);

    if (report.totalFiles === 0) {
        console.log(chalk.yellow('  No affected files found in graph.'));
        console.log(chalk.gray('  Run cos scan first to build the relationship graph.'));
        return;
    }

    // Summary line
    const layerParts = Object.entries(report.layerBreakdown)
        .map(([l, n]) => `${n} ${l}`)
        .join(', ');
    const complexityLabel = COMPLEXITY_COLOR[report.estimatedComplexity](report.estimatedComplexity.toUpperCase());
    console.log(`  ${chalk.bold(String(report.totalFiles))} files across ${chalk.white(layerParts)}`);
    console.log(`  Complexity: ${complexityLabel}`);
    console.log('');

    // Execution plan
    console.log(chalk.bold('Topologically Sorted Execution Plan'));
    console.log(chalk.gray('  (leaf dependencies first — root executors last)'));
    console.log(sep);

    const maxFileLen = Math.max(...report.affectedFiles.map(f => f.relativePath.length), 10);

    for (const file of report.affectedFiles) {
        const orderStr = chalk.gray(`[${String(file.executionOrder).padStart(2, ' ')}]`);
        const rootMark = file.isRoot ? chalk.cyan(' *') : '  ';
        const relPadded = file.relativePath.padEnd(Math.min(maxFileLen, 52));
        const layerTag = layerStr(file.layer).padEnd(16);
        const hubs = file.dependentCount >= 5 ? chalk.red(` hub(${file.dependentCount} dependents)`) : '';
        console.log(`  ${orderStr}${rootMark} ${chalk.white(relPadded)} ${layerTag}${hubs}`);
    }

    // Legend
    console.log('');
    console.log(chalk.gray('  * = root file directly involved in task'));

    // Cross-layer warnings
    if (report.crossLayerWarnings.length > 0) {
        console.log('');
        console.log(chalk.bold.yellow('Architecture Warnings'));
        console.log(sep);
        for (const w of report.crossLayerWarnings) {
            console.log(chalk.yellow(`  [!] ${w}`));
        }
    }

    // Cycle detection
    if (report.cycles.length > 0) {
        console.log('');
        console.log(chalk.bold.red('Circular Dependencies Found'));
        console.log(sep);
        for (const c of report.cycles) {
            console.log(chalk.red(`  [cycle] ${c}`));
        }
    } else if (report.totalFiles > 1) {
        console.log('');
        console.log(chalk.green('  No circular dependencies detected.'));
    }
}

export function planCommand(): Command {
    return new Command('plan')
        .description('Compute blast radius and topological execution plan for a task (no changes made)')
        .argument('<task>', 'The task or file to analyze (natural language or file path)')
        .option('--file <path>', 'Compute plan starting from a specific file instead of a task description')
        .option('--depth <n>', 'Max BFS depth for dependency traversal', '4')
        .action(async (task: string, opts: any) => {
            const ctx = await loadContext();
            if (!ctx) return;

            const { config, graph } = ctx;

            if (graph.nodes.size === 0) {
                console.log(chalk.yellow('\n  Graph is empty. Run cos scan first to build the relationship graph.\n'));
                return;
            }

            const spinner = ora('Computing blast radius...').start();
            const planner = new TopologicalPlanner(graph, config.rootDir);

            let report: BlastRadiusReport;
            try {
                if (opts.file) {
                    const absPath = path.isAbsolute(opts.file)
                        ? opts.file
                        : path.resolve(config.rootDir, opts.file);
                    report = planner.planFromFiles([absPath]);
                } else {
                    report = planner.planFromTask(task);
                }
                spinner.stop();
            } catch (err) {
                spinner.fail(`Plan failed: ${String(err)}`);
                return;
            }

            // Header
            console.log('');
            console.log(chalk.bold('Codebase OS — Topological Change Plan'));
            console.log(chalk.gray('─'.repeat(60)));
            console.log(`  Task:  ${chalk.cyan(task)}`);
            console.log(`  Root:  ${chalk.gray(config.rootDir)}`);
            console.log(`  Graph: ${chalk.gray(graph.nodes.size + ' nodes, ' + graph.edges.size + ' edges')}`);

            printBlastRadius(report, config.rootDir);

            // Actionable ending
            console.log('');
            console.log(chalk.gray('─'.repeat(60)));
            if (report.totalFiles > 0) {
                console.log(chalk.bold('  To execute this plan:'));
                console.log(`    ${chalk.cyan(`cos agent "${task}"`)}`);
                console.log('');
                console.log(chalk.gray('  The agent will execute files in the order shown above,'));
                console.log(chalk.gray('  verifying each change before proceeding to the next.'));
            }
            console.log('');
        });
}
